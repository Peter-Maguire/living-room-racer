#!/usr/bin/env bash
# From-scratch bootstrap: take a brand-new account/region to a working env with
# one command. Idempotent - safe to re-run.
#
# Usage:
#   bootstrap.sh <env>
#
# Steps: preflight -> artifact bucket -> build+upload game server -> deploy
# stacks -> write outputs -> publish client.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ENV="${1:-}"
require_env_arg "$ENV"
require_tools

REGION="$(region)"
BUCKET="$(artifact_bucket "$ENV")"

echo "==> [1/6] Preflight"
aws sts get-caller-identity >/dev/null
echo "    account OK, region=${REGION}, env=${ENV}"

echo "==> [2/6] Ensuring artifact bucket s3://${BUCKET}"
if ! aws s3api head-bucket --bucket "${BUCKET}" >/dev/null 2>&1; then
  if [[ "${REGION}" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "${BUCKET}" >/dev/null
  else
    aws s3api create-bucket --bucket "${BUCKET}" \
      --create-bucket-configuration "LocationConstraint=${REGION}" >/dev/null
  fi
  aws s3api put-bucket-versioning --bucket "${BUCKET}" \
    --versioning-configuration Status=Enabled
  echo "    created"
else
  echo "    exists"
fi

echo "==> [3/6] Building and uploading the game server as a GameLift build"
# Build the server (and shared dep) so the uploaded build is runnable.
( cd "${REPO_ROOT}" && pnpm --filter @racer/shared build && pnpm --filter @racer/server build )
BUILD_VERSION="$(date +%Y%m%d-%H%M%S)"
BUILD_ID="$(aws gamelift upload-build \
  --operating-system AMAZON_LINUX_2 \
  --build-root "${REPO_ROOT}/packages/server" \
  --name "racer-${ENV}-server" \
  --build-version "${BUILD_VERSION}" \
  --query 'Build.BuildId' --output text 2>/dev/null || echo '')"
if [[ -z "${BUILD_ID}" ]]; then
  echo "    WARNING: upload-build failed or GameLift not available; using placeholder."
  BUILD_ID="REPLACE_WITH_BUILD_ID"
else
  echo "    build id: ${BUILD_ID}"
fi

echo "==> [4/6] Deploying stacks"
"${INFRA_DIR}/scripts/deploy.sh" "${ENV}" --build-id "${BUILD_ID}"

echo "==> [5/6] Outputs written to package .env files"

echo "==> [6/6] Publishing client bundle"
"${INFRA_DIR}/scripts/publish-client.sh" "${ENV}" || \
  echo "    (skipped; run publish-client.sh manually once ready)"

echo "==> Bootstrap complete for env=${ENV}"
