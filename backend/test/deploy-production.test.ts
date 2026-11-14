import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from 'near-sandbox';
import { Account, JsonRpcProvider, KeyPair, actions, baseEncode, nearToYocto, teraToGas, type KeyPairString } from 'near-api-js';
import { prepareTreasuryVote, type TreasuryWalletRequest } from '@dragons-market/keeper/treasury';
import { daoFixture } from './dao-fixture.js';

const ROLES = ['market', 'oracle', 'council', 'rounds'] as const;
const SCRIPT = resolve('../contracts/deploy-production.mjs');
const keyRoot = tmpdir();
const USDC_ID = 'usdc';

interface Run { code: number; stdout: string; stderr: string }
const node = (args: string[]) => new Promise<Run>(done => {
  execFile(process.execPath, [SCRIPT, ...args], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) =>
    done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }));
});

let sandbox: Sandbox | undefined;
let provider: JsonRpcProvider;
let dir = '';
let manifestFile = '';
let keyDir = '';
let parentKeyFile = '';
let members: Account[] = [];
let daoId = '';
const children = {} as Record<typeof ROLES[number], string>;

const landed = (result: Awaited<ReturnType<Account['signAndSendTransaction']>>) => {
  assert.ok(typeof result.status === 'object' && 'SuccessValue' in result.status, JSON.stringify(result.status));
  for (const receipt of result.receipts_outcome) {
    const status = receipt.outcome.status;
    assert.ok(typeof status === 'object' && ('SuccessValue' in status || 'SuccessReceiptId' in status), JSON.stringify(status));
  }
  return result;
};
const view = async (contractId: string, methodName: string, args: Record<string, unknown> = {}) => {
  const result = await provider.callFunction<Record<string, unknown>>({ contractId, method: methodName, args, blockQuery: { finality: 'final' } });
  assert.ok(result);
  return result;
};
const keyCount = async (accountId: string) =>
  (await provider.viewAccessKeyList({ accountId, finalityQuery: { finality: 'final' } })).keys.length;
const exists = (accountId: string) => provider.viewAccount({ accountId, blockQuery: { finality: 'final' } }).then(() => true, () => false);
const rpcArgs = () => ['--manifest', manifestFile, '--rpc', sandbox!.rpcUrl];

// Submits the wallet request a member would, then votes until the DAO executes it.
async function executeProposals(request: { description: string; request: TreasuryWalletRequest }[]) {
  const settings = { treasuryId: daoId, contracts: children, view: (account: string, method: string, args: Record<string, unknown>) => view(account, method, args) };
  const send = async (signer: Account, wallet: TreasuryWalletRequest) => landed(await signer.signAndSendTransaction({
    receiverId: wallet.receiverId, waitUntil: 'FINAL', actions: wallet.actions.map(({ params }) =>
      actions.functionCall(params.methodName, params.args, BigInt(params.gas), BigInt(params.deposit))) }));
  for (const { request: wallet } of request) {
    const created = await send(members[0]!, wallet);
    assert.ok(typeof created.status === 'object' && 'SuccessValue' in created.status);
    const proposalId: unknown = JSON.parse(Buffer.from(created.status.SuccessValue, 'base64').toString());
    assert.ok(typeof proposalId === 'number');
    const vote = await prepareTreasuryVote({ ...settings, proposalId, approve: true });
    await send(members[0]!, vote);
    await send(members[1]!, vote);
    assert.equal((await view(daoId, 'get_proposal', { id: proposalId })).status, 'Approved');
  }
}

async function proposals() {
  const run = await node([...rpcArgs(), 'proposals', '--json']);
  assert.equal(run.code, 0, run.stderr + run.stdout);
  return JSON.parse(run.stdout.trim().split('\n').at(-1)!) as { description: string; request: TreasuryWalletRequest }[];
}

