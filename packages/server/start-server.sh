#!/bin/sh
# Launcher for the Node game server under the Amazon GameLift Servers wrapper.
#
# The wrapper runs this script (relative to /local/game) and appends the
# GameLift-assigned port as `--port <n>`. We just forward all arguments to Node;
# packages/server/src/config.ts parses --port.
set -e
exec node server/dist/index.js "$@"
