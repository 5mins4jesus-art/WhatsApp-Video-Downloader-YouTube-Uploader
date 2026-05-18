#!/bin/bash

set -euo pipefail

WORKSPACE="$HOME/workspace"
cd "$WORKSPACE"

exec node "$WORKSPACE/main_pipeline.mjs" "$@"
