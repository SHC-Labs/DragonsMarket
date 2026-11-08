// Run with: node --test keeper/
import test from "node:test";
import assert from "node:assert/strict";
import { base58ToHex, compareCodeHashes, describeRelease, hexToBase58, liveCodeHashes, parseReleaseHashes, upgradeProposalProblems } from "./release-check.mjs";

const HEX = { market: "11".repeat(32), oracle: "22".repeat(32), council: "33".repeat(32) };
const COMMIT = "c".repeat(40);
const MESSAGE = `Release hashes

market sha256:${HEX.market}
oracle sha256:${HEX.oracle}
council sha256:${HEX.council}
commit ${COMMIT}
toolchain 1.99.0
`;

test("parses a good tag message", () => {
  assert.deepEqual(parseReleaseHashes(MESSAGE), { ...HEX, commit: COMMIT });
});

test("rejects malformed messages", () => {
  assert.throws(() => parseReleaseHashes(MESSAGE.replace("Release hashes", "Hashes")), /must start/);
  assert.throws(() => parseReleaseHashes(MESSAGE.replace(/oracle .*\n/, "")), /no oracle line/);
  assert.throws(() => parseReleaseHashes(MESSAGE.replace(HEX.council, "33".repeat(31))), /malformed council line/);
  assert.throws(() => parseReleaseHashes(MESSAGE.replace("sha256:" + HEX.market, HEX.market)), /malformed market line/);
  assert.throws(() => parseReleaseHashes(MESSAGE.replace(/commit .*\n/, "")), /no commit line/);
  assert.throws(() => parseReleaseHashes(MESSAGE.replace(COMMIT, "abc")), /malformed commit line/);
});

test("hex and base58 round trip, with a known vector", () => {
  assert.equal(hexToBase58("00".repeat(32)), "1".repeat(32));
  assert.equal(hexToBase58("ff"), "5Q");
  assert.equal(base58ToHex("5Q"), "ff");
  for (const hex of Object.values(HEX)) assert.equal(base58ToHex(hexToBase58(hex)), hex);
});

const liveOf = (hex) => Object.fromEntries(Object.entries(hex).map(([k, v]) => [k, hexToBase58(v)]));

test("matching hashes give no problems", () => {
  assert.deepEqual(compareCodeHashes({ expected: HEX, live: liveOf(HEX) }), []);
});

test("a mismatch names the contract, the live hash and the released hash", () => {
  const live = liveOf({ ...HEX, oracle: "44".repeat(32) });
  const problems = compareCodeHashes({ expected: HEX, live });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^oracle:/);
  assert.ok(problems[0].includes(live.oracle));
  assert.ok(problems[0].includes(hexToBase58(HEX.oracle)));
  assert.equal(compareCodeHashes({ expected: HEX, live: { ...liveOf(HEX), council: undefined } }).length, 1);
});

test("describeRelease prints one line when clean and one line per problem otherwise", () => {
  assert.deepEqual(describeRelease([]), ["release: live code matches the release hash list"]);
  const lines = describeRelease(["market: x", "oracle: y"]);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /2 contract\(s\) differ/);
  assert.equal(lines[1], "release: market: x");
});

test("liveCodeHashes reads view_account at final for each account", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const { params } = JSON.parse(init.body);
    seen.push(params);
    return Response.json({ result: { code_hash: `hash-of-${params.account_id}` } });
  });
  const accounts = { market: "m.near", oracle: "o.near", council: "c.near" };
  const live = await liveCodeHashes("http://rpc.invalid", accounts);
  assert.deepEqual(live, { market: "hash-of-m.near", oracle: "hash-of-o.near", council: "hash-of-c.near" });
  assert.ok(seen.every((p) => p.request_type === "view_account" && p.finality === "final"));
});

const ROUNDS_HEX = "55".repeat(32);
const withRounds = MESSAGE.replace(`commit ${COMMIT}`, `rounds sha256:${ROUNDS_HEX}\ncommit ${COMMIT}`);

test("a rounds line is read when present and optional when not", () => {
  assert.equal(parseReleaseHashes(withRounds).rounds, ROUNDS_HEX);
  assert.equal(parseReleaseHashes(MESSAGE).rounds, undefined);
});

test("a deployed rounds contract needs a rounds line in the list", () => {
  const live = { ...liveOf(HEX), rounds: hexToBase58(ROUNDS_HEX) };
  assert.deepEqual(compareCodeHashes({ expected: parseReleaseHashes(withRounds), live }), []);
  const problems = compareCodeHashes({ expected: parseReleaseHashes(MESSAGE), live });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^rounds: the release list has no rounds line/);
});

const ACCOUNTS = { market: "market.near", oracle: "oracle.near", council: "council.near", rounds: "rounds.near" };
const upgradeProposal = (id, receiver_id, code_hash) => ({
  id,
  kind: { FunctionCall: { receiver_id, actions: [{ method_name: "upgrade", args: Buffer.from(JSON.stringify({ code_hash })).toString("base64"), deposit: "0", gas: "1" }] } },
});

test("an upgrade proposal must carry the released hash of its contract", () => {
  const release = parseReleaseHashes(withRounds);
  const proposals = [
    upgradeProposal(1, "oracle.near", hexToBase58(HEX.oracle)),
    upgradeProposal(2, "council.near", hexToBase58(HEX.oracle)),
    upgradeProposal(3, "rounds.near", hexToBase58("66".repeat(32))),
    upgradeProposal(4, "rounds.near", hexToBase58(ROUNDS_HEX)),
    { id: 5, kind: "Vote" },
  ];
  const problems = upgradeProposalProblems({ proposals, contracts: ACCOUNTS, release });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /^DAO proposal 2 upgrades council to .* which is not in the --release list/);
  assert.match(problems[1], /^DAO proposal 3 upgrades rounds to /);
});

test("an upgrade of a contract the list does not cover is refused", () => {
  const problems = upgradeProposalProblems({ proposals: [upgradeProposal(9, "rounds.near", hexToBase58(ROUNDS_HEX))], contracts: ACCOUNTS, release: parseReleaseHashes(MESSAGE) });
  assert.match(problems[0], /no rounds line/);
});
