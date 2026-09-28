alter table backend.hf_snapshot
  add column if not exists snapshot_id text,
  add column if not exists block_number numeric(78, 0),
  add column if not exists debt_usdg numeric(78, 0),
  add column if not exists debt_usd numeric(78, 0),
  add column if not exists pool_id text,
  add column if not exists borrower text,
  add column if not exists threshold_bps integer,
  add column if not exists bonus_bps integer,
  add column if not exists ramp_active boolean not null default false,
  add column if not exists status text not null default 'error',
  add column if not exists error text;

alter table backend.hf_snapshot alter column health_factor drop not null;
create index if not exists hf_snapshot_latest_idx
  on backend.hf_snapshot (observed_at desc, market, token_id);
create index if not exists hf_snapshot_cycle_idx
  on backend.hf_snapshot (snapshot_id, health_factor asc, token_id asc);
