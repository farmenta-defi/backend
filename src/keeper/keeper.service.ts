import type {
  AlertRepository,
  IndexerRepository,
  KeeperRunRepository,
  PoolKey,
  RecorderRepository,
} from './keeper.types.js';

const OBSERVATION_ALERT_SECONDS = 600;

export class KeeperService {
  constructor(
    private readonly indexer: IndexerRepository,
    private readonly recorder: RecorderRepository,
    private readonly runs: KeeperRunRepository,
    private readonly alerts: AlertRepository,
    private readonly now: () => number = () => Math.floor(Date.now() / 1_000),
  ) {}

  async run({ dryRun }: { dryRun: boolean }) {
    await this.indexer.assertFresh();
    const [candidates, pools] = await Promise.all([this.indexer.candidates(), this.indexer.pools()]);
    const activePoolIds = await this.activePoolIds(candidates);
    const activePools = pools.filter((pool) => activePoolIds.has(pool.id));

    await this.alertStalePools(activePools);

    if (dryRun) {
      return { dryRun, poolCount: activePools.length, pools: activePools };
    }

    const ranAt = this.now();
    const slot = Math.floor(ranAt / 300) * 300;
    if (!await this.runs.claimRunSlot(slot, ranAt)) {
      await this.runs.heartbeat(ranAt);
      return { dryRun: false, poolCount: activePools.length, skipped: true };
    }
    if (activePools.length === 0) {
      await this.runs.heartbeat(ranAt);
      return { dryRun: false, poolCount: 0 };
    }

    const observationCounts = await this.recorder.observationCounts(activePools.map((pool) => pool.id));
    const fillingCount = observationCounts.filter((count) => count < 2_048).length;
    const budgetUsd = observationCounts.reduce(
      (total, count) => total + (count < 2_048 ? 3.3 : 2.1) / 5,
      0,
    );
    await this.indexer.assertFresh();
    const transactionHash = await this.recorder.submitBatch(activePools);
    await this.runs.markRunSlotSubmitted(slot, transactionHash);
    const receipt = await this.recorder.waitForReceipt(transactionHash);
    const gasCostUsd = Number(receipt.gasUsed * receipt.gasPrice) / 1e18 * 2_400;
    await this.runs.save({
      ranAt,
      poolCount: activePools.length,
      gasUsed: receipt.gasUsed,
      gasCostUsd,
      budgetUsd,
      transactionHash: receipt.hash,
    });
    await this.runs.completeRunSlot(slot, receipt.hash);
    const budgetAlertKey = `keeper-budget-${new Date(ranAt * 1_000).toISOString().slice(0, 10)}`;
    if (await this.runs.dailyCostUsd() > budgetUsd && await this.runs.claimAlert(budgetAlertKey, ranAt, 86_400)) {
      const phase = fillingCount === 0 ? 'steady-state' : fillingCount === activePools.length ? 'filling' : 'mixed';
      await this.sendAlert(budgetAlertKey, `Keeper daily gas cost exceeds the ${phase} budget of $${budgetUsd.toFixed(2)}.`);
    }
    await this.runs.heartbeat(ranAt);
    return { dryRun: false, poolCount: activePools.length, transactionHash: receipt.hash };
  }

  private async activePoolIds(candidates: Awaited<ReturnType<IndexerRepository['candidates']>>) {
    const candidatesByMarket = new Map<(typeof candidates)[number]['market'], typeof candidates>();
    for (const candidate of candidates) {
      const marketCandidates = candidatesByMarket.get(candidate.market) ?? [];
      marketCandidates.push(candidate);
      candidatesByMarket.set(candidate.market, marketCandidates);
    }
    const activePoolIds = new Set<string>();

    for (const [market, marketCandidates] of candidatesByMarket) {
      if (!market || !marketCandidates) continue;
      const debts = await this.recorder.debts(market, marketCandidates.map((candidate) => candidate.tokenId));
      marketCandidates.forEach((candidate, index) => {
        if (debts[index] > 0n) activePoolIds.add(candidate.poolId);
      });
    }
    return activePoolIds;
  }

  private async alertStalePools(pools: PoolKey[]) {
    await Promise.all(
      pools
        .filter((pool) => pool.observationAgeSeconds !== null && pool.observationAgeSeconds > OBSERVATION_ALERT_SECONDS)
        .map(async (pool) => {
          const alertKey = `keeper-stale-${pool.id}`;
          if (await this.runs.claimAlert(alertKey, this.now(), 3_600)) {
            await this.sendAlert(alertKey, `TWAP observation for ${pool.id} is ${pool.observationAgeSeconds}s old; stale at 900s.`);
          }
        }),
    );
  }

  private async sendAlert(alertKey: string, message: string) {
    try {
      await this.alerts.send(message);
    } catch (error) {
      console.error('Keeper alert delivery failed', error);
      await this.runs.releaseAlert(alertKey);
    }
  }
}
