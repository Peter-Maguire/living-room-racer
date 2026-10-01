# Shared helpers for the infra scripts. Dot-source with: . "$PSScriptRoot\lib.ps1"
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:InfraDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script:RepoRoot = (Resolve-Path (Join-Path $script:InfraDir '..')).Path

# Naming: the root stack per environment.
function Get-StackName {
    param([Parameter(Mandatory)][string]$EnvName)
    "racer-$EnvName"
}

# The artifact bucket that holds packaged templates + Lambda code.
function Get-ArtifactBucket {
    param([Parameter(Mandatory)][string]$EnvName)
    $account = (aws sts get-caller-identity --query Account --output text).Trim()
    "racer-$EnvName-artifacts-$account"
}

function Assert-Tools {
    foreach ($tool in @('aws', 'sam')) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
            throw "'$tool' is not installed or not on PATH."
        }
    }
}

# For scripts that only call the AWS CLI (no SAM needed).
function Assert-Aws {
    if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
        throw "'aws' is not installed or not on PATH."
    }
}

function Assert-EnvArg {
    param([string]$EnvName)
    if ([string]::IsNullOrWhiteSpace($EnvName)) {
        throw 'environment required (dev|staging|prod).'
    }
    if ($EnvName -notin @('dev', 'staging', 'prod')) {
        throw "unknown environment '$EnvName'."
    }
}

function Get-AwsRegion {
    $region = aws configure get region 2>$null
    if ([string]::IsNullOrWhiteSpace($region)) { 'us-east-1' } else { $region.Trim() }
}

# Read a single output value from the deployed root stack.
function Get-StackOutput {
    param(
        [Parameter(Mandatory)][string]$StackName,
        [Parameter(Mandatory)][string]$Key
    )
    (aws cloudformation describe-stacks --stack-name $StackName `
        --query "Stacks[0].Outputs[?OutputKey=='$Key'].OutputValue" `
        --output text).Trim()
}

# --- GameLift fleet rollout ---------------------------------------------------
#
# Updating the stack with a new game server image creates a NEW container group
# definition version, but the fleet keeps running the version it was on until it
# is told to move: CloudFormation does not do that for us (the template only
# references the definition by name, which doesn't change). So after a deploy we
# roll the fleet to the latest version ourselves and wait for it to finish.

# Run an aws command and return its stdout. THROWS if it fails, so a failed
# lookup can never be mistaken for an empty result. Retries a couple of times,
# because a brief network blip should not abort (or, worse, mislead) a deploy.
function Invoke-Aws {
    param(
        [Parameter(Mandatory)][string[]]$Arguments,
        [int]$Attempts = 3
    )
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        for ($i = 1; $i -le $Attempts; $i++) {
            $out = & aws @Arguments
            if ($LASTEXITCODE -eq 0) { return (($out | ForEach-Object { "$_" }) -join "`n").Trim() }
            if ($i -lt $Attempts) {
                Write-Host "    (aws $($Arguments[0..1] -join ' ') failed, attempt $i of $Attempts; retrying)"
                Start-Sleep -Seconds 3
            }
        }
        throw "aws $($Arguments -join ' ') failed (exit $LASTEXITCODE)."
    } finally {
        $ErrorActionPreference = $prev
    }
}

# The fleet and container group definition name for an environment, from the
# nested GameLift stack. $null when the env was deployed without a game server
# image (no GameLiftStack resource). Any other failure throws.
function Get-FleetInfo {
    param([Parameter(Mandatory)][string]$StackName)
    $nested = $null
    try {
        $nested = Invoke-Aws -Attempts 1 -Arguments @('cloudformation', 'describe-stack-resources',
            '--stack-name', $StackName, '--logical-resource-id', 'GameLiftStack',
            '--query', 'StackResources[0].PhysicalResourceId', '--output', 'text')
    } catch {
        # "Resource GameLiftStack does not exist" is the legitimate no-fleet case,
        # but only if the root stack itself exists; otherwise surface the error.
        Invoke-Aws -Arguments @('cloudformation', 'describe-stacks', '--stack-name', $StackName,
            '--query', 'Stacks[0].StackStatus', '--output', 'text') | Out-Null
        return $null
    }
    if ([string]::IsNullOrWhiteSpace($nested) -or $nested -eq 'None') { return $null }
    $outs = Invoke-Aws -Arguments @('cloudformation', 'describe-stacks', '--stack-name', $nested,
        '--query', 'Stacks[0].Outputs', '--output', 'json') | ConvertFrom-Json
    $fleet = ($outs | Where-Object OutputKey -eq 'FleetId').OutputValue
    $name = ($outs | Where-Object OutputKey -eq 'ContainerGroupDefinitionName').OutputValue
    if (-not $fleet -or -not $name) { throw "GameLift stack $nested has no FleetId / ContainerGroupDefinitionName output." }
    [pscustomobject]@{ FleetId = $fleet; GroupName = $name }
}

