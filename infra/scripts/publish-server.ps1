# Build the game server container image and push it to ECR, then print the
# image URI to stdout (the last line) for use as -GameServerImageUri.
#
# The image bundles the official Amazon GameLift Servers game server wrapper,
# which owns the GameLift lifecycle and launches our Node server as a child
# process (AWS publishes no Node.js server SDK).
#
# Usage: .\publish-server.ps1 -EnvName dev [-Tag <tag>]
[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)][string]$EnvName,
    [string]$Tag = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\lib.ps1"

Assert-EnvArg $EnvName
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'docker is required to build the game server image.'
}

$region = Get-AwsRegion
$account = (aws sts get-caller-identity --query Account --output text).Trim()
$repo = "racer-$EnvName-server"
$registry = "$account.dkr.ecr.$region.amazonaws.com"
if (-not $Tag) { $Tag = Get-Date -Format 'yyyyMMdd-HHmmss' }
$imageUri = "$registry/${repo}:$Tag"

Write-Host "==> Ensuring ECR repository $repo"
$exists = $true
try { aws ecr describe-repositories --repository-names $repo *> $null } catch { $exists = $false }
if (-not $exists) {
    aws ecr create-repository --repository-name $repo `
        --image-scanning-configuration scanOnPush=true *> $null
    Write-Host '    created'
} else {
    Write-Host '    exists'
}

# docker and aws write progress to stderr. Under $ErrorActionPreference='Stop'
# (PowerShell 5.1) that becomes a terminating error even on success, so relax it
# around native calls and gate on $LASTEXITCODE instead.
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    Write-Host '==> Logging docker in to ECR'
    # Pipe through cmd.exe: PowerShell 5.1 re-encodes/wraps piped native output
    # (stderr ErrorRecords, CRLF, BOM), which corrupts the token and makes ECR
    # answer "400 Bad Request". cmd passes the raw bytes through.
    cmd /c "aws ecr get-login-password --region $region | docker login --username AWS --password-stdin $registry" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'docker login to ECR failed' }

    Write-Host "==> Building image $imageUri"
    # GameLift container fleets run linux/amd64.
    Push-Location $script:RepoRoot
    try {
        docker build --platform linux/amd64 -f packages/server/Dockerfile -t $imageUri . 2>&1 |
            ForEach-Object { Write-Host "    $_" }
        if ($LASTEXITCODE -ne 0) { throw 'docker build failed' }
    } finally {
        Pop-Location
    }

    Write-Host '==> Pushing image'
    docker push $imageUri 2>&1 | ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -ne 0) { throw 'docker push failed' }
} finally {
    $ErrorActionPreference = $prevEap
}

Write-Host "==> Published $imageUri"
# Last line: the image URI, so callers can capture it.
Write-Output $imageUri
