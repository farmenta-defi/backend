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
         (ran_at, pool_count, gas_used, transaction_hash)
       values (to_timestamp($1), $2, $3, $4)`,
      [run.ranAt, run.poolCount, run.gasUsed.toString(), run.transactionHash],
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

  async close(): Promise<void> {
    await this.pool.end();
  }
}
