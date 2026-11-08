import { createHash, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, fstatSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { KEEPER_METHODS, keeperRpc, signedFunctionCall, validateActionKeys, type KeeperAction, type KeeperKeys, type KeeperOptions } from '@dragons-market/keeper';
import { base58Decode, base58Encode } from './base58.js';
import { finalTransaction } from './agent-chain.js';
import { object } from './ingestion/block.js';
import { assertApprovalCurrent, type KeeperApproval } from './keeper-approval.js';
import type { ReadRpcClient } from './providers.js';
import { isHash, isUint, isUnits } from './validate.js';

type Rpc = Pick<ReadRpcClient, 'call'>;
type Pending = { hash: string; receiver: string; method: string; args: Record<string, string>; gas: string };
interface Journal { version: 1; deployment: string; account: string; pending: Pending | null; last?: { hash: string; failed: boolean } }
const METHODS: Readonly<Record<string, readonly string[]>> = KEEPER_METHODS;

function writeJournal(file: string, journal: Journal) {
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(journal) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, file);
  const directory = openSync(dirname(file), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function readJournal(file: string, deployment: string, account: string): Journal {
  if (!existsSync(file)) return { version: 1, deployment, account, pending: null };
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: unknown;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16_384 || (stat.mode & 0o077) !== 0 || stat.nlink !== 1
      || (process.getuid && stat.uid !== process.getuid())) throw new Error('unsafe_keeper_journal');
    raw = JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
  if (!object(raw) || raw.version !== 1 || raw.deployment !== deployment || raw.account !== account)
    throw new Error('keeper_journal_scope_changed');
  const p = raw.pending;
  if (p !== null && (!object(p) || !isHash(p.hash) || typeof p.receiver !== 'string' || typeof p.method !== 'string'
    || !object(p.args) || !Object.values(p.args).every(v => typeof v === 'string') || !isUint(p.gas)))
    throw new Error('invalid_keeper_journal');
  return raw as unknown as Journal;
}

export function keeperSigningKeys(env: NodeJS.ProcessEnv, approval: KeeperApproval): KeeperKeys {
  if (env.KEEPER_KEY) throw new Error('unscoped_keeper_key_refused');
  const keys: KeeperKeys = {};
  for (const role of ['market', 'oracle', 'council'] as const) {
    const encoded = env[`KEEPER_${role.toUpperCase()}_KEY`];
    if (!encoded || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{86,88}$/.test(encoded)) throw new Error('missing_scoped_keeper_key');
    const raw = base58Decode(encoded.slice(8));
    if (raw.length !== 64) throw new Error('invalid_keeper_key');
    const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), raw.subarray(0, 32)]),
      format: 'der', type: 'pkcs8' });
    const publicKey = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32);
    if (!publicKey.equals(raw.subarray(32)) || `ed25519:${base58Encode(publicKey)}` !== approval.keeper.publicKeys[role])
      throw new Error('keeper_key_does_not_match_approval');
    keys[role] = encoded;
  }
  return keys;
}

function assertAction(action: KeeperAction, options: KeeperOptions) {
  if (!METHODS[action.contract]?.includes(action.method) || action.gas <= 0n || action.gas > 300_000_000_000_000n)
    throw new Error('unexpected_keeper_action');
  const wanted = action.contract === 'oracle' ? { market: options.market, market_id: action.args.market_id }
    : action.method === 'settle_leg' ? { sweep_id: action.args.sweep_id } : {};
  if (!isDeepStrictEqual(action.args, wanted)
    || (action.contract === 'oracle' && !isUint(action.args.market_id))
    || (action.method === 'settle_leg' && !isUint(action.args.sweep_id))) throw new Error('unexpected_keeper_arguments');
}

function checkedNonce(access: unknown, role: keyof KeeperKeys, options: KeeperOptions, approval: KeeperApproval) {
  const permission = object(access) && object(access.permission) && object(access.permission.FunctionCall) ? access.permission.FunctionCall : null;
  const methods = permission?.method_names;
  if (!object(access) || !(typeof access.nonce === 'number' && Number.isSafeInteger(access.nonce) && access.nonce >= 0)
    || !permission || permission.receiver_id !== options[role] || !Array.isArray(methods)
    || methods.length !== METHODS[role]!.length || new Set(methods).size !== methods.length
    || methods.some(method => typeof method !== 'string' || !METHODS[role]!.includes(method))
    || !isUnits(permission.allowance) || permission.allowance === '0'
    || BigInt(permission.allowance) > BigInt(approval.keeper.maxKeyAllowanceYocto)) throw new Error('keeper_nonce_or_allowance_invalid');
  return BigInt(access.nonce) + 1n;
}

