// Release gate: refuses a wasm that does not carry reproducible build info in its NEP-330 source metadata.
// Usage: node verify-build.mjs <wasm> [<wasm> ...]
// No dependencies: Node 22 built-ins only.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MARKER = Buffer.from('"build_info"');
const DIGEST = /sha256:[0-9a-f]{64}/;
const COMMIT = /[?&]rev=([0-9a-f]{40})(?![0-9a-f])/;

// The JSON text that starts at `start`, up to its matching brace, or null when the braces never close.
function jsonSpan(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

// The contract_source_metadata object cargo-near writes into the wasm data section, or null when there is none.
export function extractSourceMetadata(buffer) {
  const at = buffer.indexOf(MARKER);
  if (at < 0) return null;
  const text = buffer.toString("latin1");
  for (let start = text.lastIndexOf("{", at); start >= 0; start = text.lastIndexOf("{", start - 1)) {
    const span = jsonSpan(text, start);
    if (span === null || !span.includes('"build_info"')) continue;
    try {
      const parsed = JSON.parse(Buffer.from(span, "latin1").toString("utf8"));
      if (parsed && typeof parsed === "object" && "build_info" in parsed) return parsed;
    } catch {
      // an inner brace that is not the metadata object
    }
  }
  return null;
}

const text = (value) => (typeof value === "string" ? value.trim() : "");

// Returns { image, command, commit, contractPath } for complete build info, or throws a plain error naming what is missing.
export function checkBuildInfo(metadata) {
  if (!metadata) throw new Error("no contract source metadata found in the wasm");
  const info = metadata.build_info;
  if (info === null || info === undefined) {
    throw new Error("build_info is empty: this is not a reproducible build, build it with ./build.sh --reproducible");
  }
  const image = text(info.build_environment);
  if (!image) throw new Error("build_info has no build environment");
  const digest = image.match(DIGEST);
  if (!digest) throw new Error(`build environment "${image}" has no sha256 digest`);
  const command = Array.isArray(info.build_command) ? info.build_command.join(" ").trim() : text(info.build_command);
  if (!command) throw new Error("build_info has no build command");
  const snapshot = text(info.source_code_snapshot);
  const commit = snapshot.match(COMMIT)?.[1];
  if (!commit) throw new Error(`source code snapshot "${snapshot}" names no commit`);
  const contractPath = text(info.contract_path);
  if (!contractPath) throw new Error("build_info has no contract path");
  return { image, digest: digest[0], command, commit, contractPath };
}

export function verifyWasm(file) {
  const buffer = fs.readFileSync(file);
  let info;
  try {
    info = checkBuildInfo(extractSourceMetadata(buffer));
  } catch (err) {
    throw new Error(`${file}: ${err.message}`);
  }
  const crate = path.basename(file, ".wasm");
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  return { crate, sha256, commit: info.commit, digest: info.digest };
}

function main(files) {
  if (files.length === 0) {
    console.error("usage: node verify-build.mjs <wasm> [<wasm> ...]");
    return 2;
  }
  let failed = false;
  for (const file of files) {
    try {
      const r = verifyWasm(file);
      console.log(`${r.crate} sha256:${r.sha256} commit ${r.commit} image ${r.digest}`);
    } catch (err) {
      console.error(err.message);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) process.exit(main(process.argv.slice(2)));
