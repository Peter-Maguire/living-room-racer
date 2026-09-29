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
