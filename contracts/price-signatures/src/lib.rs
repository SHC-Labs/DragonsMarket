// The publisher signature check the oracle makes on a signed price, for any contract that settles on k of n publishers. A
// submission lists `<publisher key>.<signature in hex>` entries separated by commas, each over the caller's own message.

use near_sdk::{env, require, CurveType, PublicKey};

pub fn validate_publishers(publishers: &[PublicKey], threshold: u32, maximum: usize) {
    require!(
        !publishers.is_empty() && publishers.len() <= maximum,
        "publisher count outside limits"
    );
    require!(
        threshold > 0 && threshold as usize <= publishers.len(),
        "the threshold must be between 1 and the number of publishers"
    );
    require!(
        2 * threshold as usize > publishers.len(),
        "the threshold must be more than half of the publishers"
    );
    for (i, key) in publishers.iter().enumerate() {
        require!(key.curve_type() == CurveType::ED25519, "publishers use ed25519 keys");
        require!(!publishers[..i].contains(key), "duplicate publisher");
    }
}

pub fn decode_signature(hex: &str) -> [u8; 64] {
    require!(hex.len() == 128 && hex.is_ascii(), "a signature is 128 hex characters");
    let mut signature = [0u8; 64];
    for (i, byte) in signature.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap_or_else(|_| env::panic_str("a signature is hex"));
    }
    signature
}

// The different publishers who signed `message`, in the order they were given. Any entry that is malformed, from a key that
// is not a publisher, repeated, or that does not verify refuses the whole submission.
pub fn verified_signers(publishers: &[PublicKey], message: &str, signatures: &str) -> Vec<PublicKey> {
    let mut seen: Vec<PublicKey> = vec![];
    for entry in signatures.split(',') {
        let (key, signature) = entry
            .rsplit_once('.')
            .unwrap_or_else(|| env::panic_str("a signature is <publisher key>.<hex>"));
        let key: PublicKey = key.parse().unwrap_or_else(|_| env::panic_str("bad publisher key"));
        require!(publishers.contains(&key), "not a publisher");
        require!(!seen.contains(&key), "a publisher signed twice");
        let raw: [u8; 32] = key.as_bytes()[1..]
            .try_into()
            .unwrap_or_else(|_| env::panic_str("publishers use ed25519 keys"));
        require!(
            env::ed25519_verify(&decode_signature(signature), message.as_bytes(), &raw),
            "a signature does not match"
        );
        seen.push(key);
    }
    seen
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, CurveType};

    const MESSAGE: &str = "price:at:1250";

    fn key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn public(key: &SigningKey) -> PublicKey {
        PublicKey::from_parts(CurveType::ED25519, key.verifying_key().to_bytes().to_vec()).unwrap()
    }

    fn entry(signer: &SigningKey, message: &str) -> String {
        let signature: String = signer
            .sign(message.as_bytes())
            .to_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        format!("{}.{signature}", public(signer))
    }

    fn publishers() -> Vec<PublicKey> {
        testing_env!(VMContextBuilder::new().build());
        (1..=3).map(|s| public(&key(s))).collect()
    }

    fn refusal(publishers: &[PublicKey], signatures: &str) -> String {
        let caught = std::panic::catch_unwind(|| verified_signers(publishers, MESSAGE, signatures));
        let payload = caught.expect_err("the submission is refused");
        payload
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap()
    }

    #[test]
    fn every_publisher_who_signed_the_message_is_named_in_the_order_given() {
        let publishers = publishers();
        let signatures = [entry(&key(3), MESSAGE), entry(&key(1), MESSAGE)].join(",");
        assert_eq!(
            verified_signers(&publishers, MESSAGE, &signatures),
            vec![public(&key(3)), public(&key(1))]
        );
    }

    #[test]
    fn one_bad_entry_refuses_the_whole_submission() {
        let publishers = publishers();
        let good = entry(&key(1), MESSAGE);
        let cases = [
            (format!("{good},{}", entry(&key(9), MESSAGE)), "not a publisher"),
            (format!("{good},{good}"), "a publisher signed twice"),
            (
                format!("{good},{}", entry(&key(2), "price:at:1251")),
                "a signature does not match",
            ),
            (
                format!("{good},{}", public(&key(2))),
                "a signature is <publisher key>.<hex>",
            ),
            (format!("{good},nobody.{}", "0".repeat(128)), "bad publisher key"),
            (
                format!("{good},{}.abc", public(&key(2))),
                "a signature is 128 hex characters",
            ),
            (
                format!("{good},{}.{}", public(&key(2)), "zz".repeat(64)),
                "a signature is hex",
            ),
        ];
        for (signatures, expected) in cases {
            assert!(
                refusal(&publishers, &signatures).contains(expected),
                "{signatures} should fail with {expected}"
            );
        }
    }

    #[test]
    fn a_secp256k1_publisher_key_cannot_be_checked_as_ed25519() {
        testing_env!(VMContextBuilder::new().build());
        let secp = PublicKey::from_parts(CurveType::SECP256K1, vec![7; 64]).unwrap();
        let signatures = format!("{secp}.{}", "0".repeat(128));
        assert!(refusal(&[secp], &signatures).contains("publishers use ed25519 keys"));
    }
}
