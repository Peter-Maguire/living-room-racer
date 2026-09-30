# Build the three.js client and publish it to the web S3 bucket, then invalidate
# CloudFront. This is CONTENT, not infrastructure - no stack update happens here.
#
# Usage: .\publish-client.ps1 -EnvName dev
[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)][string]$EnvName
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\lib.ps1"

Assert-EnvArg $EnvName
$stack = Get-StackName $EnvName

$bucket = Get-StackOutput -StackName $stack -Key 'WebBucketName'
$distId = Get-StackOutput -StackName $stack -Key 'WebDistributionId'

# pnpm/vite/aws write progress to stderr. Under $ErrorActionPreference='Stop'
# (PowerShell 5.1) that becomes a terminating error even on success, which would
# silently abort the publish after building. Relax it and gate on $LASTEXITCODE.
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    Write-Host '==> Building client'
    Push-Location $script:RepoRoot
    try {
        pnpm --filter '@racer/shared' build 2>&1 | ForEach-Object { Write-Host "    $_" }
        pnpm --filter '@racer/client' build 2>&1 | ForEach-Object { Write-Host "    $_" }
    } finally {
        Pop-Location
    }
    $distDir = Join-Path $script:RepoRoot 'packages\client\dist'
    if (-not (Test-Path (Join-Path $distDir 'index.html'))) {
        throw "client build produced no dist at $distDir"
    }

    Write-Host "==> Syncing to s3://$bucket"
    aws s3 sync $distDir "s3://$bucket" --delete 2>&1 | ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -ne 0) { throw "s3 sync failed (exit $LASTEXITCODE)" }

    Write-Host "==> Invalidating CloudFront $distId"
    aws cloudfront create-invalidation --distribution-id $distId --paths '/*' 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "cloudfront invalidation failed (exit $LASTEXITCODE)" }
} finally {
    $ErrorActionPreference = $prevEap
}

Write-Host "==> Published client for env=$EnvName"
