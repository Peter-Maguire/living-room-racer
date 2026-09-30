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

Write-Host '==> [3/6] Building + pushing the game server container image to ECR'
# The image bundles the official GameLift game server wrapper (see
# packages/server/Dockerfile). If this fails we still deploy everything else;
# the GameLift + matchmaking stacks are simply skipped.
$imageUri = ''
try {
    $out = & (Join-Path $PSScriptRoot 'publish-server.ps1') -EnvName $EnvName
    # publish-server.ps1 prints the image URI as its final line.
    $imageUri = ($out | Where-Object { $_ -match '\.dkr\.ecr\..*amazonaws\.com/' } | Select-Object -Last 1)
    if ($imageUri) { $imageUri = ([string]$imageUri).Trim() }
} catch {
    Write-Host "    image publish failed: $($_.Exception.Message)"
    $imageUri = ''
}
if ([string]::IsNullOrWhiteSpace($imageUri)) {
    Write-Host '    NOTE: no game server image was published.'
    Write-Host '    Deploying WITHOUT the GameLift + matchmaking stacks (everything'
    Write-Host '    else still deploys). Add hosted servers later with:'
    Write-Host '      publish-server.ps1 -EnvName <env>'
    Write-Host '      deploy.ps1 -EnvName <env> -GameServerImageUri <uri>'
} else {
    Write-Host "    image: $imageUri"
}

Write-Host '==> [4/6] Deploying stacks'
& (Join-Path $PSScriptRoot 'deploy.ps1') -EnvName $EnvName -GameServerImageUri $imageUri

Write-Host '==> [5/6] Outputs written to package .env files'

Write-Host '==> [6/6] Publishing client bundle'
try {
    & (Join-Path $PSScriptRoot 'publish-client.ps1') -EnvName $EnvName
} catch {
    Write-Host '    (skipped; run publish-client.ps1 manually once ready)'
}

Write-Host "==> Bootstrap complete for env=$EnvName"
