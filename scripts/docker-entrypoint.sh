#!/bin/sh
set -eu

auth_root="${USAGE_AUTH_ROOT:-/home/node/auth}"

seed_auth_directory() {
  source_dir="$1"
  target_dir="$2"

  [ -d "$source_dir" ] || return 0
  mkdir -p "$target_dir"

  # Never overwrite credentials that Usage API has already refreshed.
  if [ -z "$(find "$target_dir" -mindepth 1 -print -quit)" ]; then
    cp -R "$source_dir"/. "$target_dir"/
  fi
}

seed_auth_directory /home/node/.claude "$auth_root/.claude"
seed_auth_directory /home/node/.claude2 "$auth_root/.claude2"
seed_auth_directory /home/node/.codex "$auth_root/.codex"

exec node dist/server.js
