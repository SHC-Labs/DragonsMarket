// Run with: node --test verify-build.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { checkBuildInfo, extractSourceMetadata } from "./verify-build.mjs";

const COMMIT = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;

const goodInfo = () => ({
  build_environment: `sourcescan/cargo-near:0.22.0-rust-1.99.0@${DIGEST}`,
  build_command: ["cargo", "near", "build", "non-reproducible-wasm", "--locked"],
  contract_path: "market",
  source_code_snapshot: `git+https://example.invalid/repo?rev=${COMMIT}`,
});

const metadata = (build_info) => ({
  version: "0.1.0",
  link: "https://example.invalid/repo",
  standards: [{ standard: "nep330", version: "1.3.0" }],
  build_info,
});

// Bytes shaped like a wasm data section: noise, then the metadata JSON, then more noise with braces in it.
const wasmWith = (meta) =>
  Buffer.concat([Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 0x7b, 0x02]), Buffer.from(JSON.stringify(meta)), Buffer.from("{not json}\x00\x01")]);

test("complete build info is accepted and read back", () => {
  const found = extractSourceMetadata(wasmWith(metadata(goodInfo())));
  const info = checkBuildInfo(found);
  assert.equal(info.commit, COMMIT);
  assert.equal(info.digest, DIGEST);
  assert.equal(info.contractPath, "market");
  assert.equal(info.command, "cargo near build non-reproducible-wasm --locked");
});

test("a build with build_info null is rejected and told to build reproducibly", () => {
  const found = extractSourceMetadata(wasmWith(metadata(null)));
  assert.throws(() => checkBuildInfo(found), /build\.sh --reproducible/);
});

test("a wasm with no metadata is rejected", () => {
  assert.equal(extractSourceMetadata(Buffer.from("plain bytes")), null);
  assert.throws(() => checkBuildInfo(null), /no contract source metadata/);
});

const cases = [
  ["no digest", { build_environment: "sourcescan/cargo-near:0.22.0-rust-1.99.0" }, /no sha256 digest/],
  ["no build environment", { build_environment: "" }, /no build environment/],
  ["empty command", { build_command: [] }, /no build command/],
  ["no commit", { source_code_snapshot: "git+https://example.invalid/repo" }, /names no commit/],
  ["short commit", { source_code_snapshot: "git+https://example.invalid/repo?rev=abc123" }, /names no commit/],
  ["no contract path", { contract_path: " " }, /no contract path/],
];
for (const [name, change, pattern] of cases) {
  test(`rejects build info with ${name}`, () => {
    const found = extractSourceMetadata(wasmWith(metadata({ ...goodInfo(), ...change })));
    assert.throws(() => checkBuildInfo(found), pattern);
  });
}

test("a built wasm from the sandbox build is rejected as not reproducible", (t) => {
  const dir = path.resolve(import.meta.dirname, "target/near");
  const crate = ["market", "oracle", "council"].find((c) => fs.existsSync(path.join(dir, c, `${c}.wasm`)));
  if (!crate) {
    const note = `SKIPPED: no built wasm under ${dir}; run ./build.sh to exercise this case`;
    console.warn(note);
    t.skip(note);
    return;
  }
  const found = extractSourceMetadata(fs.readFileSync(path.join(dir, crate, `${crate}.wasm`)));
  assert.ok(found, "the built wasm carries source metadata");
  if (found.build_info !== null) {
    const note = `SKIPPED: ${crate}.wasm is a reproducible build, so it is the passing case`;
    console.warn(note);
    t.skip(note);
    return;
  }
  assert.throws(() => checkBuildInfo(found), /build\.sh --reproducible/);
});
