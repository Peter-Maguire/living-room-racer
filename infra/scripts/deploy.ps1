# Package and deploy the CloudFormation stacks for an environment.
#
# Usage:
#   .\deploy.ps1 -EnvName dev [-GameServerImageUri <ecrUri>] [-ChangeSet]
#                [-SkipFleetRoll] [-ForceFleetRoll]
#
#   -EnvName             dev | staging | prod
#   -GameServerImageUri  ECR image URI for the game server container. If omitted,
#                        the value from params/<env>.json is used. Empty means the
#                        GameLift + matchmaking stacks are skipped.
#   -ChangeSet           Create and show a change set WITHOUT executing it, so you
#                        can preview adds/replaces/deletes before applying (use
#                        this for changes touching data/identity stacks).
#   -SkipFleetRoll       Don't roll the GameLift fleet to the new container
#                        version after the stack update (see below).
#   -ForceFleetRoll      Roll the fleet even if it is already on the latest version.
#
# After the stack update the fleet is rolled to the latest container group
# definition version and the deployment is awaited. CloudFormation creates the
# new version but does NOT move the fleet onto it, so without this step a
# deploy leaves the previous game server running. (Standalone: roll-fleet.ps1.)
#
# This runs the SAME templates locally and in CI; only params differ per env.
[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)][string]$EnvName,
    [string]$GameServerImageUri = '',
    [switch]$ChangeSet,
    [switch]$SkipFleetRoll,
    [switch]$ForceFleetRoll
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\lib.ps1"

Assert-EnvArg $EnvName
Assert-Tools

$bucket = Get-ArtifactBucket $EnvName
$stack = Get-StackName $EnvName
$paramsFile = Join-Path $script:InfraDir "params\$EnvName.json"
$packaged = Join-Path $script:InfraDir 'templates\root.packaged.yaml'

# pnpm/esbuild/aws write progress to stderr. Under $ErrorActionPreference='Stop'
# (PowerShell 5.1) that becomes a terminating error even on success, so relax it
# around native calls and gate on $LASTEXITCODE / file checks instead.
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'

Write-Host '==> Building Lambda bundles (packages/api -> build/)'
# The API handlers are bundled with esbuild into self-contained .mjs files.
# This is required: pnpm's symlinked node_modules does not survive the plain
# directory zip that `aws cloudformation package` performs, so an unbundled
# upload fails at import time with "Cannot find module '@smithy/core'".
Push-Location $script:RepoRoot
try {
    pnpm --filter '@racer/shared' build 2>&1 | ForEach-Object { Write-Host "    $_" }
    pnpm --filter '@racer/api' build 2>&1 | ForEach-Object { Write-Host "    $_" }
} finally {
    Pop-Location
}
$apiBuild = Join-Path $script:RepoRoot 'packages\api\build'
if (-not (Test-Path (Join-Path $apiBuild 'matchmaking.mjs'))) {
    $ErrorActionPreference = $prevEap
    throw "Lambda bundle missing at $apiBuild. API build failed; aborting deploy."
}

Write-Host "==> Packaging nested templates + code to s3://$bucket"
aws cloudformation package `
    --template-file (Join-Path $script:InfraDir 'templates\root.yaml') `
    --s3-bucket $bucket `
    --output-template-file $packaged 2>&1 | ForEach-Object { Write-Host "    $_" }
if (-not (Test-Path $packaged)) {
    $ErrorActionPreference = $prevEap
    throw 'cloudformation package failed; no packaged template produced.'
}

# Build parameter overrides from the params file; -GameServerImageUri wins.
$params = Get-Content $paramsFile -Raw | ConvertFrom-Json
if ($GameServerImageUri) {
    $params.GameServerImageUri = $GameServerImageUri
} elseif (-not $params.GameServerImageUri) {
    # An empty image URI makes CloudFormation DELETE the GameLift + matchmaking
    # stacks. Reuse whatever image the deployed stack is already running so a
    # plain redeploy (e.g. a web or API change) can't tear the fleet down.
    $current = (aws cloudformation describe-stacks --stack-name $stack `
        --query "Stacks[0].Parameters[?ParameterKey=='GameServerImageUri'].ParameterValue | [0]" `
        --output text 2>$null)
    if ($LASTEXITCODE -eq 0 -and $current -and $current -ne 'None') {
        Write-Host "==> Reusing deployed game server image: $current"
        $params.GameServerImageUri = $current.Trim()
    }
}
# CloudFormation rejects bare `Key=` for empty values, so quote empties.
$overrides = $params.PSObject.Properties | ForEach-Object {
    $v = [string]$_.Value
    if ([string]::IsNullOrEmpty($v)) { "$($_.Name)=`"`"" } else { "$($_.Name)=$v" }
}

# CAPABILITY_NAMED_IAM is needed because the GameLift fleet role has a RoleName.
$deployArgs = @(
    'cloudformation', 'deploy',
    '--template-file', $packaged,
    '--stack-name', $stack,
    '--capabilities', 'CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND',
    '--parameter-overrides'
) + $overrides + @('--no-fail-on-empty-changeset')

if ($ChangeSet) {
    Write-Host '==> Creating change set (NOT executing). Review before applying.'
    aws @deployArgs --no-execute-changeset 2>&1 | ForEach-Object { Write-Host "    $_" }
    $ErrorActionPreference = $prevEap
} else {
    Write-Host "==> Deploying stack $stack"
    aws @deployArgs 2>&1 | ForEach-Object { Write-Host "    $_" }
    $deployExit = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    if ($deployExit -ne 0) { throw "cloudformation deploy failed (exit $deployExit)." }
    Write-Host '==> Done. Writing outputs...'
    & (Join-Path $PSScriptRoot 'outputs.ps1') -EnvName $EnvName

    # Move the fleet onto the container version the stack just created.
    if ($SkipFleetRoll) {
        Write-Host '==> Skipping fleet roll (-SkipFleetRoll). Run roll-fleet.ps1 when ready.'
    } else {
        Invoke-FleetRoll -StackName $stack -Force:$ForceFleetRoll
    }
}
