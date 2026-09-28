import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { SettingsService } from '../config/settings.service.js';

export type Snapshot = { market: string; tier: string; totalAssets: string; totalBorrows: string; reserves: string; utilizationBps: number; borrowAprBps: number; supplyApyBps: number; blockNumber: string; observedAt: string };

@Injectable()
export class MarketRepository implements OnModuleDestroy {
  private readonly pool: Pool;
  constructor(settings: SettingsService) { this.pool = new Pool({ connectionString: settings.databaseUrl }); }
  async insert(snapshot: Snapshot) {
    await this.pool.query(`insert into backend.market_snapshot (market,tier,total_assets,total_borrows,reserves,utilization_bps,borrow_apr_bps,supply_apy_bps,block_number,observed_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [snapshot.market, snapshot.tier, snapshot.totalAssets, snapshot.totalBorrows, snapshot.reserves, snapshot.utilizationBps, snapshot.borrowAprBps, snapshot.supplyApyBps, snapshot.blockNumber, snapshot.observedAt]);
  }
  async history(market: string, limit = 288): Promise<Snapshot[]> {
    const { rows } = await this.pool.query<Snapshot>(`select * from (select market, tier, total_assets as "totalAssets", total_borrows as "totalBorrows", reserves, utilization_bps as "utilizationBps", borrow_apr_bps as "borrowAprBps", supply_apy_bps as "supplyApyBps", block_number as "blockNumber", observed_at as "observedAt" from backend.market_snapshot where market=$1 order by observed_at desc limit $2) snapshots order by "observedAt" asc`, [market, limit]);
    return rows;
  }
  async latest(market: string): Promise<Snapshot | undefined> { return (await this.history(market, 1))[0]; }
  onModuleDestroy() { return this.pool.end(); }
}
