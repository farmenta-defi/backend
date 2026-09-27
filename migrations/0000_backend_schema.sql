create schema if not exists backend;

create table if not exists backend.hf_snapshot (
  market text not null,
  token_id numeric(78, 0) not null,
  health_factor numeric(78, 0) not null,
  observed_at timestamptz not null default now(),
  primary key (market, token_id, observed_at)
);

create table if not exists backend.market_snapshot (
  market text not null,
  utilization_bps integer not null,
  apy_bps integer not null,
  observed_at timestamptz not null default now(),
  primary key (market, observed_at)
);

create table if not exists backend.service_heartbeat (
  service text primary key,
  observed_at timestamptz not null default now(),
  details jsonb not null default '{}'::jsonb
);
