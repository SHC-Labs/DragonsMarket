import test from 'node:test';
import assert from 'node:assert/strict';
import { captureEvidence, compareEvidence, parseEvidence } from './recovery-evidence.mjs';
import { projectId, environmentId } from './release.mjs';

function fixture() {
  return [
    { kind: 'identity', format: 3, database: 'railway', version: '180006', readOnly: 'on', tables: 1, sequences: 1 },
    { kind: 'table', name: 'evidence', rows: 1, complete: true, sha256: 'a'.repeat(64) },
    { kind: 'sequence', name: 'evidence_id_seq', lastValue: '900719925474099301', isCalled: true },
    ...['columns', 'indexes', 'constraints', 'functions', 'triggers', 'relations', 'sequence_definitions',
      'schema', 'roles', 'memberships', 'defaults', 'policies', 'role_settings', 'database'].map(name =>
      ({ kind: 'catalog', name, entries: 1, sha256: 'b'.repeat(64) })),
    { kind: 'complete', format: 3 },
  ];
}

const encode = records => records.map(record => JSON.stringify(record)).join('\r\n');

test('recovery evidence requires complete bounded inventories and a read-only snapshot', () => {
  assert.deepEqual(parseEvidence(encode(fixture())), fixture());
  const changes = [
    records => records.pop(),
    records => records.splice(1, 1),
    records => records.splice(2, 1),
    records => records.splice(3, 1),
    records => records.splice(3, 0, records[3]),
    records => { records[0].readOnly = 'off'; },
    records => { records[0].version = '160000'; },
    records => { records[0].format = 1; records.at(-1).format = 1; },
    records => { records[0].format = 2; records.at(-1).format = 2; },
    records => { records.find(record => record.name === 'sequence_definitions').entries = 0; },
    records => { records[1].complete = false; },
    records => { records[1].rows = 100001; },
    records => { records[1].sha256 = 'invalid'; },
    records => { records[2].lastValue = 'invalid'; },
    records => { records[3].entries = -1; },
    records => { records[4].name = records[3].name; },
    records => records.splice(3, 0, { kind: 'unexpected' }),
  ];
  for (const change of changes) {
    const records = fixture();
    change(records);
    assert.throws(() => parseEvidence(encode(records)));
  }
  assert.throws(() => parseEvidence('connection failed'));
});

test('capture uses only the fixed production Postgres SSH target and disables prompts', () => {
  const result = captureEvidence((binary, args, options) => {
    assert.equal(binary, 'railway');
    assert.deepEqual(args.slice(0, -1), ['ssh', '--project', projectId, '--environment', environmentId,
      '--service', '130e30b5-c8b3-4a63-ae2f-2cc1e0901fc0', '--']);
    const command = args.at(-1);
    assert.match(command, /--pset=pager=off --no-password --set=ON_ERROR_STOP=1/);
    const payload = command.match(/^printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d \| psql /)?.[1];
    assert.ok(payload);
    const sql = Buffer.from(payload, 'base64').toString();
    assert.match(sql, /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/);
    assert.match(sql, /ROLLBACK;\s*$/);
    assert.equal(options.timeout, 180000);
    return encode(fixture());
  });
  assert.deepEqual(result, fixture());
});

test('comparison refuses data, sequence, permission and database identity changes', () => {
  compareEvidence(fixture(), fixture());
  for (const [index, field, value] of [[0, 'database', 'other'], [1, 'sha256', 'c'.repeat(64)],
    [2, 'lastValue', '900719925474099302'], [3, 'sha256', 'd'.repeat(64)]]) {
    const after = fixture();
    after[index][field] = value;
    assert.throws(() => compareEvidence(fixture(), after), /differs/);
  }
  const after = fixture();
  after.find(record => record.name === 'sequence_definitions').sha256 = 'e'.repeat(64);
  assert.throws(() => compareEvidence(fixture(), after), /differs/);
});
