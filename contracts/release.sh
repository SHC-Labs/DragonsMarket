#!/usr/bin/env bash
# Builds the release wasm files reproducibly, checks their embedded build info, and prints the release message on stdout.
# Progress goes to stderr. This script writes nothing to git: a person publishes the message with the command printed at the end.
set -euo pipefail
cd "$(dirname "$0")"

if [ -n "$(git status --porcelain -- .)" ]; then
  echo "uncommitted changes under contracts/: a release is built from the committed code, so commit first" >&2
  exit 1
fi
command -v docker >/dev/null || { echo "docker is needed for a reproducible build" >&2; exit 1; }

./build.sh --reproducible >&2
node verify-build.mjs target/near/market/market.wasm target/near/oracle/oracle.wasm target/near/council/council.wasm >&2

commit=$(git rev-parse HEAD)
toolchain=$(sed -n 's/^channel *= *"\(.*\)"/\1/p' rust-toolchain.toml)
message="Release hashes

$(for c in market oracle council; do echo "$c sha256:$(sha256sum "target/near/$c/$c.wasm" | cut -d' ' -f1)"; done)
commit $commit
toolchain $toolchain"

printf '%s\n' "$message"
{
  echo
  echo "To publish these hashes, save the lines above to a file and run, with your own tag name:"
  echo "  git tag -a <tag name> -m \"\$(cat <file>)\""
  echo "This tool never creates the tag."
} >&2
