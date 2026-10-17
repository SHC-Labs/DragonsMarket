-- Off-chain database for the live product (matching service, indexer, API).
-- The pitch test does NOT use this: it reads everything from the chain.
-- Money is integer micro-units of the collateral token (6 decimals): 1_000_000 = 1.00.
-- Shares are integer micro-shares. Prices are whole cents, 1 to 99.
-- Access rules: data-layer checks in the API (no row level security). Two Postgres roles:
-- pm_app (read/write) and pm_readonly (select only, for dashboards and surveillance).
-- The chain is the source of truth for balances, positions and outcomes. This is a fast copy.

create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create table users (
  id uuid primary key default gen_random_uuid(),
  near_account text not null unique,
  kyc_status text not null default 'none'
    check (kyc_status in ('none','pending','verified','rejected')),
  region text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table trade_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  public_key text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on trade_keys (user_id);

create table events (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  category text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table markets (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete restrict,
  chain_market_id bigint unique,
  question text not null,
  rule_text text not null,
  rule_hash text not null,
  resolution_source text not null,
  void_policy text not null,
  state text not null default 'draft'
    check (state in ('draft','review','rejected','open','halted','closed','proposed','disputed','final','void')),
  fee_category text not null default 'general',
  close_at timestamptz not null,
  resolve_by timestamptz not null,
  outcome text check (outcome in ('yes','no','void')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint resolve_after_close check (resolve_by > close_at),
  constraint outcome_only_when_done check (outcome is null or state in ('final','void'))
);
create index on markets (event_id);
create index on markets (state, close_at);

create table orders (
  id uuid primary key default gen_random_uuid(),
  market_id uuid not null references markets(id) on delete restrict,
  user_id uuid not null references users(id) on delete restrict,
  trade_key_id uuid not null references trade_keys(id) on delete restrict,
  outcome text not null check (outcome in ('yes','no')),
  side text not null check (side in ('buy','sell')),
  type text not null check (type in ('gtc','gtd','fok','fak','post_only')),
  price_cents smallint not null check (price_cents between 1 and 99),
  size_micro bigint not null check (size_micro > 0),
  filled_micro bigint not null default 0,
  status text not null default 'live'
    check (status in ('live','partially_filled','filled','cancelled','expired','rejected')),
  nonce bigint not null,
  expires_at timestamptz not null,
  signature text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint filled_within_size check (filled_micro >= 0 and filled_micro <= size_micro),
  constraint nonce_once_per_user unique (user_id, nonce)
);
create index on orders (market_id, status, price_cents);
create index on orders (user_id, status);
create index on orders (trade_key_id);

create table trades (
  id uuid primary key default gen_random_uuid(),
  market_id uuid not null references markets(id) on delete restrict,
  taker_order_id uuid not null references orders(id) on delete restrict,
  maker_order_id uuid not null references orders(id) on delete restrict,
  price_cents smallint not null check (price_cents between 1 and 99),
  size_micro bigint not null check (size_micro > 0),
  fee_micro bigint not null default 0 check (fee_micro >= 0),
  status text not null default 'matched'
    check (status in ('matched','submitted','confirmed','failed')),
  tx_hash text,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint different_orders check (taker_order_id <> maker_order_id)
);
create index on trades (market_id, created_at);
create index on trades (taker_order_id);
create index on trades (maker_order_id);
create index on trades (status);

create table settlement_queue (
  id uuid primary key default gen_random_uuid(),
  trade_id uuid not null unique references trades(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending','sent','done','failed')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on settlement_queue (status, created_at);

create table positions (
  user_id uuid not null references users(id) on delete restrict,
  market_id uuid not null references markets(id) on delete restrict,
  outcome text not null check (outcome in ('yes','no')),
  balance_micro bigint not null default 0 check (balance_micro >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, market_id, outcome)
);
create index on positions (market_id);

create table balances (
  user_id uuid primary key references users(id) on delete restrict,
  free_micro bigint not null default 0 check (free_micro >= 0),
  locked_micro bigint not null default 0 check (locked_micro >= 0),
  updated_at timestamptz not null default now()
);

-- Append-only journal. Every change to balances has a row here, so the two can be reconciled.
create table ledger_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete restrict,
  kind text not null
    check (kind in ('deposit','withdrawal','lock','unlock','trade','fee','redeem','adjustment')),
  amount_micro bigint not null,
  ref_type text,
  ref_id uuid,
  created_at timestamptz not null default now()
);
create index on ledger_entries (user_id, created_at);
create index on ledger_entries (ref_type, ref_id);

create table deposits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete restrict,
  origin_chain text not null,
  origin_asset text not null,
  quote_id text unique,
  deposit_address text,
  amount_credited_micro bigint check (amount_credited_micro > 0),
  status text not null default 'quoted'
    check (status in ('quoted','awaiting_funds','processing','credited','refunded','failed')),
  intents_ref text unique,
  created_at timestamptz not null default now(),
  credited_at timestamptz,
  updated_at timestamptz not null default now()
);
create index on deposits (user_id, created_at);
create index on deposits (status);

create table withdrawals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete restrict,
  dest_chain text not null,
  dest_address text not null,
  amount_micro bigint not null check (amount_micro > 0),
  status text not null default 'requested'
    check (status in ('requested','sent','confirmed','failed')),
  intents_ref text unique,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  confirmed_at timestamptz,
  updated_at timestamptz not null default now()
);
create index on withdrawals (user_id, created_at);
create index on withdrawals (status);

-- Measured payout times, for the published withdrawal promise.
create view withdrawal_times as
  select id, dest_chain, confirmed_at - created_at as total_time
  from withdrawals
  where status = 'confirmed';

create table resolutions (
  market_id uuid primary key references markets(id) on delete restrict,
  proposer text not null,
  evidence_url text,
  proposed_outcome text not null check (proposed_outcome in ('yes','no','void')),
  bond_micro bigint not null check (bond_micro > 0),
  window_ends_at timestamptz not null,
  challenger text,
  challenge_bond_micro bigint check (challenge_bond_micro > 0),
  final_outcome text check (final_outcome in ('yes','no','void')),
  finalised_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table panel_votes (
  id uuid primary key default gen_random_uuid(),
  market_id uuid not null references markets(id) on delete restrict,
  panelist text not null,
  vote text not null check (vote in ('yes','no','void')),
  reason text not null,
  created_at timestamptz not null default now(),
  constraint one_vote_each unique (market_id, panelist)
);

create table admin_log (
  id uuid primary key default gen_random_uuid(),
  admin text not null,
  action text not null,
  target text not null,
  reason text not null,
  created_at timestamptz not null default now()
);
create index on admin_log (created_at);

create table alerts (
  id uuid primary key default gen_random_uuid(),
  market_id uuid references markets(id) on delete set null,
  user_id uuid references users(id) on delete set null,
  rule text not null,
  status text not null default 'open' check (status in ('open','reviewing','closed')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on alerts (status, created_at);

-- One row per event log line read from the chain. The unique key makes the indexer safe to replay.
create table chain_events (
  id uuid primary key default gen_random_uuid(),
  block_height bigint not null,
  tx_hash text,
  receipt_id text not null,
  event_index integer not null check (event_index >= 0),
  event jsonb not null,
  created_at timestamptz not null default now(),
  constraint once_per_receipt unique (receipt_id, event_index)
);
create index on chain_events (block_height);

-- Admin log and ledger can only be added to, never edited or removed.
create function forbid_change() returns trigger as $$
begin
  raise exception '% is append-only', tg_table_name;
end;
$$ language plpgsql;

create trigger admin_log_append_only before update or delete on admin_log
  for each row execute function forbid_change();
create trigger ledger_append_only before update or delete on ledger_entries
  for each row execute function forbid_change();

do $$
declare t text;
begin
  foreach t in array array['users','trade_keys','events','markets','orders','trades',
    'settlement_queue','positions','balances','deposits','withdrawals','resolutions','alerts']
  loop
    execute format('create trigger %I_updated before update on %I for each row execute function set_updated_at()', t, t);
  end loop;
end $$;
