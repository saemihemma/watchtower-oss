#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

if [ ! -d "$REPO_ROOT/node_modules" ]; then
  echo "Dependencies not found in $REPO_ROOT. Run 'npm install' first." >&2
  exit 1
fi

if [ -z "${WATCHTOWER_DATA_ROOT:-}" ]; then
  WATCHTOWER_DATA_ROOT="$REPO_ROOT/watchtower-data"
  export WATCHTOWER_DATA_ROOT
fi

WATCHTOWER_CALLER_CWD=$(pwd)
export WATCHTOWER_CALLER_CWD

COMMAND="${1:-profiles}"
if [ "$#" -gt 0 ]; then
  shift
fi

cd "$REPO_ROOT"
exec npm run watchtower -- "$COMMAND" "$@"
