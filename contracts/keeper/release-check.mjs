// Compares the code hashes live on chain with the hash list of a release (the message of an annotated git tag).
// Pure functions plus one RPC read. No dependencies: Node 22 built-ins only.
import { b58decode, b58encode, rpc } from "./chain.mjs";

const CONTRACTS = ["market", "oracle", "council"];
const OPTIONAL_CONTRACTS = ["rounds"];
const HEX64 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

export const hexToBase58 = (hex) => b58encode(Buffer.from(hex, "hex"));
export const base58ToHex = (b58) => b58decode(b58).toString("hex");

// Reads the tag message: "Release hashes", a blank line, one "<name> sha256:<hex>" line per contract (market, oracle, council,
// and rounds when it is deployed), "commit <hash>", "toolchain <version>".
export function parseReleaseHashes(message) {
  const lines = String(message).split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  if (lines[0] !== "Release hashes") throw new Error('release list must start with the line "Release hashes"');
  const release = {};
  for (const name of [...CONTRACTS, ...OPTIONAL_CONTRACTS]) {
    const line = lines.find((l) => l.startsWith(`${name} `));
    if (!line && OPTIONAL_CONTRACTS.includes(name)) continue;
    if (!line) throw new Error(`release list has no ${name} line`);
    const hex = line.match(/^\S+ sha256:(\S+)$/)?.[1];
    if (!hex || !HEX64.test(hex)) throw new Error(`release list has a malformed ${name} line: "${line}"`);
    release[name] = hex;
  }
  const commitLine = lines.find((l) => l.startsWith("commit "));
  if (!commitLine) throw new Error("release list has no commit line");
  const commit = commitLine.slice("commit ".length).trim();
  if (!COMMIT.test(commit)) throw new Error(`release list has a malformed commit line: "${commitLine}"`);
  return { ...release, commit };
}

// One problem string per contract whose live code hash (base58) differs from the released one.
export function compareCodeHashes({ expected, live }) {
  const problems = [];
  for (const name of Object.keys(live)) {
    if (!expected[name]) {
      problems.push(`${name}: the release list has no ${name} line, so its live code hash ${live[name]} cannot be checked`);
      continue;
    }
    const liveHash = live[name];
    const released = hexToBase58(expected[name]);
    if (liveHash !== released) {
      problems.push(`${name}: live code hash ${liveHash ?? "missing"} does not match the released ${released}`);
    }
  }
  return problems;
}

export async function liveCodeHashes(url, accounts) {
  const out = {};
  for (const name of Object.keys(accounts)) {
    const result = await rpc(url, "query", { request_type: "view_account", finality: "final", account_id: accounts[name] });
    out[name] = result.code_hash;
  }
  return out;
}

// The lines the keeper prints for a release comparison.
export function describeRelease(problems) {
  if (problems.length === 0) return ["release: live code matches the release hash list"];
  return [`release: ${problems.length} contract(s) differ from the release hash list`, ...problems.map((p) => `release: ${p}`)];
}

// One problem per open upgrade proposal whose code hash is not the released hash of its contract. `contracts` maps a name to its
// account id, `release` is a parsed release list. A contract the list does not cover has no hash an upgrade could match.
export function upgradeProposalProblems({ proposals, contracts, release }) {
  const problems = [];
  for (const proposal of proposals) {
    const functionCall = proposal.kind?.FunctionCall;
    const name = Object.keys(contracts).find((n) => contracts[n] === functionCall?.receiver_id);
    if (!name) continue;
    for (const action of functionCall.actions ?? []) {
      if (action.method_name !== "upgrade") continue;
      let proposed;
      try {
        proposed = JSON.parse(Buffer.from(action.args, "base64").toString("utf8")).code_hash;
      } catch {
        proposed = undefined;
      }
      const released = release[name] ? hexToBase58(release[name]) : null;
      if (proposed !== released) {
        problems.push(`DAO proposal ${proposal.id} upgrades ${name} to ${proposed ?? "an unreadable code hash"}, which is not in the --release list (${released ?? `no ${name} line`})`);
      }
    }
  }
  return problems;
}
