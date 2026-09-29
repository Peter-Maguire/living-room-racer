# Package and deploy the CloudFormation stacks for an environment.
#
# Usage:
#   .\deploy.ps1 -EnvName dev [-BuildId <gameLiftBuildId>] [-ChangeSet]
#
#   -EnvName    dev | staging | prod
#   -BuildId    GameLift build id to pass to the gamelift stack. If omitted,
#               the value from params/<env>.json is used.
#   -ChangeSet  Create and show a change set WITHOUT executing it, so you can
#               preview adds/replaces/deletes before applying (use this for
#               changes touching the stateful data/identity stacks).
#
# This runs the SAME templates locally and in CI; only params differ per env.
[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)][string]$EnvName,
    [string]$BuildId = '',
    [switch]$ChangeSet
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

Write-Host '==> Building SAM (Lambda) assets'
try {
    sam build --template (Join-Path $script:InfraDir 'templates\api.yaml') *> $null
} catch {
    Write-Host '   (skipping sam build: packages/api not built yet)'
}

Write-Host "==> Packaging nested templates + code to s3://$bucket"
aws cloudformation package `
    --template-file (Join-Path $script:InfraDir 'templates\root.yaml') `
    --s3-bucket $bucket `
    --output-template-file $packaged

# Build parameter overrides from the params file, allowing -BuildId to win.
$params = Get-Content $paramsFile -Raw | ConvertFrom-Json
if ($BuildId) { $params.GameLiftBuildId = $BuildId }
$overrides = $params.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }

$deployArgs = @(
    'cloudformation', 'deploy',
    '--template-file', $packaged,
    '--stack-name', $stack,
    '--capabilities', 'CAPABILITY_IAM', 'CAPABILITY_AUTO_EXPAND',
    '--parameter-overrides'
) + $overrides + @('--no-fail-on-empty-changeset')

if ($ChangeSet) {
    Write-Host '==> Creating change set (NOT executing). Review before applying.'
    aws @deployArgs --no-execute-changeset
} else {
    Write-Host "==> Deploying stack $stack"
    aws @deployArgs
    Write-Host '==> Done. Writing outputs...'
    & (Join-Path $PSScriptRoot 'outputs.ps1') -EnvName $EnvName
}
