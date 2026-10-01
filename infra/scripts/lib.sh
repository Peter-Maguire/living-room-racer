#!/usr/bin/env bash
# Shared helpers for the infra scripts. Sourced by the other scripts.
set -euo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${INFRA_DIR}/.." && pwd)"

# Naming: the root stack per environment.
stack_name() { echo "racer-$1"; }

# The artifact bucket that holds packaged templates + Lambda code.
artifact_bucket() {
  local env="$1"
  local account
  account="$(aws sts get-caller-identity --query Account --output text)"
  echo "racer-${env}-artifacts-${account}"
}

require_tools() {
  for tool in aws sam; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      echo "ERROR: '$tool' is not installed or not on PATH." >&2
      exit 1
    fi
  done
}

# For scripts that only call the AWS CLI (no SAM needed).
require_aws() {
  if ! command -v aws >/dev/null 2>&1; then
    echo "ERROR: 'aws' is not installed or not on PATH." >&2
    exit 1
  fi
}

require_env_arg() {
  if [[ -z "${1:-}" ]]; then
    echo "ERROR: environment required (dev|staging|prod)." >&2
    exit 1
  fi
  case "$1" in
    dev|staging|prod) ;;
    *) echo "ERROR: unknown environment '$1'." >&2; exit 1 ;;
  esac
}

region() { aws configure get region || echo "us-east-1"; }

# --- GameLift fleet rollout ---------------------------------------------------
#
# Updating the stack with a new game server image creates a NEW container group
# definition version, but the fleet keeps running the version it was on until it
# is told to move: CloudFormation does not do that for us (the template only
# references the definition by name, which doesn't change). So after a deploy we
# roll the fleet to the latest version ourselves and wait for it to finish.

# Run an aws command, retrying a couple of times: a brief network blip should not
# abort (or, worse, mislead) a deploy. Returns non-zero only after the last
# attempt, so under `set -e` a failed lookup can never look like an empty result.
aws_retry() {
  local attempt=1 max=3
  until aws "$@"; do
    if (( attempt >= max )); then
      echo "ERROR: aws $1 $2 failed after ${max} attempts." >&2
      return 1
    fi
    echo "    (aws $1 $2 failed, attempt ${attempt} of ${max}; retrying)" >&2
    attempt=$(( attempt + 1 ))
    sleep 3
  done
}

# Print "<fleetId> <groupName>" for an environment, or nothing when it was
# deployed without a game server image (no GameLiftStack resource). Any other
# failure returns non-zero.
fleet_info() {
  local stack="$1" nested fleet name
  if ! nested="$(aws cloudformation describe-stack-resources --stack-name "$stack" \
      --logical-resource-id GameLiftStack --query 'StackResources[0].PhysicalResourceId' \
      --output text 2>/dev/null)"; then
    # "Resource GameLiftStack does not exist" is the legitimate no-fleet case, but
    # only if the root stack itself exists; otherwise surface the error.
    aws_retry cloudformation describe-stacks --stack-name "$stack" \
      --query 'Stacks[0].StackStatus' --output text >/dev/null
    return 0
  fi
  [[ -z "$nested" || "$nested" == "None" ]] && return 0
  fleet="$(aws_retry cloudformation describe-stacks --stack-name "$nested" \
    --query "Stacks[0].Outputs[?OutputKey=='FleetId'].OutputValue" --output text)"
  name="$(aws_retry cloudformation describe-stacks --stack-name "$nested" \
    --query "Stacks[0].Outputs[?OutputKey=='ContainerGroupDefinitionName'].OutputValue" --output text)"
  if [[ -z "$fleet" || "$fleet" == "None" || -z "$name" || "$name" == "None" ]]; then
    echo "ERROR: GameLift stack ${nested} has no FleetId / ContainerGroupDefinitionName output." >&2
    return 1
  fi
  echo "$fleet $name"
}

