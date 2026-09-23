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

  async claimAlert(key: string, at: number, reminderSeconds: number): Promise<boolean> {
    const result = await this.pool.query(
      `insert into backend.keeper_alert (alert_key, sent_at)
       values ($1, to_timestamp($2))
       on conflict (alert_key) do update set sent_at = excluded.sent_at
       where backend.keeper_alert.sent_at <= to_timestamp($2 - $3)
       returning alert_key`,
      [key, at, reminderSeconds],
    );
    return result.rowCount === 1;
  }

  async releaseAlert(key: string): Promise<void> {
    await this.pool.query('delete from backend.keeper_alert where alert_key = $1', [key]);
  }

  async claimRunSlot(slot: number, at: number): Promise<boolean> {
    const result = await this.pool.query(
      `insert into backend.keeper_record_batch_slot (slot_at, claimed_at)
       values (to_timestamp($1), to_timestamp($2))
       on conflict (slot_at) do update set claimed_at = excluded.claimed_at
       where backend.keeper_record_batch_slot.transaction_hash is null
         and backend.keeper_record_batch_slot.claimed_at <= to_timestamp($2 - 240)
       returning slot_at`,
      [slot, at],
    );
    return result.rowCount === 1;
  }

  async completeRunSlot(slot: number, transactionHash: string): Promise<void> {
    await this.pool.query(
      `update backend.keeper_record_batch_slot
       set transaction_hash = $2
       where slot_at = to_timestamp($1)`,
      [slot, transactionHash],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
