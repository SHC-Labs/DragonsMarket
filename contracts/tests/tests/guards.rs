// Source guards. They read the contract sources and manifests, not a chain, so they run with no wasm and fail the build when a
// contract starts to depend on something it must not. Test modules are left out of what they scan, and so are comments.
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

const CONTRACTS: [&str; 6] = ["market", "oracle", "council", "rounds", "price-signatures", "upgrade"];

// The verifier methods that change who may act, what the verifier holds, or how it is run. No contract of ours may call
// any of them as itself: its balance is moved only by mt_transfer and mt_transfer_call, and only the verifier's own roles
// change the rest. The list is the verifier's exported methods less the ones that are views or the receiver hooks.
const FORBIDDEN_VERIFIER_CALLS: [&str; 28] = [
    "add_public_key",
    "remove_public_key",
    "add_full_access_key",
    "add_relayer_key",
    "delete_relayer_key",
    "disable_auth_by_predecessor_id",
    "force_disable_auth_by_predecessor_ids",
    "force_enable_auth_by_predecessor_ids",
    "auth_call",
    "admin_call",
    "execute_intents",
    "simulate_intents",
    "invalidate_salts",
    "update_current_salt",
    "cleanup_nonces",
    "force_lock_account",
    "force_unlock_account",
    "pa_pause_feature",
    "pa_unpause_feature",
    "set_fee_collector",
    "ft_force_withdraw",
    "nft_force_withdraw",
    "mt_force_withdraw",
    "mt_force_transfer",
    "mt_force_transfer_call",
    "mt_force_batch_transfer",
    "mt_force_batch_transfer_call",
    "acl_",
];

// Every cross-contract interface a contract declares, and the methods it declares on each. A new target or a new method
// fails here until it is added on purpose.
const EXPECTED_EXTERNAL_INTERFACES: [(&str, &str, &[&str]); 10] = [
    ("market", "ext_verifier", &["mt_transfer", "mt_transfer_call"]),
    ("market", "ext_oracle", &["register_market"]),
    ("market", "ext_council", &["received_of"]),
    ("council", "ext_verifier", &["mt_transfer"]),
    ("oracle", "ext_verifier", &["mt_transfer"]),
    ("oracle", "ext_market", &["set_outcome"]),
    ("oracle", "ext_council", &["draw", "unlock_case"]),
    ("rounds", "ext_verifier", &["mt_transfer"]),
    ("price-signatures", "", &[]),
    ("upgrade", "", &[]),
];

fn contracts_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn sources_of(contract: &str) -> Vec<(PathBuf, String)> {
    let src = contracts_dir().join(contract).join("src");
    let mut files: Vec<PathBuf> = std::fs::read_dir(&src)
        .unwrap_or_else(|e| panic!("cannot read {src:?}: {e}"))
        .map(|entry| entry.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "rs"))
        .collect();
    files.sort();
    files
        .into_iter()
        .map(|p| {
            let text = std::fs::read_to_string(&p).unwrap();
            let code = code_only(&text);
            (p, code)
        })
        .collect()
}

