.PHONY: build test clippy

build:
	cd contracts && ./build.sh

test:
	cd contracts && cargo test --workspace
	cd contracts && node --test keeper/*.test.mjs

clippy:
	cd contracts && cargo clippy --workspace --all-targets -- -D warnings
