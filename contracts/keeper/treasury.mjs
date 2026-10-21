// Prepare wallet requests for the configured Trezu/Sputnik DAO. Never signs or submits them.
// ABI: near-daos/sputnik-dao-contract, revision 5434a59dec23ee0c49df8c8c4350c208a7e75b0b.
const TGAS = 10n ** 12n;
const SENSITIVE = new Set(["upgrade", "seal", "propose_owner", "accept_owner", "set_fee_recipients"]);

function accountId(value) {
  if (typeof value !== "string" || value.length < 2 || value.length > 64 ||
      !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value)) {
    throw new Error("A verified NEAR account ID is required; there is no default treasury");
  }
  return value;
}

function units(value) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("Amounts must be base-unit integer strings");
  }
  if (BigInt(value) >= 2n ** 128n) throw new Error("Amount exceeds u128");
  return value;
}

export function prepareAdministrationProposal({
  treasuryId, contracts, target, methodName, args, description, proposalBond,
  gasTgas = 30, depositYocto = "0",
}) {
  const dao = accountId(treasuryId);
  if (!["market", "oracle", "council"].includes(target)) throw new Error("Unknown application target");
  const receiver = accountId(contracts?.[target]);
  if (receiver === dao) throw new Error("The application target cannot be the treasury itself");
  if (typeof methodName !== "string" || !/^[a-z][a-z0-9_]*$/.test(methodName)) {
    throw new Error("Invalid method name");
  }
  if (SENSITIVE.has(methodName)) {
    throw new Error("Sensitive administration needs the reviewed execution-delay route; preparation is disabled");
  }
  if (!Number.isInteger(gasTgas) || gasTgas < 5 || gasTgas > 250) throw new Error("Invalid target gas budget");
  if (typeof description !== "string" || !description.trim()) throw new Error("A proposal description is required");
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  const proposal = {
    description,
    kind: {
      FunctionCall: {
        receiver_id: receiver,
        actions: [{
          method_name: methodName,
          args: Buffer.from(JSON.stringify(args)).toString("base64"),
          deposit: units(depositYocto),
          gas: (BigInt(gasTgas) * TGAS).toString(),
        }],
      },
    },
  };
  return {
    receiverId: dao,
    actions: [{
      type: "FunctionCall",
      params: {
        methodName: "add_proposal", args: { proposal },
        gas: (300n * TGAS).toString(), deposit: units(proposalBond),
      },
    }],
  };
}

// The kind must be the unchanged kind returned by get_proposal on the selected DAO.
export function prepareTreasuryVote({ treasuryId, proposalId, proposalKind, approve }) {
  if (!Number.isSafeInteger(proposalId) || proposalId < 0) throw new Error("Invalid proposal ID");
  if (typeof approve !== "boolean") throw new Error("An explicit approval decision is required");
  if (!proposalKind || typeof proposalKind !== "object" || Array.isArray(proposalKind) ||
      Object.keys(proposalKind).length !== 1) throw new Error("Use the DAO's original proposal kind");
  if (approve && (proposalKind.UpgradeSelf || proposalKind.UpgradeRemote || proposalKind.ChangePolicy ||
      proposalKind.FunctionCall?.actions?.some(action => SENSITIVE.has(action.method_name)))) {
    throw new Error("Sensitive approval needs the reviewed execution-delay route; approval is disabled");
  }
  return {
    receiverId: accountId(treasuryId),
    actions: [{
      type: "FunctionCall",
      params: {
        methodName: "act_proposal",
        args: {
          id: proposalId, proposal: proposalKind,
          action: approve ? "VoteApprove" : "VoteReject", memo: null,
        },
        gas: (300n * TGAS).toString(), deposit: "0",
      },
    }],
  };
}
