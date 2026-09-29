# Delete an environment's stacks. Retained resources (DynamoDB tables, Cognito
# pools, S3 buckets) SURVIVE by DeletionPolicy: Retain and are only removed
# explicitly with -PurgeRetained.
#
# Usage: .\teardown.ps1 -EnvName dev [-PurgeRetained]
[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)][string]$EnvName,
    [switch]$PurgeRetained
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\lib.ps1"

Assert-EnvArg $EnvName
$stack = Get-StackName $EnvName

Write-Host "This will delete stack '$stack' (nested stacks included)."
Write-Host 'Retained data (tables, user pool, buckets) will be kept unless -PurgeRetained.'
$confirm = Read-Host "Type the environment name '$EnvName' to confirm"
if ($confirm -ne $EnvName) {
    Write-Host 'Aborted.'
    exit 1
}

Write-Host "==> Deleting stack $stack"
aws cloudformation delete-stack --stack-name $stack
aws cloudformation wait stack-delete-complete --stack-name $stack
Write-Host '    deleted'

if ($PurgeRetained) {
    Write-Host '==> -PurgeRetained set: this step is intentionally left manual.'
    Write-Host '    Review and delete retained tables/pools/buckets explicitly to avoid'
    Write-Host "    accidental data loss. Retained resource names are prefixed 'racer-$EnvName-'."
}

Write-Host "==> Teardown complete for env=$EnvName"
