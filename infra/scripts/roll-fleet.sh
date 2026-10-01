#!/usr/bin/env bash
# Roll the GameLift fleet onto the latest game server container version and wait
# for the deployment to finish.
#
# deploy.sh does this automatically after a stack update; use this on its own to
# re-roll without a stack deploy (e.g. after updating the stack with
# --skip-fleet-roll, or to recover a fleet left on an old version).
#
# Usage: roll-fleet.sh <env> [--force] [--timeout-minutes 20]
#
#   --force             Roll even if the fleet is already on the latest version.
#   --timeout-minutes   How long to wait for the deployment (default 20).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ENV="${1:-}"
require_env_arg "$ENV"
shift || true

FORCE=false
TIMEOUT=20
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=true; shift ;;
    --timeout-minutes) TIMEOUT="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

require_aws
roll_fleet "$(stack_name "$ENV")" "${FORCE}" "${TIMEOUT}"
