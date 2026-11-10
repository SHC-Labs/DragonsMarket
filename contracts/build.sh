#!/usr/bin/env bash
# Builds the wasm files the integration tests load: target/near/<crate>/<crate>.wasm
#
#   ./build.sh                 the local toolchain, for the sandbox tests. Builds the mocks too.
#   ./build.sh --reproducible  the four application contracts that get deployed, built inside the docker image pinned in each
#                              Cargo.toml, with the sha256 of each wasm written to target/near/HASHES.txt. Needs docker
#                              and every change committed: the build uses the committed code, not the working tree.
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
cd "$(dirname "$0")"
artifacts_dir="$PWD/target/near"

case "${1:-}" in
  "") ;;
  --reproducible) reproducible=1 ;;
  *) echo "usage: build.sh [--reproducible]" >&2; exit 2 ;;
esac

if [ -n "${reproducible:-}" ]; then
  if [ -n "$(git status --porcelain -- .)" ]; then
    echo "uncommitted changes: a reproducible build is of the committed code, so commit first" >&2
    exit 1
  fi
  hashes=target/near/HASHES.txt
  mkdir -p target/near
  : >"$hashes"
  for c in council market oracle rounds; do
    crate=${c//-/_}
    (cd "$c" && cargo near build reproducible-wasm --out-dir "$artifacts_dir/$crate")
    (cd "target/near/$crate" && sha256sum "$crate.wasm") >>"$hashes"
  done
  cat "$hashes"
  exit 0
fi

log=$(mktemp)
trap 'rm -f "$log"' EXIT
for c in mock-ft mock-nft mock-mt-receiver council market oracle rounds; do
  crate=${c//-/_}
  # cargo-near follows CARGO_TARGET_DIR; always export the actual artifacts where the tests load them.
  if (cd "$c" && cargo near build non-reproducible-wasm --out-dir "$artifacts_dir/$crate" >"$log" 2>&1); then
    # A build that produces the same bytes may leave the file alone. The tests compare its time with the source, so mark it built now.
    test -s "$artifacts_dir/$crate/$crate.wasm"
    touch "target/near/$crate/$crate.wasm"
    echo "built $c"
  else
    cat "$log"
    exit 1
  fi
done
