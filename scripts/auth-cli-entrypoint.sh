#!/bin/sh
set -eu

mkdir -p "$HOME/.claude" "$HOME/.claude2" "$CODEX_HOME"

printf '%s\n' \
  'Usage Auth CLI is ready.' \
  'Open the Dokploy terminal and run:' \
  '  usage-auth status' \
  '  usage-auth claude' \
  '  usage-auth claude2' \
  '  usage-auth codex'

exec "$@"