# Move the fleet to the latest container group definition version and wait for
# the deployment to complete. A no-op if it is already on the latest version
# (unless force=true). Returns non-zero if anything fails.
#   roll_fleet <stack> [force=false] [timeoutMinutes=20]
roll_fleet() {
  local stack="$1" force="${2:-false}" timeout_min="${3:-20}"
  local info fleet name arn current latest players before after depid status last="" deadline

  info="$(fleet_info "$stack")"
  if [[ -z "$info" ]]; then
    echo "==> No GameLift fleet in this environment (deployed without a game server image); nothing to roll."
    return 0
  fi
  read -r fleet name <<<"$info"

  arn="$(aws_retry gamelift describe-container-fleet --fleet-id "$fleet" \
    --query 'ContainerFleet.GameServerContainerGroupDefinitionArn' --output text)"
  # The ARN ends in :<version>. Refuse to act on anything we can't parse.
  current="${arn##*:}"
  if [[ ! "$current" =~ ^[0-9]+$ ]]; then
    echo "ERROR: could not read the fleet's container version from '${arn}'." >&2
    return 1
  fi
  latest="$(aws_retry gamelift list-container-group-definition-versions --name "$name" \
    --query "max(ContainerGroupDefinitions[?Status=='READY'].VersionNumber)" --output text)"
  if [[ ! "$latest" =~ ^[0-9]+$ ]]; then
    echo "ERROR: no READY container group definition versions found for ${name}." >&2
    return 1
  fi

  if [[ "$current" == "$latest" && "$force" != true ]]; then
    echo "==> Fleet ${fleet} is already on the latest container version (v${latest}); nothing to roll."
    return 0
  fi

  players="$(aws_retry gamelift describe-game-sessions --fleet-id "$fleet" --status-filter ACTIVE \
    --query 'sum(GameSessions[].CurrentPlayerSessionCount)' --output text)"
  if [[ "$players" =~ ^[0-9]+$ && "$players" -gt 0 ]]; then
    echo "    NOTE: ${players} player(s) are connected to this fleet. The rollout replaces game server containers."
  fi

  before="$(aws_retry gamelift list-fleet-deployments --fleet-id "$fleet" \
    --query 'sort_by(FleetDeployments,&CreationTime)[-1].DeploymentId' --output text)"
  [[ "$before" == "None" ]] && before=""

  if [[ "$current" == "$latest" ]]; then
    echo "==> Re-rolling fleet ${fleet} on v${latest} (forced)"
  else
    echo "==> Rolling fleet ${fleet} from container version v${current} to v${latest}"
  fi
  aws_retry gamelift update-container-fleet --fleet-id "$fleet" \
    --game-server-container-group-definition-name "$name" >/dev/null

  # Wait for the NEW deployment (not the previous one) to reach a final state.
  # GameLift starts a deployment within seconds when the container version
  # changed. If none appears it never will (it only deploys on a change), so
  # don't sit out the whole timeout waiting for one.
  deadline=$(( $(date +%s) + timeout_min * 60 ))
  local start_grace=$(( $(date +%s) + 90 )) seen=false
  while (( $(date +%s) < deadline )); do
    after="$(aws_retry gamelift list-fleet-deployments --fleet-id "$fleet" \
      --query 'sort_by(FleetDeployments,&CreationTime)[-1].[DeploymentId,DeploymentStatus]' --output text)"
    read -r depid status <<<"$after"
    if [[ "$seen" == false && ( -z "${depid:-}" || "$depid" == "None" || "$depid" == "$before" ) \
          && $(date +%s) -gt $start_grace ]]; then
      if [[ "$force" == true && "$current" == "$latest" ]]; then
        echo "==> GameLift started no deployment: it only deploys when the container version changes, and the fleet is already on v${latest}. Nothing to do."
        return 0
      fi
      echo "ERROR: GameLift accepted the update but started no deployment within 90 seconds. Check the fleet in the GameLift console." >&2
      return 1
    fi
    if [[ -n "${depid:-}" && "$depid" != "None" && "$depid" != "$before" ]]; then
      seen=true
      if [[ "$status" != "$last" ]]; then
        echo "    $(date +%H:%M:%S)  deployment ${status}"
        last="$status"
      fi
      case "$status" in
        COMPLETE) echo "==> Fleet is running container version v${latest}."; return 0 ;;
        IMPAIRED|ROLLBACK_IN_PROGRESS|ROLLBACK_COMPLETE|ROLLBACK_FAILED|CANCELLED)
          echo "ERROR: fleet deployment ended as ${status}. Check the GameLift console / describe-fleet-deployment." >&2
          return 1 ;;
      esac
    fi
    sleep 10
  done
  echo "ERROR: timed out after ${timeout_min} minutes waiting for the fleet deployment (last status: ${last})." >&2
  return 1
}
