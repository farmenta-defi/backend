import type { IndexerRepository, KeeperCandidate, PoolKey } from './keeper.types.js';

interface IndexerStatus {
  robinhood?: { block?: { timestamp?: number } };
}

interface IndexerLoan {
  market: string;
  tokenId: string;
  poolId: string;
}

interface IndexerPool {
  id: string;
  currency0: string | null;
  currency1: string | null;
  fee: number;
  tickSpacing: number;
  hooks: string;
  observationAgeSeconds: string | number | null;
}

export class HttpIndexerRepository implements IndexerRepository {
  constructor(
    private readonly baseUrl: string,
    private readonly maxLagSeconds: number,
    private readonly now: () => number = () => Math.floor(Date.now() / 1_000),
  ) {}

  async assertFresh(): Promise<void> {
    const status = await this.get<IndexerStatus>('/status');
    const timestamp = status.robinhood?.block?.timestamp;
    if (!timestamp || this.now() - timestamp > this.maxLagSeconds) {
      throw new Error('Indexer is stale; refusing to record from an incomplete candidate list.');
    }
  }

  async candidates(): Promise<KeeperCandidate[]> {
    const loans = await this.get<IndexerLoan[]>('/loans/keeper-candidates');
    return loans.map((loan) => ({
      market: loan.market as KeeperCandidate['market'],
      tokenId: BigInt(loan.tokenId),
      poolId: loan.poolId as KeeperCandidate['poolId'],
    }));
  }

  async pools(): Promise<PoolKey[]> {
    const pools = await this.get<IndexerPool[]>('/pools');
    return pools.flatMap((pool) => {
      if (pool.currency0 === null || pool.currency1 === null) return [];
      return [{
        id: pool.id as PoolKey['id'],
        currency0: pool.currency0 as PoolKey['currency0'],
        currency1: pool.currency1 as PoolKey['currency1'],
        fee: pool.fee,
        tickSpacing: pool.tickSpacing,
        hooks: pool.hooks as PoolKey['hooks'],
        observationAgeSeconds: pool.observationAgeSeconds === null ? null : Number(pool.observationAgeSeconds),
      }];
    });
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Indexer request ${path} failed with ${response.status}`);
    return (await response.json()) as T;
  }
}
