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
    const activePools = pools.filter((pool) => activePoolIds.has(pool.id) && isRecordable(pool));

    await this.alertStalePools(activePools);

    if (dryRun || activePools.length === 0) {
      return { dryRun, poolCount: activePools.length, pools: activePools };
    }

    const observationCounts = await this.recorder.observationCounts(activePools.map((pool) => pool.id));
    const filling = observationCounts.some((count) => count < 2_048);
    const budgetUsd = (filling ? 3.3 : 2.1) * (activePools.length / 5);
    const receipt = await this.recorder.recordBatch(activePools);
    const ranAt = this.now();
    const gasCostUsd = Number(receipt.gasUsed * receipt.gasPrice) / 1e18 * 2_400;
    await this.runs.save({
      ranAt,
      poolCount: activePools.length,
      gasUsed: receipt.gasUsed,
      gasCostUsd,
      budgetUsd,
      transactionHash: receipt.hash,
    });
    if (await this.runs.dailyCostUsd() > budgetUsd) {
      await this.alerts.send(`Keeper daily gas cost exceeds the ${filling ? 'filling' : 'steady-state'} budget of $${budgetUsd.toFixed(2)}.`);
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
        .map((pool) =>
          this.alerts.send(
            `TWAP observation for ${pool.id} is ${pool.observationAgeSeconds}s old; stale at 900s.`,
          ),
        ),
    );
  }
}

function isRecordable(pool: PoolKey): boolean {
  return pool.currency0 !== undefined && pool.currency1 !== undefined;
}