// The source without its test module, its comments, and nothing else: strings stay, so a message cannot name what the code
// must not.
fn code_only(source: &str) -> String {
    let production = source.split("\n#[cfg(test)]\nmod ").next().unwrap();
    let chars: Vec<char> = production.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        match (c, next) {
            ('/', Some('/')) => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            ('/', Some('*')) => {
                i += 2;
                while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                    i += 1;
                }
                i += 2;
            }
            ('"', _) => {
                out.push(c);
                i += 1;
                while i < chars.len() && chars[i] != '"' {
                    if chars[i] == '\\' {
                        out.push(chars[i]);
                        i += 1;
                    }
                    out.push(chars[i]);
                    i += 1;
                }
                out.push('"');
                i += 1;
            }
            ('\'', Some('\\')) => {
                i += 3;
                while i < chars.len() && chars[i] != '\'' {
                    i += 1;
                }
                i += 1;
            }
            ('\'', Some(_)) if chars.get(i + 2) == Some(&'\'') => i += 3,
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

#[test]
fn the_stripper_keeps_strings_and_drops_comments_and_test_modules() {
    let code = code_only(
        "let a = \"has // inside\"; // gone\nlet b = '\"'; /* gone too */ let c = 1;\n#[cfg(test)]\nconst T: u8 = 0;\nlet d = 2;\n#[cfg(test)]\nmod tests { fn hidden() {} }\n",
    );
    assert!(code.contains("has // inside"));
    assert!(code.contains("let c = 1;"));
    assert!(
        code.contains("let d = 2;"),
        "a test-only item before the test module does not hide the code after it"
    );
    assert!(!code.contains("gone"));
    assert!(!code.contains("hidden"));
}

fn manifest_lines(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("cannot read {path:?}: {e}"))
        .lines()
        .map(|l| l.split('#').next().unwrap().trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

#[test]
fn no_contract_depends_on_a_governance_crate() {
    for contract in CONTRACTS {
        let manifest = contracts_dir().join(contract).join("Cargo.toml");
        for line in manifest_lines(&manifest) {
            assert!(
                !line.to_lowercase().contains("governance"),
                "{contract} depends on a governance crate: {line}"
            );
        }
    }
    for line in manifest_lines(&contracts_dir().join("Cargo.toml")) {
        assert!(
            !line.to_lowercase().contains("governance"),
            "the workspace names a governance crate: {line}"
        );
    }
    let lock = std::fs::read_to_string(contracts_dir().join("Cargo.lock")).unwrap();
    assert!(
        !lock.lines().any(|l| l.trim() == "name = \"governance\""),
        "Cargo.lock holds a governance package"
    );
    assert!(
        !contracts_dir().join("governance").exists(),
        "the retired governance crate is back in the tree"
    );
}

#[test]
fn no_contract_code_names_governance() {
    for contract in CONTRACTS {
        for (path, code) in sources_of(contract) {
            for (n, line) in code.lines().enumerate() {
                assert!(
                    !line.to_lowercase().contains("governance"),
                    "{path:?}:{}: code that is not a comment names governance: {line}",
                    n + 1
                );
            }
        }
    }
}

// Reads the `#[ext_contract(name)]` traits of a source: each with the methods it declares.
fn external_interfaces(code: &str) -> Vec<(String, BTreeSet<String>)> {
    let mut found = vec![];
    let mut rest = code;
    while let Some(at) = rest.find("#[ext_contract(") {
        rest = &rest[at + "#[ext_contract(".len()..];
        let name = rest[..rest.find(')').unwrap()].trim().to_string();
        let open = rest.find('{').unwrap();
        let mut depth = 0;
        let mut end = open;
        for (i, c) in rest[open..].char_indices() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = open + i;
                        break;
                    }
                }
                _ => {}
            }
        }
        let body = &rest[open..end];
        let methods = body
            .split("fn ")
            .skip(1)
            .map(|m| {
                m.split(|c: char| !(c.is_alphanumeric() || c == '_'))
                    .next()
                    .unwrap()
                    .to_string()
            })
            .collect();
        found.push((name, methods));
        rest = &rest[end..];
    }
    found
}

#[test]
fn the_cross_contract_interfaces_are_exactly_the_expected_ones() {
    for contract in CONTRACTS {
        let mut declared: Vec<(String, BTreeSet<String>)> = vec![];
        for (_, code) in sources_of(contract) {
            declared.extend(external_interfaces(&code));
        }
        let expected: Vec<(String, BTreeSet<String>)> = EXPECTED_EXTERNAL_INTERFACES
            .iter()
            .filter(|(c, name, _)| *c == contract && !name.is_empty())
            .map(|(_, name, methods)| (name.to_string(), methods.iter().map(|m| m.to_string()).collect()))
            .collect();
        assert_eq!(
            declared, expected,
            "{contract} declares a cross-contract interface the guard does not expect"
        );
    }
}

#[test]
fn the_verifier_is_only_ever_asked_to_transfer() {
    for (contract, interface, methods) in EXPECTED_EXTERNAL_INTERFACES {
        if interface == "ext_verifier" {
            assert!(
                methods.iter().all(|m| m.starts_with("mt_transfer")),
                "{contract} asks the verifier for more than a transfer: {methods:?}"
            );
        }
    }
}

#[test]
fn no_contract_code_calls_a_verifier_admin_method() {
    for contract in CONTRACTS {
        for (path, code) in sources_of(contract) {
            for (n, line) in code.lines().enumerate() {
                for forbidden in FORBIDDEN_VERIFIER_CALLS {
                    assert!(
                        !line.contains(forbidden),
                        "{path:?}:{}: names the verifier admin call {forbidden}: {line}",
                        n + 1
                    );
                }
            }
        }
    }
}

// The oracle holds bonds in its own Intents account. Money reaches it through the verifier's mt_on_transfer and leaves by one
// mt_transfer, from withdraw_bond, to the account that owns the claim. It never speaks NEP-141 and never starts a transfer call.
#[test]
fn the_oracle_takes_bonds_through_the_verifier_and_pays_them_out_by_one_mt_transfer() {
    let sources = sources_of("oracle");
    let code: String = sources.iter().map(|(_, code)| code.as_str()).collect();
    assert!(
        code.contains("pub fn mt_on_transfer("),
        "the oracle has no verifier hook"
    );
    for nep141 in [
        "ft_on_transfer",
        "ft_transfer",
        "ft_balance_of",
        "ext_ft",
        "bond_token",
        "mt_transfer_call",
        "mt_batch_transfer",
    ] {
        assert!(!code.contains(nep141), "the oracle code names {nep141}");
    }
    assert_eq!(
        code.matches(".mt_transfer(").count(),
        1,
        "the oracle pays out by exactly one verifier call, in withdraw_bond"
    );
    let withdraw = code
        .split("pub fn withdraw_bond(")
        .nth(1)
        .expect("the oracle has withdraw_bond")
        .split("pub fn on_bond_withdrawn(")
        .next()
        .unwrap();
    assert!(
        withdraw.contains(".mt_transfer(") && withdraw.contains("env::predecessor_account_id()"),
        "the payout is made from withdraw_bond, to the caller's own claim"
    );
}

