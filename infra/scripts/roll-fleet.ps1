# Roll the GameLift fleet onto the latest game server container version and wait
# for the deployment to finish.
#
# deploy.ps1 does this automatically after a stack update; use this on its own to
# re-roll without a stack deploy (e.g. after publishing a new image and updating
# the stack with -SkipFleetRoll, or to recover a fleet left on an old version).
#
# Usage: .\roll-fleet.ps1 -EnvName dev [-Force] [-TimeoutMinutes 20]
#
#   -Force            Roll even if the fleet is already on the latest version.
#   -TimeoutMinutes   How long to wait for the deployment (default 20).
[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)][string]$EnvName,
    [switch]$Force,
    [int]$TimeoutMinutes = 20
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\lib.ps1"

Assert-EnvArg $EnvName
Assert-Aws

Invoke-FleetRoll -StackName (Get-StackName $EnvName) -Force:$Force -TimeoutMinutes $TimeoutMinutes
