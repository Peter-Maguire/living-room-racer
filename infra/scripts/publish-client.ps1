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

Write-Host '==> Building client'
Push-Location $script:RepoRoot
try {
    pnpm --filter '@racer/shared' build
    pnpm --filter '@racer/client' build
} finally {
    Pop-Location
}

Write-Host "==> Syncing to s3://$bucket"
aws s3 sync (Join-Path $script:RepoRoot 'packages\client\dist') "s3://$bucket" --delete

Write-Host "==> Invalidating CloudFront $distId"
aws cloudfront create-invalidation --distribution-id $distId --paths '/*' *> $null

Write-Host "==> Published client for env=$EnvName"