export function createKeeperSigner(input: {
  approval: KeeperApproval; options: KeeperOptions; keys: KeeperKeys; journalFile: string;
  primary: Rpc; secondary: Rpc; verify: () => Promise<unknown>;
  broadcast?: (signed: string) => Promise<unknown>;
}) {
  const { approval, options, keys, primary, secondary, journalFile } = input;
  if (options.account !== approval.keeper.accountId) throw new Error('keeper_signer_scope_changed');
  const journal = readJournal(journalFile, approval.deployment.id, approval.keeper.accountId);
  let usedGas = 0n, sent = 0;
  let busy = false;

  function approvedAction(action: KeeperAction) {
    assertAction(action, options);
    if (action.args.market_id !== undefined && !approval.marketIds.includes(action.args.market_id))
      throw new Error('market_not_approved_for_keeper');
  }

  async function recover() {
    if (!journal.pending) return;
    const pending = journal.pending;
    const proofs = await Promise.all([primary, secondary].map(rpc => finalTransaction(rpc, pending.hash, journal.account)));
    for (const proof of proofs) {
      if (proof.receiver !== pending.receiver || !isDeepStrictEqual(proof.calls,
        [{ method: pending.method, args: pending.args, deposit: '0' }])) throw new Error('keeper_submission_proof_mismatch');
    }
    if (!isDeepStrictEqual(proofs[0], proofs[1])) throw new Error('keeper_submission_provider_disagreement');
    const failed = proofs[0]!.failed.length > 0;
    journal.pending = null;
    journal.last = { hash: pending.hash, failed };
    writeJournal(journalFile, journal);
    console.log(JSON.stringify({ service: 'keeper', transaction: pending.hash, final: true, failed }));
    return failed;
  }

  async function beforeBatch(actions: KeeperAction[]) {
    assertApprovalCurrent(approval);
    for (const action of actions) approvedAction(action);
    if (actions.length > approval.keeper.maxActionsPerRun
      || actions.reduce((sum, action) => sum + action.gas, 0n) > BigInt(approval.keeper.maxGasPerRunTgas) * 10n ** 12n)
      throw new Error('keeper_batch_exceeds_approved_budget');
    await recover();
    for (const role of ['market', 'oracle', 'council'] as const) {
      checkedNonce(await primary.call('query', { request_type: 'view_access_key', finality: 'optimistic',
        account_id: journal.account, public_key: approval.keeper.publicKeys[role] }), role, options, approval);
    }
    await input.verify();
  }

  async function send(action: KeeperAction) {
    if (busy) throw new Error('concurrent_keeper_submission_refused');
    busy = true;
    try {
      approvedAction(action);
      assertApprovalCurrent(approval);
      if (sent >= approval.keeper.maxActionsPerRun
        || usedGas + action.gas > BigInt(approval.keeper.maxGasPerRunTgas) * 10n ** 12n)
        throw new Error('keeper_run_budget_exhausted');
      await recover();
      await input.verify();
      await validateActionKeys(options, keys, [action]);
      const role = action.contract as keyof KeeperKeys;
      const publicKey = approval.keeper.publicKeys[role];
      const [block, access] = await Promise.all([
        primary.call('block', { finality: 'optimistic' }),
        primary.call('query', { request_type: 'view_access_key', finality: 'optimistic', account_id: journal.account, public_key: publicKey }),
      ]);
      const nonce = checkedNonce(access, role, options, approval);
      if (!object(block) || !object(block.header) || !isHash(block.header.hash)) throw new Error('keeper_signing_block_invalid');
      const raw = base58Decode(keys[role]!.slice(8));
      const receiver = options[role];
      const signed = signedFunctionCall({ signer: journal.account, seed: raw.subarray(0, 32), publicKey: raw.subarray(32),
        nonce, receiver, blockHash: base58Decode(block.header.hash), method: action.method,
        args: Buffer.from(JSON.stringify(action.args)), gas: action.gas });
      const bytes = Buffer.from(signed, 'base64');
      const hash = base58Encode(createHash('sha256').update(bytes.subarray(0, -65)).digest());
      journal.pending = { hash, receiver, method: action.method, args: action.args, gas: String(action.gas) };
      writeJournal(journalFile, journal);
      sent++;
      usedGas += action.gas;
      try {
        await (input.broadcast ?? (tx => keeperRpc(options.rpc, 'send_tx', { signed_tx_base64: tx, wait_until: 'FINAL' })))(signed);
      } catch { /* The journal stays pending until both providers prove the final outcome. */ }
      if (await recover()) throw new Error('keeper_transaction_failed');
      return 'ok';
    } finally { busy = false; }
  }
  return { beforeBatch, send, recover };
}
