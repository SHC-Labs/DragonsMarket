import test from "node:test";
import assert from "node:assert/strict";
import { prepareAdministrationProposal, prepareTreasuryVote } from "./treasury.mjs";

const input = {
  treasuryId: "example.sputnik-dao.near",
  contracts: { market: "market.example.near", oracle: "oracle.example.near", council: "council.example.near" },
  target: "council", methodName: "set_allowlist_enabled", args: { enabled: true },
  description: "Enable collection allowlist", proposalBond: "100000000000000000000000",
};

test("administration is proposed to the configured DAO, with a Sputnik FunctionCall and the policy bond", () => {
  const tx = prepareAdministrationProposal(input);
  assert.equal(tx.receiverId, input.treasuryId);
  const call = tx.actions[0].params;
  assert.equal(call.methodName, "add_proposal");
  assert.equal(call.deposit, input.proposalBond);
  const target = call.args.proposal.kind.FunctionCall;
  assert.equal(target.receiver_id, input.contracts.council);
  assert.deepEqual(JSON.parse(Buffer.from(target.actions[0].args, "base64")), { enabled: true });
});

test("missing treasury or policy bond cannot silently fall back to a local owner", () => {
  assert.throws(() => prepareAdministrationProposal({ ...input, treasuryId: undefined }), /account ID/);
  assert.throws(() => prepareAdministrationProposal({ ...input, proposalBond: undefined }), /integer strings/);
  assert.throws(() => prepareAdministrationProposal({ ...input, target: "governance" }), /Unknown/);
});

test("sensitive actions cannot bypass the unfinished execution-delay route", () => {
  for (const methodName of ["upgrade", "seal", "propose_owner", "accept_owner", "set_fee_recipients"]) {
    assert.throws(() => prepareAdministrationProposal({ ...input, methodName }), /execution-delay/);
  }
});

test("votes use act_proposal and bind the original kind rather than the retired vote ABI", () => {
  const kind = prepareAdministrationProposal(input).actions[0].params.args.proposal.kind;
  const tx = prepareTreasuryVote({ treasuryId: input.treasuryId, proposalId: 3, proposalKind: kind, approve: true });
  assert.equal(tx.receiverId, input.treasuryId);
  assert.equal(tx.actions[0].params.methodName, "act_proposal");
  assert.deepEqual(tx.actions[0].params.args, { id: 3, proposal: kind, action: "VoteApprove", memo: null });
  assert.throws(() => prepareTreasuryVote({ treasuryId: input.treasuryId, proposalId: 3, proposalKind: kind }), /explicit/);
});

test("an existing sensitive proposal cannot bypass the delay guard through the vote helper", () => {
  const kind = { FunctionCall: { receiver_id: input.contracts.market, actions: [{ method_name: "upgrade" }] } };
  const vote = { treasuryId: input.treasuryId, proposalId: 3, proposalKind: kind };
  assert.throws(() => prepareTreasuryVote({ ...vote, approve: true }), /execution-delay/);
  assert.equal(prepareTreasuryVote({ ...vote, approve: false }).actions[0].params.args.action, "VoteReject");
});
