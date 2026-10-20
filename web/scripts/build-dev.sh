#!/usr/bin/env bash
# Builds the static site against the local dev chain written by contracts/tests/tests/dev_chain.rs.
set -euo pipefail
cd "$(dirname "$0")/.."
chain=../contracts/dev-chain.json
read_key() { python3 -I -c "import json,sys; print(json.load(open('$chain'))$1)"; }
export NEXT_PUBLIC_NETWORK=sandbox
export NEXT_PUBLIC_RPC_URL="$(read_key "['rpc']")"
export NEXT_PUBLIC_MARKET_ID="$(read_key "['market']")"
export NEXT_PUBLIC_ORACLE_ID="$(read_key "['oracle']")"
export NEXT_PUBLIC_TOKEN_ID="$(read_key "['token']")"
npx next build
