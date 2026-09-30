#!/usr/bin/env bash
# Package and deploy the CloudFormation stacks for an environment.
#
# Usage:
#   deploy.sh <env> [--build-id <gameLiftBuildId>] [--changeset]
#
#   <env>            dev | staging | prod
#   --build-id       GameLift build id to pass to the gamelift stack. If omitted,
#                    the value from params/<env>.json is used.
#   --changeset      Create and show a change set WITHOUT executing it, so you can
#                    preview adds/replaces/deletes before applying (use this for
#                    changes touching the stateful data/identity stacks).
#
# This runs the SAME templates locally and in CI; only params differ per env.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ENV="${1:-}"
require_env_arg "$ENV"
shift || true

BUILD_ID=""
CHANGESET=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --build-id) BUILD_ID="$2"; shift 2 ;;
    --changeset) CHANGESET=true; shift ;;
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

# Build parameter overrides from the params file, allowing --build-id to win.
PARAM_OVERRIDES="$(node -e '
  const p = require(process.argv[1]);
  const build = process.argv[2];
  if (build) p.GameLiftBuildId = build;
  console.log(Object.entries(p).map(([k, v]) => `${k}=${v}`).join(" "));
' "${PARAMS_FILE}" "${BUILD_ID}")"

DEPLOY_ARGS=(
  --template-file "${PACKAGED}"
  --stack-name "${STACK}"
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND
  --parameter-overrides ${PARAM_OVERRIDES}
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
fi
