#!/usr/bin/env bash
# Stops the dev server started by dev-local.sh. Only touches node, next, npm and timeout processes
# whose working directory is this app, matched by process name so it can never match the calling shell.
here="$(cd "$(dirname "$0")/.." && pwd)"
ps -eo pid=,comm= | awk '$2 ~ /^(node|next-server|npm|npx|timeout)/ {print $1}' | while read -r pid; do
  [ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" = "$here" ] && kill "$pid" 2>/dev/null && echo "stopped $pid"
done
exit 0