// Bonds and juror pay are not holder revenue. The Council's revenue message never appears in the oracle's code.
#[test]
fn the_oracle_never_names_holder_revenue() {
    for (path, code) in sources_of("oracle") {
        for (n, line) in code.lines().enumerate() {
            assert!(
                !line.to_lowercase().contains("revenue"),
                "{path:?}:{}: the oracle code names revenue: {line}",
                n + 1
            );
        }
    }
}

// Reward money leaves the Council by one path. Its only verifier call is the payout of a claim, so a holder cannot be paid
// through a second route, and an unstake, a forfeit or a finalization moves no money.
#[test]
fn the_council_pays_reward_money_only_in_a_quarter_claim() {
    let sources = sources_of("council");
    let code: String = sources.iter().map(|(_, code)| code.as_str()).collect();
    assert_eq!(
        code.matches(".mt_transfer(").count(),
        1,
        "the Council makes exactly one verifier payout call"
    );
    assert_eq!(code.matches("self.pay(").count(), 1, "and one caller of it");
    let claim = code
        .split("pub fn claim_quarter(")
        .nth(1)
        .expect("the Council has claim_quarter")
        .split("pub fn on_claim_paid(")
        .next()
        .unwrap();
    assert!(claim.contains("self.pay("), "the payout is made from claim_quarter");
    for removed in ["pub fn claim(", "pending_reward", "acc_per_seat", "Stream"] {
        assert!(!code.contains(removed), "the Council code still has {removed}");
    }
}

// Stakes and winnings leave the rounds contract by one path: a withdrawal of an account's own balance to its own Intents
// account. A claim only moves a payout into that balance.
#[test]
fn the_rounds_contract_pays_out_only_in_a_withdrawal_to_the_account_itself() {
    let sources = sources_of("rounds");
    let code: String = sources.iter().map(|(_, code)| code.as_str()).collect();
    assert_eq!(
        code.matches(".mt_transfer(").count(),
        1,
        "the rounds contract makes exactly one verifier payout call"
    );
    let withdraw = code
        .split("fn withdraw_for(")
        .nth(1)
        .expect("the rounds contract has withdraw_for")
        .split("fn close_withdrawal(")
        .next()
        .unwrap();
    assert!(
        withdraw.contains("self.debit(&who, amount)") && withdraw.contains(".mt_transfer(who,"),
        "the payout goes to the account whose balance it came out of"
    );
    for nep141 in ["ft_on_transfer", "ft_transfer", "mt_transfer_call", "mt_batch_transfer"] {
        assert!(!code.contains(nep141), "the rounds code names {nep141}");
    }
}

#[test]
fn the_market_sends_the_token_only_to_its_own_intents_account() {
    let sources = sources_of("market");
    let code: String = sources.iter().map(|(_, code)| code.as_str()).collect();
    assert_eq!(
        code.matches(".ft_transfer_call(").count(),
        1,
        "the market makes exactly one token call"
    );
    assert!(
        !code.contains(".ft_transfer("),
        "the market never sends the token itself"
    );
    let hook: String = code
        .split("impl FungibleTokenReceiver for MarketContract {")
        .nth(1)
        .expect("the market takes the token through the standard receiver")
        .split("\n}\n")
        .next()
        .unwrap()
        .split_whitespace()
        .collect();
    assert!(
        hook.contains("ext_ft_core::ext(token)"),
        "the token is called through the standard interface"
    );
    assert!(
        hook.contains(".ft_transfer_call(self.verifier.clone(),amount,None,env::current_account_id().to_string(),)"),
        "the token goes whole to the verifier, into the market's own account"
    );
}

// The fee split is expressed in basis points the owner can set. No account id is written in the market's or the Council's code,
// so nothing the owner has still to choose is hardcoded.
#[test]
fn no_contract_names_an_account_the_owner_has_still_to_choose() {
    for contract in ["market", "council", "rounds"] {
        for (path, code) in sources_of(contract) {
            for (n, line) in code.lines().enumerate() {
                for literal in [".near\"", ".testnet\"", "trezu"] {
                    assert!(
                        !line.contains(literal),
                        "{path:?}:{}: an account id is written in the code: {line}",
                        n + 1
                    );
                }
            }
        }
    }
}
