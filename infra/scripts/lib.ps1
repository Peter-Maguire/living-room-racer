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
