ALTER TABLE wallet_challenges
 ADD COLUMN wallet_type text NOT NULL DEFAULT 'near',
 ADD COLUMN evm_chain_id bigint,
 ADD CONSTRAINT wallet_challenge_identity CHECK (
  (wallet_type = 'near' AND evm_chain_id IS NULL AND account_id !~ ':') OR
  (wallet_type = 'evm' AND evm_chain_id IS NOT NULL AND evm_chain_id BETWEEN 1 AND 9007199254740991 AND
   account_id ~ ('^eip155:' || evm_chain_id::text || ':0x[0-9a-f]{40}$'))
 );

ALTER TABLE wallet_sessions
 ADD COLUMN wallet_type text NOT NULL DEFAULT 'near',
 ADD COLUMN evm_chain_id bigint,
 ADD CONSTRAINT wallet_session_identity CHECK (
  (wallet_type = 'near' AND evm_chain_id IS NULL AND account_id !~ ':') OR
  (wallet_type = 'evm' AND evm_chain_id IS NOT NULL AND evm_chain_id BETWEEN 1 AND 9007199254740991 AND
   account_id ~ ('^eip155:' || evm_chain_id::text || ':0x[0-9a-f]{40}$') AND
   public_key ~ '^0x[0-9a-f]{128}$')
 );
