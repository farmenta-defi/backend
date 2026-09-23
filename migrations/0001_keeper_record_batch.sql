create schema if not exists backend;

create table if not exists backend.keeper_record_batch_run (
  id bigserial primary key,
  ran_at timestamptz not null,
  pool_count integer not null check (pool_count >= 0),
  gas_used numeric(78, 0) not null check (gas_used >= 0),
  gas_cost_usd numeric(20, 8) not null check (gas_cost_usd >= 0),
  budget_usd numeric(20, 8) not null check (budget_usd >= 0),
  transaction_hash text not null unique
);

create index if not exists keeper_record_batch_run_ran_at_idx
  on backend.keeper_record_batch_run (ran_at);

create table if not exists backend.service_heartbeat (
  service text primary key,
  observed_at timestamptz not null
);

create table if not exists backend.keeper_alert (
  alert_key text primary key,
  sent_at timestamptz not null
);
