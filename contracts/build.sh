#!/usr/bin/env bash
# Builds the wasm files the integration tests load: target/near/<crate>/<crate>.wasm
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
cd "$(dirname "$0")"
log=$(mktemp)
for c in mock-ft mock-nft pm-council pm-governance pm-market pm-oracle; do
  if (cd "$c" && cargo near build non-reproducible-wasm >"$log" 2>&1); then
    echo "built $c"
  else
    cat "$log"
    exit 1
  fi
done
