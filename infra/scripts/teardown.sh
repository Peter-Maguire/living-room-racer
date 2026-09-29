#!/usr/bin/env bash
# Delete an environment's stacks. Retained resources (DynamoDB tables, Cognito
# pools, S3 buckets) SURVIVE by DeletionPolicy: Retain and are only removed
# explicitly with --purge-retained.
#
# Usage:
#   teardown.sh <env> [--purge-retained]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ENV="${1:-}"
require_env_arg "$ENV"
shift || true

PURGE=false
[[ "${1:-}" == "--purge-retained" ]] && PURGE=true

STACK="$(stack_name "$ENV")"

echo "This will delete stack '${STACK}' (nested stacks included)."
echo "Retained data (tables, user pool, buckets) will be kept unless --purge-retained."
read -r -p "Type the environment name '${ENV}' to confirm: " CONFIRM
if [[ "${CONFIRM}" != "${ENV}" ]]; then
  echo "Aborted."
  exit 1
fi

echo "==> Deleting stack ${STACK}"
aws cloudformation delete-stack --stack-name "${STACK}"
aws cloudformation wait stack-delete-complete --stack-name "${STACK}"
echo "    deleted"

if [[ "${PURGE}" == true ]]; then
  echo "==> --purge-retained set: this step is intentionally left manual."
  echo "    Review and delete retained tables/pools/buckets explicitly to avoid"
  echo "    accidental data loss. Retained resource names are prefixed 'racer-${ENV}-'."
fi

echo "==> Teardown complete for env=${ENV}"
