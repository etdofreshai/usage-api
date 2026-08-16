#!/bin/sh
set -eu

auth_root="${USAGE_AUTH_ROOT:-/home/node/auth}"
claude_dir="$auth_root/.claude"
claude2_dir="$auth_root/.claude2"
codex_dir="$auth_root/.codex"
codex2_dir="$auth_root/.codex2"

usage() {
  cat <<'EOF'
Usage: usage-auth <status|claude|claude2|codex|codex2>

  status   Show authentication status without printing tokens
  claude   Renew the primary Claude subscription login
  claude2  Renew the second Claude subscription login
  codex    Renew Codex using the headless device-code flow
  codex2   Renew the second Codex account using an isolated device-code flow
EOF
}

case "${1:-}" in
  status)
    printf '%s\n' 'Claude:'
    CLAUDE_CONFIG_DIR="$claude_dir" claude auth status --text || true
    printf '\n%s\n' 'Claude #2:'
    CLAUDE_CONFIG_DIR="$claude2_dir" claude auth status --text || true
    printf '\n%s\n' 'Codex:'
    CODEX_HOME="$codex_dir" codex login status || true
    printf '\n%s\n' 'Codex #2:'
    CODEX_HOME="$codex2_dir" codex login status || true
    ;;
  claude)
    export CLAUDE_CONFIG_DIR="$claude_dir"
    exec claude auth login --claudeai
    ;;
  claude2)
    export CLAUDE_CONFIG_DIR="$claude2_dir"
    exec claude auth login --claudeai
    ;;
  codex)
    export CODEX_HOME="$codex_dir"
    exec codex login --device-auth
    ;;
  codex2)
    export CODEX_HOME="$codex2_dir"
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
