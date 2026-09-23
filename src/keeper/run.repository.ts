import { Pool } from 'pg';
import type { KeeperRun, KeeperRunRepository } from './keeper.types.js';

export class PostgresKeeperRunRepository implements KeeperRunRepository {
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async save(run: KeeperRun): Promise<void> {
    await this.pool.query(
      `insert into backend.keeper_record_batch_run
         (ran_at, pool_count, gas_used, gas_cost_usd, budget_usd, transaction_hash)
       values (to_timestamp($1), $2, $3, $4, $5, $6)`,
      [run.ranAt, run.poolCount, run.gasUsed.toString(), run.gasCostUsd, run.budgetUsd, run.transactionHash],
    );
  }

  async heartbeat(at: number): Promise<void> {
    await this.pool.query(
      `insert into backend.service_heartbeat (service, observed_at)
       values ('keeper-record-batch', to_timestamp($1))
       on conflict (service) do update set observed_at = excluded.observed_at`,
      [at],
    );
  }

  async dailyCostUsd(): Promise<number> {
    const result = await this.pool.query<{ cost: string }>(
      `select coalesce(sum(gas_cost_usd), 0)::text as cost
       from backend.keeper_record_batch_run
       where ran_at >= date_trunc('day', now())`,
    );
    return Number(result.rows[0].cost);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