before(async () => {
  const daoWasm = await daoFixture();
  await mkdir('.local/tmp', { recursive: true });
  process.env.TMPDIR = resolve('.local/tmp');
  process.env.DIR_TO_DOWNLOAD_BINARY = resolve('.local/sandbox-bin');
  dir = await mkdtemp(join(keyRoot, 'deploy-production-'));
  keyDir = join(dir, 'keys');
  sandbox = await Sandbox.start({ version: '2.13.4' });
  provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
  const root = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY as KeyPairString);
  const account = async (name: string, near: `${number}`, key = KeyPair.fromRandom('ed25519')) => {
    await root.createAccount({ newAccountId: `${name}.${DEFAULT_ACCOUNT_ID}`, publicKey: key.getPublicKey(), nearToTransfer: nearToYocto(near) });
    return { acc: new Account(`${name}.${DEFAULT_ACCOUNT_ID}`, provider, key.toString()), key };
  };
  const parentKey = KeyPair.fromRandom('ed25519');
  // After the first child is funded there is no longer enough for the original
  // full plan. Resuming must budget only the children that do not exist yet.
  const parent = await account('dragonsmarket', '165', parentKey);
  parentKeyFile = join(dir, 'parent.key');
  await writeFile(parentKeyFile, `${parentKey.toString()}\n`, { mode: 0o600 });
  const dao = (await account('dao', '30')).acc;
  daoId = dao.accountId;
  members = [(await account('member1', '30')).acc, (await account('member2', '30')).acc, (await account('member3', '30')).acc];
  await dao.deployContract(daoWasm);
  landed(await dao.signAndSendTransaction({ receiverId: daoId, waitUntil: 'FINAL', actions: [actions.functionCall('new', {
    config: { name: 'Sandbox governance', purpose: 'Deploy tooling proof', metadata: '' },
    policy: { roles: [{ name: 'Council', kind: { Group: members.map(member => member.accountId) }, permissions: ['*:*'], vote_policy: {} }],
      default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: '2' },
      proposal_bond: nearToYocto('0.1').toString(), proposal_period: '604800000000000',
      bounty_bond: nearToYocto('0.1').toString(), bounty_forgiveness_period: '604800000000000' } }, teraToGas('100'), 0n)] }));
  const nft = (await account('nft', '30')).acc;
  const operator = (await account('operator', '5')).acc;
  const bytes = {} as Record<typeof ROLES[number], Buffer>;
  for (const role of ROLES) {
    children[role] = `${role}.${parent.acc.accountId}`;
    bytes[role] = await readFile(`../contracts/target/near/${role}/${role}.wasm`);
  }
  const verifierId = `intents.${DEFAULT_ACCOUNT_ID}`, collateral = `nep141:${USDC_ID}.${DEFAULT_ACCOUNT_ID}`;
  const common = { owner_id: daoId, verifier_id: verifierId, collateral_token_id: collateral };
  const contract = (role: typeof ROLES[number], init: object) => ({ account: children[role], wasm: resolve(`../contracts/target/near/${role}/${role}.wasm`),
    codeHash: baseEncode(createHash('sha256').update(bytes[role]).digest()), fundingNear: '40', init });
  const manifest = { network: 'sandbox', parent: parent.acc.accountId, dao: daoId, daoMinApprovals: 2, nft: nft.accountId, verifier: verifierId, collateral,
    operator: operator.accountId, decide: ['contracts.oracle.init.bond'], contracts: {
      market: contract('market', { ...common, operator_id: operator.accountId, oracle_id: children.oracle }),
      oracle: contract('oracle', { ...common, market_contract: children.market, bond: '5000000', window_ms: '3600000',
        panel_deadline_ms: '7200000', draw_window_ms: '3600000', council: children.council, jury_size: 5, draw_delay_blocks: '2',
        min_proposal_ms: '3600000', operator_id: operator.accountId, network: 'sandbox', price_threshold: 2, no_decision_recipient: daoId }),
      council: contract('council', { ...common, oracle_id: children.oracle, cooldown_ns: '1000000000', max_seats_per_account: 5, allowlist_enabled: true }),
      rounds: contract('rounds', { ...common, operator_id: operator.accountId, network: 'sandbox', price_threshold: 2 }),
    } };
  manifestFile = join(dir, 'manifest.json');
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
});

