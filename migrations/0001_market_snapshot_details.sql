alter table backend.market_snapshot
  add column if not exists tier text not null default '',
  add column if not exists total_assets numeric(78, 0) not null default 0,
  add column if not exists total_borrows numeric(78, 0) not null default 0,
  add column if not exists reserves numeric(78, 0) not null default 0,
  add column if not exists borrow_apr_bps integer not null default 0,
  add column if not exists supply_apy_bps integer not null default 0,
  add column if not exists block_number numeric(78, 0) not null default 0;

create index if not exists market_snapshot_market_observed_at_idx
  on backend.market_snapshot (market, observed_at);
