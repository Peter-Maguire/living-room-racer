# From-scratch bootstrap: take a brand-new account/region to a working env with
# one command. Idempotent - safe to re-run.
#
# Usage: .\bootstrap.ps1 -EnvName dev
#
# Steps: preflight -> artifact bucket -> build+upload game server -> deploy
# stacks -> write outputs -> publish client.
[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)][string]$EnvName
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\lib.ps1"

Assert-EnvArg $EnvName
Assert-Tools

$region = Get-AwsRegion
$bucket = Get-ArtifactBucket $EnvName

Write-Host '==> [1/6] Preflight'
aws sts get-caller-identity *> $null
Write-Host "    account OK, region=$region, env=$EnvName"

Write-Host "==> [2/6] Ensuring artifact bucket s3://$bucket"
$exists = $true
try { aws s3api head-bucket --bucket $bucket *> $null } catch { $exists = $false }
if (-not $exists) {
    if ($region -eq 'us-east-1') {
        aws s3api create-bucket --bucket $bucket *> $null
    } else {
        aws s3api create-bucket --bucket $bucket `
            --create-bucket-configuration "LocationConstraint=$region" *> $null
    }
    aws s3api put-bucket-versioning --bucket $bucket `
        --versioning-configuration Status=Enabled
    Write-Host '    created'
} else {
    Write-Host '    exists'
}

Write-Host '==> [3/6] Building and uploading the game server as a GameLift build'
# Build the server (and shared dep) so the uploaded build is runnable.
Push-Location $script:RepoRoot
try {
    pnpm --filter '@racer/shared' build
    pnpm --filter '@racer/server' build
} finally {
    Pop-Location
}

$buildVersion = Get-Date -Format 'yyyyMMdd-HHmmss'
$buildId = ''
try {
    $buildId = (aws gamelift upload-build `
        --operating-system AMAZON_LINUX_2 `
        --build-root (Join-Path $script:RepoRoot 'packages\server') `
        --name "racer-$EnvName-server" `
        --build-version $buildVersion `
        --query 'Build.BuildId' --output text 2>$null).Trim()
} catch {
    $buildId = ''
}
if ([string]::IsNullOrWhiteSpace($buildId)) {
    Write-Host '    WARNING: upload-build failed or GameLift not available; using placeholder.'
    $buildId = 'REPLACE_WITH_BUILD_ID'
} else {
    Write-Host "    build id: $buildId"
}

Write-Host '==> [4/6] Deploying stacks'
& (Join-Path $PSScriptRoot 'deploy.ps1') -EnvName $EnvName -BuildId $buildId

Write-Host '==> [5/6] Outputs written to package .env files'

Write-Host '==> [6/6] Publishing client bundle'
try {
    & (Join-Path $PSScriptRoot 'publish-client.ps1') -EnvName $EnvName
} catch {
    Write-Host '    (skipped; run publish-client.ps1 manually once ready)'
}

Write-Host "==> Bootstrap complete for env=$EnvName"
