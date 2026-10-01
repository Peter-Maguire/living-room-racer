#!/usr/bin/env bash
# Build the game server container image and push it to ECR, then print the image
# URI as the LAST line of stdout (for use as `deploy.sh --image-uri`).
#
# The image bundles the official Amazon GameLift Servers game server wrapper,
# which owns the GameLift lifecycle and launches our Node server as a child
# process (AWS publishes no Node.js server SDK). Equivalent to publish-server.ps1.
#
# Usage: publish-server.sh <env> [tag]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ENV="${1:-}"
require_env_arg "$ENV"
TAG="${2:-$(date +%Y%m%d-%H%M%S)}"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker is required to build the game server image." >&2
  exit 1
fi

REGION="$(region)"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
REPO="racer-${ENV}-server"
REGISTRY="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
IMAGE_URI="${REGISTRY}/${REPO}:${TAG}"

# Progress goes to stderr so stdout carries only the final image URI.
{
  echo "==> Ensuring ECR repository ${REPO}"
  if aws ecr describe-repositories --repository-names "${REPO}" >/dev/null 2>&1; then
    echo "    exists"
  else
    aws ecr create-repository --repository-name "${REPO}" \
      --image-scanning-configuration scanOnPush=true >/dev/null
    echo "    created"
  fi

  echo "==> Logging docker in to ECR"
  aws ecr get-login-password --region "${REGION}" |
    docker login --username AWS --password-stdin "${REGISTRY}" >/dev/null

  echo "==> Building image ${IMAGE_URI}"
  # GameLift container fleets run linux/amd64.
  ( cd "${REPO_ROOT}" && docker build --platform linux/amd64 -f packages/server/Dockerfile -t "${IMAGE_URI}" . )

  echo "==> Pushing image"
  docker push "${IMAGE_URI}"

  echo "==> Published ${IMAGE_URI}"
} >&2

# Last line of stdout: the image URI, so callers can capture it.
echo "${IMAGE_URI}"