# The most recent fleet deployment (by creation time), or $null if there is none.
function Get-NewestDeployment {
    param([Parameter(Mandatory)][string]$FleetId)
    $json = Invoke-Aws -Arguments @('gamelift', 'list-fleet-deployments', '--fleet-id', $FleetId, '--output', 'json')
    $list = @(($json | ConvertFrom-Json).FleetDeployments)
    $list | Sort-Object CreationTime -Descending | Select-Object -First 1
}

# Move the fleet to the latest container group definition version and wait for
# the deployment to complete. A no-op if it is already on the latest version
# (unless -Force). Throws if anything fails, so callers exit non-zero.
function Invoke-FleetRoll {
    param(
        [Parameter(Mandatory)][string]$StackName,
        [switch]$Force,
        [int]$TimeoutMinutes = 20
    )
    $info = Get-FleetInfo -StackName $StackName
    if (-not $info) {
        Write-Host '==> No GameLift fleet in this environment (deployed without a game server image); nothing to roll.'
        return
    }

    $fleetArn = Invoke-Aws -Arguments @('gamelift', 'describe-container-fleet', '--fleet-id', $info.FleetId,
        '--query', 'ContainerFleet.GameServerContainerGroupDefinitionArn', '--output', 'text')
    # The ARN ends in :<version>. Refuse to act on anything we can't parse.
    if ($fleetArn -notmatch ':(\d+)$') { throw "Could not read the fleet's container version from '$fleetArn'." }
    $current = [int]$Matches[1]

    $versions = (Invoke-Aws -Arguments @('gamelift', 'list-container-group-definition-versions',
        '--name', $info.GroupName, '--output', 'json') | ConvertFrom-Json).ContainerGroupDefinitions |
        Where-Object Status -eq 'READY'
    $latest = [int](($versions | Measure-Object -Property VersionNumber -Maximum).Maximum)
    if ($latest -lt 1) { throw "No READY container group definition versions found for $($info.GroupName)." }

    if ($current -eq $latest -and -not $Force) {
        Write-Host "==> Fleet $($info.FleetId) is already on the latest container version (v$latest); nothing to roll."
        return
    }

    $players = Invoke-Aws -Arguments @('gamelift', 'describe-game-sessions', '--fleet-id', $info.FleetId,
        '--status-filter', 'ACTIVE', '--query', 'sum(GameSessions[].CurrentPlayerSessionCount)', '--output', 'text')
    if ($players -match '^\d+$' -and [int]$players -gt 0) {
        Write-Host "    NOTE: $players player(s) are connected to this fleet. The rollout replaces game server containers."
    }

    $before = Get-NewestDeployment -FleetId $info.FleetId
    $beforeId = if ($before) { $before.DeploymentId } else { '' }

    if ($current -eq $latest) {
        Write-Host "==> Re-rolling fleet $($info.FleetId) on v$latest (forced)"
    } else {
        Write-Host "==> Rolling fleet $($info.FleetId) from container version v$current to v$latest"
    }
    Invoke-Aws -Arguments @('gamelift', 'update-container-fleet', '--fleet-id', $info.FleetId,
        '--game-server-container-group-definition-name', $info.GroupName, '--output', 'text') | Out-Null

    # Wait for the NEW deployment (not the previous one) to reach a final state.
    # GameLift starts a deployment within seconds when the container version
    # changed. If none appears it never will (it only deploys on a change), so
    # don't sit out the whole timeout waiting for one.
    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    $startGrace = (Get-Date).AddSeconds(90)
    $seen = $false
    $last = ''
    while ((Get-Date) -lt $deadline) {
        $d = Get-NewestDeployment -FleetId $info.FleetId
        if (-not $seen -and -not ($d -and $d.DeploymentId -ne $beforeId) -and (Get-Date) -gt $startGrace) {
            if ($Force -and $current -eq $latest) {
                Write-Host "==> GameLift started no deployment: it only deploys when the container version changes, and the fleet is already on v$latest. Nothing to do."
                return
            }
            throw 'GameLift accepted the update but started no deployment within 90 seconds. Check the fleet in the GameLift console.'
        }
        if ($d -and $d.DeploymentId -ne $beforeId) {
            $seen = $true
            if ($d.DeploymentStatus -ne $last) {
                Write-Host ("    {0}  deployment {1}" -f (Get-Date -Format HH:mm:ss), $d.DeploymentStatus)
                $last = $d.DeploymentStatus
            }
            if ($d.DeploymentStatus -eq 'COMPLETE') {
                Write-Host "==> Fleet is running container version v$latest."
                return
            }
            if ($d.DeploymentStatus -in 'IMPAIRED', 'ROLLBACK_IN_PROGRESS', 'ROLLBACK_COMPLETE', 'ROLLBACK_FAILED', 'CANCELLED') {
                throw "Fleet deployment ended as $($d.DeploymentStatus). Check the GameLift console / describe-fleet-deployment for the cause."
            }
        }
        Start-Sleep -Seconds 10
    }
    throw "Timed out after $TimeoutMinutes minutes waiting for the fleet deployment (last status: $last)."
}
