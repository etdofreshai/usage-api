#!/bin/sh
set -eu

usage() {
  cat <<'EOF'
Usage: usage-auth <status|claude|claude2|codex>

  status   Show authentication status without printing tokens
  claude   Renew the primary Claude subscription login
  claude2  Renew the second Claude subscription login
  codex    Renew Codex using the headless device-code flow
EOF
}

case "${1:-}" in
  status)
    printf '%s\n' 'Claude:'
    claude auth status --text || true
    printf '\n%s\n' 'Claude #2:'
    CLAUDE_CONFIG_DIR="$HOME/.claude2" claude auth status --text || true
    printf '\n%s\n' 'Codex:'
    codex login status || true
    ;;
  claude)
    exec claude auth login --claudeai
    ;;
  claude2)
    export CLAUDE_CONFIG_DIR="$HOME/.claude2"
    exec claude auth login --claudeai
    ;;
  codex)
    exec codex login --device-auth
    ;;
  -h|--help|help|'')
    usage
    ;;
  *)
    printf 'Unknown command: %s\n\n' "$1" >&2
    usage >&2
    exit 2
    ;;
esac