after(async () => {
  if (sandbox) {
    const child = (sandbox as unknown as { childProcess: ChildProcess }).childProcess;
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await sandbox.tearDown(); } finally { clearTimeout(timer); }
  }
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('plan is the default and sends nothing', { timeout: 300000 }, async () => {
  const bare = await node(['--manifest', manifestFile]);
  assert.equal(bare.code, 0, bare.stdout);
  assert.match(bare.stdout, /12\. rounds\.stage/);
  assert.match(bare.stdout, /Nothing was sent/);
  const explicit = await node(['plan', '--manifest', manifestFile]);
  assert.equal(explicit.stdout, bare.stdout);
  const dry = await node(['deploy', '--manifest', manifestFile]);
  assert.equal(dry.code, 0);
  assert.match(dry.stdout, /Dry run/);
  for (const role of ROLES) assert.equal(await exists(children[role]), false, `${role} must not exist before --send`);
});

test('plan refuses a manifest with a wrong owner, a stale hash or a placeholder', async () => {
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.contracts.market.init.owner_id = manifest.parent;
  manifest.contracts.oracle.codeHash = manifest.contracts.market.codeHash;
  manifest.operator = 'FILL_operator_account';
  const bad = join(dir, 'bad.json');
  await writeFile(bad, JSON.stringify(manifest));
  const run = await node(['plan', '--manifest', bad]);
  assert.equal(run.code, 1);
  assert.match(run.stdout, /contracts\.market\.init\.owner_id: must be /);
  assert.match(run.stdout, /contracts\.oracle\.wasm: the file hashes to/);
  assert.match(run.stdout, /operator: still a placeholder/);
});

test('deploy --send needs a key directory outside the repository', async () => {
  const run = await node(['deploy', '--send', ...rpcArgs(), '--parent-key-file', parentKeyFile, '--key-dir', resolve('.local/keys')]);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /inside the repository/);
  assert.equal(await exists(children.market), false);
});

test('deploy --send creates each child, initializes it as itself and reads config back', { timeout: 300000 }, async () => {
  // Lose the response after a real finalized create transaction. This exercises
  // the persisted pending hash, not a fabricated successful transaction record.
  const proxy = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      const upstream = await fetch(sandbox!.rpcUrl, { method: 'POST', body,
        headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30000) });
      const text = await upstream.text();
      if (JSON.parse(body).method === 'send_tx') {
        const result = JSON.parse(text).result;
        assert.equal(result.final_execution_status, 'FINAL');
        response.writeHead(400).end('injected lost send response');
      } else response.writeHead(upstream.status, { 'content-type': 'application/json' }).end(text);
    } catch { response.writeHead(500).end('test proxy failed'); }
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  assert.ok(address && typeof address !== 'string');
  let interrupted: Run;
  try {
    interrupted = await node(['deploy', '--send', '--manifest', manifestFile, '--rpc', `http://127.0.0.1:${address.port}`,
      '--parent-key-file', parentKeyFile, '--key-dir', keyDir]);
  } finally {
    await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
  }
  assert.equal(interrupted.code, 1, interrupted.stdout + interrupted.stderr);
  assert.match(interrupted.stderr, /send_tx: HTTP 400/);
  const pendingRecord = JSON.parse(await readFile(join(keyDir, 'deployment-sandbox.json'), 'utf8'));
  assert.equal(pendingRecord.pending.step, 'market.create');
  const createHash = pendingRecord.pending.hash;
  assert.equal(await exists(children.market), true);
  assert.equal(await exists(children.oracle), false);

  const run = await node(['deploy', '--send', ...rpcArgs(), '--parent-key-file', parentKeyFile, '--key-dir', keyDir]);
  assert.equal(run.code, 0, run.stderr + run.stdout);
  assert.doesNotMatch(run.stdout, /sent market\.create/, 'resume must not create or fund the first child again');
  const record = JSON.parse(await readFile(join(keyDir, 'deployment-sandbox.json'), 'utf8'));
  assert.equal(record.pending, null);
  assert.equal(record.market.transactions['market.create'], createHash);
  for (const role of ROLES) {
    assert.match(run.stdout, new RegExp(`${role}: config matches the manifest`));
    const file = join(keyDir, `${children[role]}.key`);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const onChain = (await provider.viewAccount({ accountId: children[role], blockQuery: { finality: 'final' } })).code_hash;
    assert.equal(record[role].onChainCodeHash, onChain);
    assert.match(record[role].wasmSha256, /^[0-9a-f]{64}$/);
    assert.equal((await view(children[role], 'config')).owner, daoId);
    assert.equal(await keyCount(children[role]), 1);
    assert.equal((await view(children[role], 'is_staged', { code_hash: onChain })), true);
  }
  const again = await node(['deploy', '--send', ...rpcArgs(), '--parent-key-file', parentKeyFile, '--key-dir', keyDir]);
  assert.equal(again.code, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /sent /, 'a finished deployment sends nothing more');
  assert.deepEqual(JSON.parse(await readFile(join(keyDir, 'deployment-sandbox.json'), 'utf8')), record, 'a restart retains every original transaction hash');
});

