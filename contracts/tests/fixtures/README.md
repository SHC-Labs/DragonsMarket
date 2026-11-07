# Council v5 migration fixture

`council-v5-source.tar.gz` is the unmodified `contracts/` tree from private
`SHC-Labs/Dragons-Market` commit `fd188d0d869a7ac6131da63f1d8dea09cdd705e7`.
It contains Council state version 5, its workspace dependencies, lockfile, and
Rust toolchain pin. It contains no Git history. Keeping the source archive here
lets shallow checkouts and the public repository build the same historical
fixture without access to private commits or credentials.

The archive's SHA-256 is
`eb5d3fb1cbe59f5740d7c15c5d105ae82cb9f9b50268438235dd56a4caaf7324`.
It was generated from that commit with:

```sh
git archive fd188d0d869a7ac6131da63f1d8dea09cdd705e7 contracts | gzip -n \
  > contracts/tests/fixtures/council-v5-source.tar.gz
```

Build the fixture from any checkout with Rust 1.99.0 and cargo-near 0.22.0:

```sh
bash contracts/build-council-v5.sh
```

The script verifies the archive checksum before extracting it, builds with
`--locked`, and writes `contracts/target/near/council_v5/council_v5.wasm` for
the seven `council_migration` sandbox tests. Its separate Cargo target directory
prevents the historical build from overwriting the current Council build.
CI runs the same script before the sandbox suite and caches its build artifacts
alongside the other contract artifacts.

This is a sandbox upgrade fixture. Its source revision does not establish which
code is currently deployed on any public network.
