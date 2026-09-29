#!/usr/bin/env bash
# Build the three.js client and publish it to the web S3 bucket, then invalidate
# CloudFront. This is CONTENT, not infrastructure - no stack update happens here.
#
# Usage: publish-client.sh <env>
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ENV="${1:-}"
require_env_arg "$ENV"
STACK="$(stack_name "$ENV")"

get() {
  aws cloudformation describe-stacks --stack-name "${STACK}" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

BUCKET="$(get WebBucketName)"
DIST_ID="$(get WebDistributionId)"

echo "==> Building client"
( cd "${REPO_ROOT}" && pnpm --filter @racer/shared build && pnpm --filter @racer/client build )

echo "==> Syncing to s3://${BUCKET}"
aws s3 sync "${REPO_ROOT}/packages/client/dist" "s3://${BUCKET}" --delete

echo "==> Invalidating CloudFront ${DIST_ID}"
aws cloudfront create-invalidation --distribution-id "${DIST_ID}" --paths '/*' >/dev/null

echo "==> Published client for env=${ENV}"