test('verify fails while the upgrade is unproven and keys remain', async () => {
  const run = await node([...rpcArgs(), 'verify']);
  assert.equal(run.code, 1);
  for (const role of ROLES) {
    assert.match(run.stdout, new RegExp(`PASS ${role} owner is the DAO`));
    assert.match(run.stdout, new RegExp(`FAIL ${role} upgrade path proven`));
    assert.match(run.stdout, new RegExp(`FAIL ${role} no access keys`));
  }
  assert.match(run.stdout, /FAIL council NFT collection is set/);
});

test('DAO upgrade and seal proposals leave every contract keyless and verify passes', { timeout: 300000 }, async () => {
  const first = await proposals();
  assert.equal(first.length, 8, 'four upgrades, the NFT collection, Council market permission and both fee destinations');
  assert.ok(first.every(({ description }) => !/token range|council seats/i.test(description)));
  await executeProposals(first);
  for (const role of ROLES) assert.equal((await view(children[role], 'config')).upgrade_proven, true);
  const seals = await proposals();
  assert.deepEqual(seals.map(({ description }) => description.split(' ')[1]), ['market:', 'oracle:', 'council:', 'rounds:']);
  await executeProposals(seals.slice(0, 3));
  const remaining = await proposals();
  assert.equal(remaining.length, 1, 'proposal generation can resume after three seals');
  const partial = await node([...rpcArgs(), 'verify']);
  assert.equal(partial.code, 1, 'one remaining key is enough to fail');
  assert.match(partial.stdout, /FAIL rounds no access keys: got 1, want 0/);
  assert.doesNotMatch(partial.stdout, /FAIL (market|oracle|council)/);
  await executeProposals(seals.slice(3));
  for (const role of ROLES) assert.equal(await keyCount(children[role]), 0);
  const done = await node([...rpcArgs(), 'verify']);
  assert.equal(done.code, 0, done.stdout);
  assert.equal(done.stdout.match(/^PASS /gm)?.length, 25);
  assert.doesNotMatch(done.stdout, /FAIL/);
});

test('nft-ready reports an unenumerable collection instead of proposing', async () => {
  const run = await node([...rpcArgs(), 'nft-ready']);
  assert.equal(run.code, 1);
  assert.doesNotMatch(run.stdout, /add_proposal/);
});
