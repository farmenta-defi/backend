import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { SettingsService } from '../config/settings.service.js';

export type Snapshot = {
  market: string;
  tier: string;
  totalAssets: string;
  totalBorrows: string;
  reserves: string;
  utilizationBps: number;
  borrowAprBps: number;
  supplyApyBps: number;
  blockNumber: string;
  observedAt: string;
};

export type HealthFactorRow = {
  market: string;
  tokenId: string;
  healthFactor: string | null;
  debtUsdg: string | null;
  debtUsd: string | null;
  poolId: string | null;
  borrower: string | null;
  thresholdBps: number | null;
  bonusBps: number | null;
  rampActive: boolean;
  status: 'liquidatable' | 'at-risk' | 'warning' | 'healthy' | 'error';
  error: string | null;
};

@Injectable()
export class MarketRepository implements OnModuleDestroy {
  private readonly pool: Pool;
  constructor(settings: SettingsService) {
    this.pool = new Pool({ connectionString: settings.databaseUrl });
  }
  async insert(snapshot: Snapshot) {
    await this.pool.query(
      `insert into backend.market_snapshot (market,tier,total_assets,total_borrows,reserves,utilization_bps,borrow_apr_bps,supply_apy_bps,block_number,observed_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        snapshot.market,
        snapshot.tier,
        snapshot.totalAssets,
        snapshot.totalBorrows,
        snapshot.reserves,
        snapshot.utilizationBps,
        snapshot.borrowAprBps,
        snapshot.supplyApyBps,
        snapshot.blockNumber,
        snapshot.observedAt,
      ],
    );
  }

  async insertHealthFactors(
    rows: HealthFactorRow[],
    blockNumber: bigint,
    observedAt: Date,
    snapshotId: string,
  ) {
    for (let start = 0; start < rows.length; start += 1000) {
      const batch = rows.slice(start, start + 1000);
      const values: unknown[] = [];
      const tuples = batch.map((row, index) => {
        const offset = index * 15;
        values.push(
          row.market,
          row.tokenId,
          row.healthFactor,
          observedAt,
          snapshotId,
          blockNumber.toString(),
          row.debtUsdg,
          row.debtUsd,
          row.poolId,
          row.borrower,
          row.thresholdBps,
          row.bonusBps,
          row.rampActive,
          row.status,
          row.error,
        );
        return `(${Array.from({ length: 15 }, (_, i) => `$${offset + i + 1}`).join(',')})`;
      });
      await this.pool.query(
        `insert into backend.hf_snapshot (market,token_id,health_factor,observed_at,snapshot_id,block_number,debt_usdg,debt_usd,pool_id,borrower,threshold_bps,bonus_bps,ramp_active,status,error) values ${tuples.join(',')} on conflict (market,token_id,observed_at) do update set health_factor=excluded.health_factor,snapshot_id=excluded.snapshot_id,block_number=excluded.block_number,debt_usdg=excluded.debt_usdg,debt_usd=excluded.debt_usd,pool_id=excluded.pool_id,borrower=excluded.borrower,threshold_bps=excluded.threshold_bps,bonus_bps=excluded.bonus_bps,ramp_active=excluded.ramp_active,status=excluded.status,error=excluded.error`,
        values,
      );
    }
  }

  async latestHealthFactors(snapshotId?: string) {
    const { rows } = await this.pool.query<
      HealthFactorRow & {
        blockNumber: string;
        observedAt: Date;
      }
    >(
      snapshotId
        ? `select market, token_id::text as "tokenId", health_factor::text as "healthFactor", debt_usdg::text as "debtUsdg", debt_usd::text as "debtUsd", pool_id as "poolId", borrower, threshold_bps as "thresholdBps", bonus_bps as "bonusBps", ramp_active as "rampActive", status, error, block_number::text as "blockNumber", observed_at as "observedAt" from backend.hf_snapshot where snapshot_id=$1 order by health_factor asc nulls last, token_id asc`
        : `with latest as (select max(observed_at) observed_at from backend.hf_snapshot) select market, token_id::text as "tokenId", health_factor::text as "healthFactor", debt_usdg::text as "debtUsdg", debt_usd::text as "debtUsd", pool_id as "poolId", borrower, threshold_bps as "thresholdBps", bonus_bps as "bonusBps", ramp_active as "rampActive", status, error, block_number::text as "blockNumber", observed_at as "observedAt" from backend.hf_snapshot where observed_at = (select observed_at from latest) order by health_factor asc nulls last, token_id asc`,
      snapshotId ? [snapshotId] : [],
    );
    return rows;
  }

  async pruneHealthFactors(before: Date) {
    await this.pool.query(
      `delete from backend.hf_snapshot where observed_at < $1::timestamptz - interval '24 hours'`,
      [before],
    );
  }

  async heartbeat(observedAt: Date, details: Record<string, unknown>) {
    await this.pool.query(
      `insert into backend.service_heartbeat (service,observed_at,details) values ('backend-hf-snapshot',$1,$2::jsonb) on conflict (service) do update set observed_at=excluded.observed_at, details=excluded.details`,
      [observedAt, JSON.stringify(details)],
    );
  }

  async latestHealthFactorHeartbeat() {
    const { rows } = await this.pool.query<{
      observedAt: Date;
      details: { blockNumber?: string; snapshotId?: string };
    }>(
      `select observed_at as "observedAt", details from backend.service_heartbeat where service='backend-hf-snapshot'`,
    );
    return rows[0];
  }
  async history(
    market: string,
    range: HistoryRange = '1w',
  ): Promise<Snapshot[]> {
    const { interval, origin } = ranges[range];
    const { rows } = await this.pool.query<Snapshot>(
      `select market, min(tier) as tier, round(avg(total_assets))::numeric(78,0)::text as "totalAssets", round(avg(total_borrows))::numeric(78,0)::text as "totalBorrows", round(avg(reserves))::numeric(78,0)::text as reserves, round(avg(utilization_bps))::integer as "utilizationBps", round(avg(borrow_apr_bps))::integer as "borrowAprBps", round(avg(supply_apy_bps))::integer as "supplyApyBps", max(block_number)::text as "blockNumber", date_bin($2::interval, observed_at, 'epoch') as "observedAt" from backend.market_snapshot where market=$1 and observed_at >= now() - $3::interval group by market, date_bin($2::interval, observed_at, 'epoch') order by "observedAt" asc`,
      [market, interval, origin],
    );
    return rows;
  }
  async latest(market: string): Promise<Snapshot | undefined> {
    const { rows } = await this.pool.query<Snapshot>(
      `select market, tier, total_assets as "totalAssets", total_borrows as "totalBorrows", reserves, utilization_bps as "utilizationBps", borrow_apr_bps as "borrowAprBps", supply_apy_bps as "supplyApyBps", block_number as "blockNumber", observed_at as "observedAt" from backend.market_snapshot where market=$1 order by observed_at desc limit 1`,
      [market],
    );
    return rows[0];
  }
  async averageBorrowAprBps(market: string): Promise<number> {
    const { rows } = await this.pool.query<{ value: number | null }>(
      `select round(avg(borrow_apr_bps))::integer as value from backend.market_snapshot where market=$1 and observed_at >= now() - interval '6 hours'`,
      [market],
    );
    return rows[0]?.value ?? 0;
  }
  onModuleDestroy() {
    return this.pool.end();
  }
}
export type HistoryRange = '1w' | '1m' | '3m' | '1y';
const ranges: Record<HistoryRange, { interval: string; origin: string }> = {
  '1w': { interval: '30 minutes', origin: '1 week' },
  '1m': { interval: '2 hours', origin: '1 month' },
  '3m': { interval: '6 hours', origin: '3 months' },
  '1y': { interval: '1 day', origin: '1 year' },
};
