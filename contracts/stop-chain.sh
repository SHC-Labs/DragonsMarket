#!/usr/bin/env bash
# Stops the local dev chain started by `cargo test -p pm-tests --test dev_chain -- --ignored`.
# Matches by process name and by the executable living under this project, so it cannot touch anything else.
here="$(cd "$(dirname "$0")" && pwd)"
ps -eo pid=,comm= | awk '$2 ~ /^(dev_chain|near-sandbox|cargo)/ {print $1}' | while read -r pid; do
  exe="$(readlink "/proc/$pid/exe" 2>/dev/null)"; cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null)"
  case "$exe$cwd" in *"$here"*|*"/PredictionMarket/contracts"*) kill "$pid" 2>/dev/null && echo "stopped $pid";; esac
done
exit 0
