#!/usr/bin/env bash
# Package and deploy the CloudFormation stacks for an environment.
#
# Usage:
#   deploy.sh <env> [--image-uri <ecrUri>] [--changeset]
#                   [--skip-fleet-roll] [--force-fleet-roll]
#
#   <env>               dev | staging | prod
#   --image-uri         ECR image URI for the game server container. If omitted,
#                       the value from params/<env>.json is used; if that is empty
#                       too, the image the stack is already running is reused (so a
#                       plain redeploy can't tear the GameLift fleet down).
#   --changeset         Create and show a change set WITHOUT executing it, so you
#                       can preview adds/replaces/deletes before applying (use this
#                       for changes touching the stateful data/identity stacks).
#   --skip-fleet-roll   Don't roll the GameLift fleet to the new container version
#                       after the stack update (see below).
#   --force-fleet-roll  Roll the fleet even if it is already on the latest version.
#
# After the stack update the fleet is rolled to the latest container group
# definition version and the deployment is awaited. CloudFormation creates the new
# version but does NOT move the fleet onto it, so without this step a deploy leaves
# the previous game server running. (Standalone: roll-fleet.sh.)
#
# This runs the SAME templates locally and in CI; only params differ per env.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ENV="${1:-}"
require_env_arg "$ENV"
shift || true

IMAGE_URI=""
CHANGESET=false
SKIP_ROLL=false
FORCE_ROLL=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --image-uri) IMAGE_URI="$2"; shift 2 ;;
    --changeset) CHANGESET=true; shift ;;
    --skip-fleet-roll) SKIP_ROLL=true; shift ;;
    --force-fleet-roll) FORCE_ROLL=true; shift ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

require_tools

BUCKET="$(artifact_bucket "$ENV")"
STACK="$(stack_name "$ENV")"
PARAMS_FILE="${INFRA_DIR}/params/${ENV}.json"
PACKAGED="${INFRA_DIR}/templates/root.packaged.yaml"

echo "==> Building Lambda bundles (packages/api -> build/)"
# The API handlers are bundled with esbuild into self-contained .mjs files.
# Required because pnpm's symlinked node_modules does not survive the plain
# directory zip that `aws cloudformation package` performs.
( cd "${REPO_ROOT}" && pnpm --filter @racer/shared build && pnpm --filter @racer/api build )
if [[ ! -f "${REPO_ROOT}/packages/api/build/matchmaking.mjs" ]]; then
  echo "ERROR: Lambda bundle missing; API build failed." >&2
  exit 1
fi

echo "==> Packaging nested templates + code to s3://${BUCKET}"
aws cloudformation package \
  --template-file "${INFRA_DIR}/templates/root.yaml" \
  --s3-bucket "${BUCKET}" \
  --output-template-file "${PACKAGED}"

# --image-uri wins over the params file. An empty image URI makes CloudFormation
# DELETE the GameLift + matchmaking stacks, so when neither is given, reuse the
# image the deployed stack is already running.
if [[ -z "${IMAGE_URI}" ]]; then
  IMAGE_URI="$(node -e 'console.log(require(process.argv[1]).GameServerImageUri || "")' "${PARAMS_FILE}")"
fi
if [[ -z "${IMAGE_URI}" ]]; then
  CURRENT="$(aws cloudformation describe-stacks --stack-name "${STACK}" \
    --query "Stacks[0].Parameters[?ParameterKey=='GameServerImageUri'].ParameterValue | [0]" \
    --output text 2>/dev/null || true)"
  if [[ -n "${CURRENT}" && "${CURRENT}" != "None" ]]; then
    echo "==> Reusing deployed game server image: ${CURRENT}"
    IMAGE_URI="${CURRENT}"
  fi
fi

# Parameter overrides from the params file, one KEY=VALUE per line. CloudFormation
# rejects a bare `Key=` for empty values, so empties are written as Key="".
mapfile -t PARAM_OVERRIDES < <(node -e '
  const p = require(process.argv[1]);
  if (process.argv[2]) p.GameServerImageUri = process.argv[2];
  for (const [k, v] of Object.entries(p)) {
    const s = String(v);
    console.log(s === "" ? `${k}=""` : `${k}=${s}`);
  }
' "${PARAMS_FILE}" "${IMAGE_URI}")

# CAPABILITY_NAMED_IAM is needed because the GameLift fleet role has a RoleName.
DEPLOY_ARGS=(
  --template-file "${PACKAGED}"
  --stack-name "${STACK}"
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND
  --parameter-overrides "${PARAM_OVERRIDES[@]}"
  --no-fail-on-empty-changeset
)

if [[ "${CHANGESET}" == true ]]; then
  echo "==> Creating change set (NOT executing). Review before applying."
  aws cloudformation deploy "${DEPLOY_ARGS[@]}" --no-execute-changeset
else
  echo "==> Deploying stack ${STACK}"
  aws cloudformation deploy "${DEPLOY_ARGS[@]}"
  echo "==> Done. Writing outputs..."
  "${INFRA_DIR}/scripts/outputs.sh" "${ENV}"

  # Move the fleet onto the container version the stack just created.
  if [[ "${SKIP_ROLL}" == true ]]; then
    echo "==> Skipping fleet roll (--skip-fleet-roll). Run roll-fleet.sh when ready."
  else
    roll_fleet "${STACK}" "${FORCE_ROLL}"
  fi
fi
