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

echo "==> [3/6] Building + pushing the game server container image to ECR"
# The image bundles the official GameLift game server wrapper (see
# packages/server/Dockerfile). If this fails we still deploy everything else;
# the GameLift + matchmaking stacks are simply skipped.
IMAGE_URI="$("${INFRA_DIR}/scripts/publish-server.sh" "${ENV}" | tail -n 1 || true)"
if [[ ! "${IMAGE_URI}" =~ \.dkr\.ecr\..*amazonaws\.com/ ]]; then
  IMAGE_URI=""
  echo "    NOTE: no game server image was published."
  echo "    Deploying WITHOUT the GameLift + matchmaking stacks (everything else"
  echo "    still deploys). Add hosted servers later with:"
  echo "      publish-server.sh <env>"
  echo "      deploy.sh <env> --image-uri <uri>"
else
  echo "    image: ${IMAGE_URI}"
fi

echo "==> [4/6] Deploying stacks"
DEPLOY_ARGS=()
[[ -n "${IMAGE_URI}" ]] && DEPLOY_ARGS+=(--image-uri "${IMAGE_URI}")
"${INFRA_DIR}/scripts/deploy.sh" "${ENV}" ${DEPLOY_ARGS[@]+"${DEPLOY_ARGS[@]}"}

echo "==> [5/6] Outputs written to package .env files"

echo "==> [6/6] Publishing client bundle"
"${INFRA_DIR}/scripts/publish-client.sh" "${ENV}" || \
  echo "    (skipped; run publish-client.sh manually once ready)"

echo "==> Bootstrap complete for env=${ENV}"
