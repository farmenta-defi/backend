import { Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { type Address } from 'viem';
import { IndexerService } from '../indexer/indexer.service.js';
import { RpcService } from '../rpc/rpc.service.js';
import { TtlCacheService } from '../shared/ttl-cache.service.js';
import { marketAbi, policyAbi, rateModelAbi } from './contracts.js';
import { DeploymentService, MarketDeployment } from './deployment.service.js';
import { MarketRepository, Snapshot } from './market.repository.js';

const YEAR = 31_536_000n;
const WAD = 10n ** 18n;
const POOLS = `query Pools { pools { items { id currency0 currency1 fee tickSpacing hooks tier maxLtvBps ltBps liquidatorBonusBps removeHaircutBps debtCapUsdg minPositionUsd frozen } } }`;

@Injectable()
export class MarketsService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly deployments: DeploymentService, private readonly rpc: RpcService, private readonly indexer: IndexerService, private readonly repository: MarketRepository, private readonly cache: TtlCacheService) {}

  onModuleInit() { void this.captureAll().catch(() => undefined); this.timer = setInterval(() => void this.captureAll().catch(() => undefined), 300_000); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async markets() {
    return this.cache.get('markets', async () => Promise.all(this.deployments.all().map(async ([tier, deployment]) => ({
      tier, market: deployment.address, snapshot: await this.latestOrCapture(tier, deployment), history: await this.repository.history(deployment.address),
    }))));
  }

  async pools(tier: string) {
    const market = this.deployments.get(tier);
    const pools = await this.indexer.query<{ pools: { items: Pool[] } }>(POOLS, {}, 'pools');
    const listed = await Promise.all(pools.pools.items.filter((pool) => pool.tier === market.tier).map(async (pool) => (await this.isListed(market, pool.id)) ? pool : undefined));
    return listed.filter((pool): pool is Pool => Boolean(pool));
  }

  async pool(poolId: string) {
    const found = await Promise.all(this.deployments.all().map(async ([tier]) => ({ tier, pool: (await this.pools(tier)).find((item) => item.id.toLowerCase() === poolId.toLowerCase()) })));
    const entry = found.find((item) => item.pool);
    if (!entry?.pool) throw new NotFoundException('Pool is not listed');
    const pool = entry.pool;
    const market = this.deployments.get(entry.tier);
    const debt = await this.rpc.readContract<bigint>(market.address, marketAbi, 'poolDebt', [pool.id]);
    return { ...pool, tierName: entry.tier, market: market.address, totalBorrowUsdg: debt.toString() };
  }

  private async captureAll() { await Promise.all(this.deployments.all().map(([tier, market]) => this.capture(tier, market))); }
  private async latestOrCapture(tier: string, market: MarketDeployment) {
    const history = await this.repository.history(market.address);
    const latest = history.at(-1);
    if (latest && Date.now() - Date.parse(latest.observedAt) <= 300_000) return latest;
    return this.capture(tier, market);
  }
  private async capture(tier: string, market: MarketDeployment): Promise<Snapshot> {
    const block = await this.rpc.getBlockNumber();
    const [totalAssets, totalBorrows, reserves, rateModel] = await Promise.all([
      this.rpc.readContract<bigint>(market.address, marketAbi, 'totalAssets', [], block), this.rpc.readContract<bigint>(market.address, marketAbi, 'totalBorrows', [], block), this.rpc.readContract<bigint>(market.address, marketAbi, 'reserves', [], block), this.rpc.readContract<Address>(market.address, marketAbi, 'interestRateModel', [], block),
    ]);
    // totalAssets = cash + borrows - reserves; contracts use borrows / (cash + borrows).
    const denominator = totalAssets + reserves;
    const utilization = denominator === 0n ? 0n : totalBorrows * WAD / denominator;
    const perSecond = await this.rpc.readContract<bigint>(rateModel, rateModelAbi, 'ratePerSecond', [market.tier, utilization], block);
    const borrowApr = perSecond * YEAR;
    const reserveFactorBps = market.tier === 1 ? 1_500n : 2_500n;
    const supplyApy = borrowApr * utilization / WAD * (10_000n - reserveFactorBps) / 10_000n;
    const snapshot: Snapshot = { market: market.address, tier, totalAssets: totalAssets.toString(), totalBorrows: totalBorrows.toString(), reserves: reserves.toString(), utilizationBps: Number(utilization / 10n ** 14n), borrowAprBps: Number(borrowApr / 10n ** 14n), supplyApyBps: Number(supplyApy / 10n ** 14n), blockNumber: block.toString(), observedAt: new Date().toISOString() };
    await this.repository.insert(snapshot);
    return snapshot;
  }
  private async isListed(market: MarketDeployment, poolId: string) {
    const listing = await this.rpc.readContract<{ listed: boolean }>(market.policy, policyAbi, 'listingOf', [poolId]);
    return listing.listed;
  }
}

type Pool = { id: string; tier: number; [key: string]: unknown };
