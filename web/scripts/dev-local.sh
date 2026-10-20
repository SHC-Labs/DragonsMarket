#!/usr/bin/env bash
# Starts the Next dev server on :3400 against the local dev chain (contracts/dev-chain.json). Stops after 2 hours by default; DEV_SERVER_SECS=0 keeps it running.
set -euo pipefail
cd "$(dirname "$0")/.."
chain=../contracts/dev-chain.json
read_key() { python3 -I -c "import json; print(json.load(open('$chain'))$1)"; }
export NEXT_PUBLIC_NETWORK=sandbox
export NEXT_PUBLIC_RPC_URL="$(read_key "['rpc']")"
export NEXT_PUBLIC_MARKET_ID="$(read_key "['market']")"
export NEXT_PUBLIC_ORACLE_ID="$(read_key "['oracle']")"
export NEXT_PUBLIC_TOKEN_ID="$(read_key "['token']")"
exec timeout "${DEV_SERVER_SECS:-7200}" npx next dev -p "${PORT:-3400}"
