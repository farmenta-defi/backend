import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { isHex, type Address } from 'viem';
import { IndexerService } from '../indexer/indexer.service.js';
import { RpcService } from '../rpc/rpc.service.js';
import { TtlCacheService } from '../shared/ttl-cache.service.js';
import {
  marketAbi,
  policyAbi,
  policyEffectiveLtAbi,
  rateModelAbi,
} from './contracts.js';
import {
  DeploymentService,
  ResolvedMarketDeployment,
} from './deployment.service.js';
import {
  HistoryRange,
  MarketRepository,
  Snapshot,
} from './market.repository.js';

const YEAR = 31_536_000n;
const WAD = 10n ** 18n;
const MARKET_DEBT_CAP_USDG: Record<number, bigint> = {
  1: 500_000n * 10n ** 6n,
  2: 50_000n * 10n ** 6n,
};
const POOLS = `query Pools($after: String) { pools(limit: 1000, after: $after) { items { id currency0 currency1 fee tickSpacing hooks tier maxLtvBps ltBps liquidatorBonusBps removeHaircutBps debtCapUsdg minPositionUsd frozen } pageInfo { hasNextPage endCursor } } }`;

@Injectable()
export class MarketsService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private readonly logger = new Logger(MarketsService.name);
  constructor(
    private readonly deployments: DeploymentService,
    private readonly rpc: RpcService,
    private readonly indexer: IndexerService,
    private readonly repository: MarketRepository,
    private readonly cache: TtlCacheService,
  ) {}

  onModuleInit() {
    void this.captureSnapshots();
    this.timer = setInterval(() => void this.captureSnapshots(), 300_000);
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async markets(range: HistoryRange = '1w') {
    return this.cache.get(`markets:${range}`, async () =>
      Promise.all(
        this.deployments.all().map(async ([tier, raw]) => {
          const deployment = await this.deployments.resolve(raw);
          return {
            tier,
            market: deployment.address,
            snapshot: await this.latestOrCapture(tier, deployment),
            history: await this.repository.history(deployment.address, range),
          };
        }),
      ),
    );
  }

  async pools(tier: string): Promise<ListedPool[]> {
    return this.loadPools(tier);
  }
  private async loadPools(tier: string): Promise<ListedPool[]> {
    const market = await this.deployments.get(tier);
    const pools = await this.allPools();
    const listed = await Promise.all(
      pools
        .filter((pool) => pool.tier === market.tier)
        .map(async (pool) => {
          const listing = await this.isListed(market, pool.id);
          if (!listing.listed || listing.tier !== market.tier) return undefined;
          return {
            ...pool,
            effectiveLtBps: await this.rpc.readContract<number>(
              market.policy,
              policyEffectiveLtAbi,
              'effectiveLt',
              [pool.id],
            ),
          };
        }),
    );
    return listed.filter((pool): pool is ListedPool => Boolean(pool));
  }

  async pool(poolId: string, range: HistoryRange = '1w') {
    if (!isHex(poolId, { strict: true }) || poolId.length !== 66)
      throw new NotFoundException('Pool is not listed');
    return this.loadPool(poolId, range);
  }
  private async loadPool(poolId: string, range: HistoryRange) {
    const found = await Promise.all(
      this.deployments.all().map(async ([tier]) => ({
        tier,
        pool: (await this.pools(tier)).find(
          (item) => item.id.toLowerCase() === poolId.toLowerCase(),
        ),
      })),
    );
    const entry = found.find((item) => item.pool);
    if (!entry?.pool) throw new NotFoundException('Pool is not listed');
    const pool = entry.pool;
    const market = await this.deployments.get(entry.tier);
    const block = await this.rpc.getBlockNumber();
    const [debt, totalAssets, totalBorrows, reserves, latest, rate6hBps] =
      await Promise.all([
        this.rpc.readContract<bigint>(
          market.address,
          marketAbi,
          'poolDebt',
          [pool.id],
          block,
        ),
        this.rpc.readContract<bigint>(
          market.address,
          marketAbi,
          'totalAssets',
          [],
          block,
        ),
        this.rpc.readContract<bigint>(
          market.address,
          marketAbi,
          'totalBorrows',
          [],
          block,
        ),
        this.rpc.readContract<bigint>(
          market.address,
          marketAbi,
          'reserves',
          [],
          block,
        ),
        this.repository.latest(market.address),
        this.repository.averageBorrowAprBps(market.address),
      ]);
    const debtCap = BigInt(pool.debtCapUsdg ?? '0');
    const marketDebtCap = MARKET_DEBT_CAP_USDG[market.tier] ?? 0n;
    const cash = totalAssets + reserves - totalBorrows;
    const availableToBorrow = [
      cash,
      debtCap - debt,
      marketDebtCap - totalBorrows,
    ].reduce((minimum, value) => (value < minimum ? value : minimum));
    return {
      ...pool,
      tierName: entry.tier,
      market: market.address,
      totalBorrowUsdg: debt.toString(),
      marketSizeUsdg: String(pool.debtCapUsdg),
      poolDebtUsdg: debt.toString(),
      debtCapUsdg: debtCap.toString(),
      availableToBorrowUsdg: (availableToBorrow > 0n
        ? availableToBorrow
        : 0n
      ).toString(),
      borrowAprPct: bpsToPercent(latest?.borrowAprBps ?? 0),
      rate6hPct: bpsToPercent(rate6hBps),
      history: await this.repository.history(market.address, range),
    };
  }

  private async allPools(after?: string, result: Pool[] = []): Promise<Pool[]> {
    const page = await this.indexer.query<{
      pools: {
        items: Pool[];
        pageInfo: { hasNextPage: boolean; endCursor?: string };
      };
    }>(POOLS, { after }, `pools:${after ?? ''}`);
    const next = [...result, ...page.pools.items];
    if (page.pools.pageInfo.hasNextPage && !page.pools.pageInfo.endCursor)
      throw new ServiceUnavailableException(
        'Indexer pagination is unavailable',
      );
    return page.pools.pageInfo.hasNextPage
      ? this.allPools(page.pools.pageInfo.endCursor, next)
      : next;
  }
  private async captureSnapshots() {
    try {
      await this.captureAll();
    } catch {
      this.logger.error('Market snapshot capture failed');
    }
  }
  private async captureAll() {
    await Promise.all(
      this.deployments
        .all()
        .map(async ([tier, market]) =>
          this.capture(tier, await this.deployments.resolve(market)),
        ),
    );
  }
  private async latestOrCapture(
    tier: string,
    market: ResolvedMarketDeployment,
  ) {
    const latest = await this.repository.latest(market.address);
    if (latest && Date.now() - Date.parse(latest.observedAt) <= 300_000)
      return latest;
    return this.capture(tier, market);
  }
  private async capture(
    tier: string,
    market: ResolvedMarketDeployment,
  ): Promise<Snapshot> {
    const block = await this.rpc.getBlockNumber();
    const [totalAssets, totalBorrows, reserves, rateModel] = await Promise.all([
      this.rpc.readContract<bigint>(
        market.address,
        marketAbi,
        'totalAssets',
        [],
        block,
      ),
      this.rpc.readContract<bigint>(
        market.address,
        marketAbi,
        'totalBorrows',
        [],
        block,
      ),
      this.rpc.readContract<bigint>(
        market.address,
        marketAbi,
        'reserves',
        [],
        block,
      ),
      this.rpc.readContract<Address>(
        market.address,
        marketAbi,
        'interestRateModel',
        [],
        block,
      ),
    ]);
    // totalAssets = cash + borrows - reserves; contracts use borrows / (cash + borrows).
    const denominator = totalAssets + reserves;
    const utilization =
      denominator === 0n ? 0n : (totalBorrows * WAD) / denominator;
    const perSecond = await this.rpc.readContract<bigint>(
      rateModel,
      rateModelAbi,
      'ratePerSecond',
      [market.tier, utilization],
      block,
    );
    const borrowApr = perSecond * YEAR;
    const reserveFactorBps = market.tier === 1 ? 1_500n : 2_500n;
    const supplyApy =
      (((borrowApr * utilization) / WAD) * (10_000n - reserveFactorBps)) /
      10_000n;
    const snapshot: Snapshot = {
      market: market.address,
      tier,
      totalAssets: totalAssets.toString(),
      totalBorrows: totalBorrows.toString(),
      reserves: reserves.toString(),
      utilizationBps: Number(utilization / 10n ** 14n),
      borrowAprBps: Number(borrowApr / 10n ** 14n),
      supplyApyBps: Number(supplyApy / 10n ** 14n),
      blockNumber: block.toString(),
      observedAt: new Date().toISOString(),
    };
    await this.repository.insert(snapshot);
    return snapshot;
  }
  private async isListed(market: ResolvedMarketDeployment, poolId: string) {
    return this.cache.get(`listing:${market.policy}:${poolId}`, async () => {
      const listing = await this.rpc.readContract<{
        listed: boolean;
        tier: number;
      }>(market.policy, policyAbi, 'listingOf', [poolId]);
      return { listed: listing.listed, tier: listing.tier };
    });
  }
  async findListedMarket(
    poolId: string,
  ): Promise<ResolvedMarketDeployment | undefined> {
    for (const [, raw] of this.deployments.all()) {
      const market = await this.deployments.resolve(raw);
      const listing = await this.isListed(market, poolId);
      if (listing.listed && listing.tier === market.tier) return market;
    }
    return undefined;
  }
  async findListedMarkets(poolId: string): Promise<ResolvedMarketDeployment[]> {
    const listed: ResolvedMarketDeployment[] = [];
    const policies = new Map<
      string,
      Promise<{ listed: boolean; tier: number }>
    >();
    for (const [, raw] of this.deployments.all()) {
      const market = await this.deployments.resolve(raw);
      const listing =
        policies.get(market.policy) ?? this.isListed(market, poolId);
      policies.set(market.policy, listing);
      const result = await listing;
      if (result.listed && result.tier === market.tier) listed.push(market);
    }
    return listed;
  }
}

type Pool = {
  id: string;
  tier: number;
  debtCapUsdg?: string;
  [key: string]: unknown;
};
type ListedPool = Pool & { effectiveLtBps: number };
function bpsToPercent(value: number) {
  const whole = Math.trunc(value / 100);
  const fraction = String(value % 100).padStart(2, '0');
  return `${whole}.${fraction}`;
}
