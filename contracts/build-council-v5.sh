#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
cd "$(dirname "$0")"
root="$PWD"
archive=tests/fixtures/council-v5-source.tar.gz

echo "eb5d3fb1cbe59f5740d7c15c5d105ae82cb9f9b50268438235dd56a4caaf7324  $archive" | sha256sum --check

mkdir -p target
scratch=$(mktemp -d "$root/target/council-v5-source.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
tar -xzf "$archive" -C "$scratch"
(
  cd "$scratch/contracts/council"
  CARGO_TARGET_DIR="$root/target/council-v5-build" \
    cargo near build non-reproducible-wasm --locked --out-dir "$scratch/out"
)
mkdir -p target/near/council_v5
cp "$scratch/out/council.wasm" target/near/council_v5/council_v5.wasm
sha256sum target/near/council_v5/council_v5.wasm
