import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as schema from '../ponder.schema.js';
import { ActivityService } from '../src/activity/activity.service.js';
import { PoolActivityService } from '../src/activity/pool-activity.service.js';
import { MarketsService } from '../src/markets/markets.service.js';
import { PortfolioService } from '../src/portfolio/portfolio.service.js';
import { TtlCacheService } from '../src/shared/ttl-cache.service.js';
import {
  startPonderIndexer,
  type PonderIndexer,
} from './support/ponder-graphql.js';

const owner = '0x00000000000000000000000000000000000000aa';
const deployment = JSON.parse(
  readFileSync(
    new URL('./fixtures/two-market-deployment.json', import.meta.url),
    'utf8',
  ),
) as { markets: Record<string, { address: string }> };
const marketAddresses = Object.values(deployment.markets).map(
  ({ address }) => address,
);
const poolId = `0x${'a'.repeat(64)}`;
const activeIndexers: PonderIndexer[] = [];

afterEach(async () => {
  await Promise.all(activeIndexers.splice(0).map((indexer) => indexer.close()));
});

describe('backend indexer queries against Ponder 0.17.10', () => {
  it('paginates pool activity across wallets and tables, ordered by block and log index', async () => {
    const otherPool = `0x${'b'.repeat(64)}`;
    const emptyPool = `0x${'c'.repeat(64)}`;
    const events = [
      { kind: 'deposit', poolId, market: marketAddresses[0], block: 100, log: 1, owner },
      { kind: 'borrow', poolId, market: marketAddresses[0], block: 100, log: 4, owner: '0x00000000000000000000000000000000000000bb' },
      { kind: 'increase_liquidity', poolId, market: marketAddresses[0], block: 103, log: 1, owner },
      { kind: 'collect_fees', poolId, market: marketAddresses[1], block: 104, log: 1, owner },
      { kind: 'withdraw', poolId, market: marketAddresses[1], block: 100, log: 6, owner: '0x00000000000000000000000000000000000000bb' },
      { kind: 'repay', poolId, market: marketAddresses[0], block: 100, log: 8, owner },
      { kind: 'borrow', poolId: otherPool, market: marketAddresses[0], block: 101, log: 1, owner },
      { kind: 'borrow', poolId, market: marketAddresses[1], block: 102, log: 1, owner },
      { kind: 'liquidation', poolId, market: marketAddresses[0], block: 100, log: 11, owner },
    ];
    const indexer = await withIndexer((table) => {
      if (table === schema.loanActivity)
        return events
          .filter((event) => event.kind !== 'liquidation')
          .map((event, index) => ({
            market: event.market,
            poolId: event.poolId,
            blockNumber: BigInt(event.block),
            logIndex: event.log,
            timestamp: 1_800_000_000n + BigInt(index),
            transactionHash: hash(index),
            tokenId: BigInt(index + 1),
            owner: event.owner,
            kind: event.kind,
            amountUsdg: event.kind === 'borrow' || event.kind === 'repay' ? 100n : null,
            liquidityDelta: null,
            amount0: null,
            amount1: null,
          }));
      if (table === schema.liquidation)
        return [{
          market: marketAddresses[0],
          poolId,
          blockNumber: 100n,
          logIndex: 11,
          timestamp: 1_800_000_010n,
          transactionHash: hash(10),
          tokenId: 10n,
          owner,
          liquidator: '0x00000000000000000000000000000000000000cc',
          full: true,
          repaidUsdg: 500n,
          badDebtUsdg: 20n,
          socializedUsdg: 0n,
          out0: 0n,
          out1: 0n,
        }];
      return [];
    });
    const service = new PoolActivityService(
      indexer.indexer as never,
      { findListedMarkets: vi.fn(async (id: string) => id === poolId || id === emptyPool
        ? marketAddresses.map((address) => ({ address }))
        : []) } as never,
      new TtlCacheService(),
    );
    const actual: Array<{ blockNumber: string; logIndex: number; kind: string; owner: string }> = [];
    let cursor: string | undefined;
    let hasMore = true;
    while (hasMore) {
      const page = await service.activity(poolId, 1, cursor);
      actual.push(...page.items as typeof actual);
      cursor = page.nextCursor ?? undefined;
      hasMore = page.hasMore;
    }

    expect(actual.map(({ kind, blockNumber, logIndex }) => ({ kind, blockNumber, logIndex }))).toEqual([
      { kind: 'borrow', blockNumber: '102', logIndex: 1 },
      { kind: 'liquidation', blockNumber: '100', logIndex: 11 },
      { kind: 'repay', blockNumber: '100', logIndex: 8 },
      { kind: 'withdraw', blockNumber: '100', logIndex: 6 },
      { kind: 'borrow', blockNumber: '100', logIndex: 4 },
      { kind: 'deposit', blockNumber: '100', logIndex: 1 },
    ]);
    expect(actual.map(({ owner }) => owner)).toContain('0x00000000000000000000000000000000000000bb');
    expect(actual.map(({ kind }) => kind)).not.toContain('increase_liquidity');
    expect(actual.map(({ kind }) => kind)).not.toContain('collect_fees');
    expect(new Set(actual.map(({ blockNumber, logIndex }) => `${blockNumber}:${logIndex}`)).size).toBe(6);
    expect(indexer.requests.some(({ query }) => query.includes('query PoolActivity('))).toBe(true);
    const defaultQuery = indexer.requests.find(({ query }) => query.includes('query PoolActivity('))?.query ?? '';
    expect(defaultQuery).toContain('kind_in: ["deposit", "withdraw", "borrow", "repay"]');

    const borrows = await service.activity(poolId, 25, undefined, 'borrow');
    expect(borrows.items.map(({ kind }) => kind)).toEqual(['borrow', 'borrow']);
    expect(await service.activity(emptyPool)).toEqual({ items: [], nextCursor: null, hasMore: false });
    const liquidation = (await service.activity(poolId, 25)).items.find(({ kind }) => kind === 'liquidation');
    expect(liquidation).toMatchObject({
      kind: 'liquidation',
      tokenId: '10',
      amountUsdg: null,
      liquidator: '0x00000000000000000000000000000000000000cc',
      repaidUsdg: '500',
      badDebtUsdg: '20',
      full: true,
    });
    const liquidationOnly = await service.activity(poolId, 25, undefined, 'liquidation');
    expect(liquidationOnly.items.map(({ kind }) => kind)).toEqual(['liquidation']);
    expect(indexer.requests.at(-1)?.query).not.toContain('loanActivitys(');
    expect(actual[0]).toMatchObject({ liquidator: null, repaidUsdg: null, badDebtUsdg: null, full: null });
  });

  it('paginates pool rows in block and log order when timestamps are shared across blocks', async () => {
    const events = Array.from({ length: 270 }, (_, index) => ({
      index,
      market: marketAddresses[index % 2],
      block: 100 + Math.floor(index / 9),
      log: index % 9,
    }));
    const indexer = await withIndexer((table) =>
      table === schema.loanActivity
        ? events.map(({ index, market, block, log }) => ({
            market, poolId, blockNumber: BigInt(block), logIndex: log,
            timestamp: 1_800_000_000n + BigInt(Math.floor(index / 45)),
            transactionHash: hash(index), tokenId: BigInt(index + 1), owner,
            kind: 'borrow', amountUsdg: BigInt(index + 1),
            liquidityDelta: null, amount0: null, amount1: null,
          }))
        : [],
    );
    const service = new PoolActivityService(
      indexer.indexer as never,
      { findListedMarkets: vi.fn(async () => marketAddresses.map((address) => ({ address }))) } as never,
      new TtlCacheService(),
    );
    for (const limit of [1, 25, 100]) {
      const actual: Array<{ blockNumber: string; logIndex: number; transactionHash: string }> = [];
      let cursor: string | undefined;
      let hasMore = true;
      while (hasMore) {
        const page = await service.activity(poolId, limit, cursor);
        actual.push(...page.items as typeof actual);
        cursor = page.nextCursor ?? undefined;
        hasMore = page.hasMore;
      }
      const expected = events
        .map(({ index, block, log }) => ({ blockNumber: String(block), logIndex: log, transactionHash: hash(index) }))
        .sort((a, b) => Number(BigInt(b.blockNumber) - BigInt(a.blockNumber)) || b.logIndex - a.logIndex);
      expect(actual.map(({ blockNumber, logIndex, transactionHash }) => ({ blockNumber, logIndex, transactionHash }))).toEqual(expected);
      expect(new Set(actual.map(({ transactionHash }) => transactionHash)).size).toBe(270);
    }
  });

  it('rejects fields that are absent from the pinned indexer schema', async () => {
    const indexer = await withIndexer(() => []);

    await expect(
      indexer.indexer.query(
        '{ positions { items { fieldMissingFromPinnedSchema } } }',
      ),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('reads every activity row once in block and log order for limits 1, 25, and 100', async () => {
    const events = Array.from({ length: 135 }, (_, index) => ({
      index,
      table: index % 3,
      market: marketAddresses[index % 2],
      blockNumber: 100 + Math.floor(index / 9),
    }));
    const indexer = await withIndexer((table) => {
      if (table === schema.loanActivity)
        return events
          .filter((event) => event.table === 0)
          .map((event) => ({
            market: event.market,
            poolId,
            blockNumber: BigInt(event.blockNumber),
            logIndex: event.index,
            timestamp: 1_800_000_000n,
            transactionHash: hash(event.index),
            tokenId: BigInt(event.index + 1),
            owner,
            kind: 'borrow',
            amountUsdg: BigInt(event.index + 1),
            liquidityDelta: null,
            amount0: null,
            amount1: null,
          }));
      if (table === schema.liquidation)
        return events
          .filter((event) => event.table === 1)
          .map((event) => ({
            market: event.market,
            blockNumber: BigInt(event.blockNumber),
            logIndex: event.index,
            timestamp: 1_800_000_000n,
            transactionHash: hash(event.index),
            tokenId: BigInt(event.index + 1),
            owner,
            poolId,
            liquidator: owner,
            full: false,
            repaidUsdg: 1n,
            badDebtUsdg: 0n,
            socializedUsdg: 0n,
            out0: 0n,
            out1: 0n,
          }));
      if (table === schema.vaultActivity)
        return events
          .filter((event) => event.table === 2)
          .map((event) => ({
            market: event.market,
            blockNumber: BigInt(event.blockNumber),
            logIndex: event.index,
            timestamp: 1_800_000_000n,
            transactionHash: hash(event.index),
            kind: 'deposit',
            sender: owner,
            owner,
            receiver: null,
            assetsUsdg: 1n,
            shares: 1n,
          }));
      return [];
    });
    const deployments = { all: () => Object.entries(deployment.markets) };
    const service = new ActivityService(
      indexer.indexer as never,
      deployments as never,
      new TtlCacheService(),
    );
    const expected = events
      .map((event) => ({
        market: event.market,
        blockNumber: String(event.blockNumber),
        logIndex: event.index,
        category: ['loan', 'liquidation', 'vault'][event.table],
      }))
      .sort(
        (a, b) =>
          Number(BigInt(b.blockNumber) - BigInt(a.blockNumber)) ||
          b.logIndex - a.logIndex,
      );

    for (const limit of [1, 25, 100]) {
      const actual: Array<{
        market: string;
        blockNumber: string;
        logIndex: number;
        category: string;
      }> = [];
      let cursor: string | undefined;
      let hasMore = true;
      const cursors = new Set<string>();
      while (hasMore) {
        const page = await service.activity(owner, limit, cursor);
        actual.push(...page.items.map((item) => ({
          market: String(item.market),
          blockNumber: String(item.blockNumber),
          logIndex: Number(item.logIndex),
          category: String(item.category),
        })));
        cursor = page.nextCursor ?? undefined;
        hasMore = page.hasMore;
        if (cursor) {
          expect(cursors.has(cursor)).toBe(false);
          cursors.add(cursor);
        }
        expect(actual.length).toBeLessThanOrEqual(events.length);
      }
      expect(
        actual.map(({ market, blockNumber, logIndex, category }) => ({
          market,
          blockNumber,
          logIndex,
          category,
        })),
      ).toEqual(expected);
      expect(
        new Set(
          actual.map(
            (row) => `${row.market}:${row.blockNumber}:${row.logIndex}`,
          ),
        ).size,
      ).toBe(events.length);
    }

    const activityRequests = indexer.requests.filter(({ query }) =>
      query.includes('query Activity('),
    );
    expect(activityRequests.length).toBeGreaterThan(3);
    for (const { query } of activityRequests) {
      const { tokens, aliases } = indexer.measureOperation(query);
      expect(tokens).toBeLessThanOrEqual(1_000);
      expect(aliases).toBeLessThanOrEqual(30);
      expect(aliases).toBe(3 * deployments.all().length);
      expect(query.match(/orderBy: "blockNumber"/g)).toHaveLength(aliases);
    }
    expect(
      activityRequests.some(
        ({ variables }) => typeof variables.blockNumber === 'number',
      ),
    ).toBe(false);
  });

  it('returns all wallet positions beyond Ponder’s default page of 50', async () => {
    const deployment = {
      address: marketAddresses[0],
      policy: marketAddresses[0],
      lens: marketAddresses[0],
      valuer: marketAddresses[0],
      tier: 1,
    };
    const indexer = await withIndexer((table) =>
      table === schema.position
        ? Array.from({ length: 60 }, (_, index) => ({
            tokenId: BigInt(index + 1),
            owner,
            poolId,
            tickLower: -10,
            tickUpper: 10,
            liquidity: 100n,
            burned: false,
            mintedBlock: 1n,
            mintedAt: 1n,
            updatedAt: 1n,
          }))
        : [],
    );
    const service = new PortfolioService(
      indexer.indexer as never,
      {
        all: () => [['blueChip', deployment]],
        resolve: async (market: unknown) => market,
      } as never,
      {
        findListedMarket: async () => deployment,
        findListedMarkets: async () => [deployment],
      } as never,
      {
        multicall: vi.fn(async (calls: unknown[]) =>
          calls.map(() => ({
            status: 'success',
            result: [0n, 1n, 2n, 3n, 4n, 5n, 6n, 0n],
          })),
        ),
      } as never,
      new TtlCacheService(),
    );

    const result = await service.portfolio(owner);
    expect(result.positions).toHaveLength(60);
    expect(
      indexer.requests.filter(({ query }) =>
        query.includes('PortfolioPositions'),
      ),
    ).toHaveLength(1);
  });

  it('returns all tier pools beyond Ponder’s default page of 50', async () => {
    const deployment = {
      address: marketAddresses[0],
      policy: marketAddresses[0],
      lens: marketAddresses[0],
      valuer: marketAddresses[0],
      tier: 1,
    };
    const indexer = await withIndexer((table) =>
      table === schema.pool
        ? Array.from({ length: 75 }, (_, index) => ({
            id: `0x${index.toString(16).padStart(64, '0')}`,
            currency0: marketAddresses[0],
            currency1: marketAddresses[1],
            fee: 3000,
            tickSpacing: 60,
            hooks: marketAddresses[0],
            tier: 1,
            maxLtvBps: 5000,
            ltBps: 7500,
            liquidatorBonusBps: 500,
            removeHaircutBps: 100,
            debtCapUsdg: 1_000_000n,
            minPositionUsd: 1n,
            frozen: false,
            rampLtFromBps: null,
            rampLtTargetBps: null,
            rampStart: null,
            rampDuration: null,
            listedBlock: 1n,
            listedAt: 1n,
            updatedAt: 1n,
          }))
        : [],
    );
    const service = new MarketsService(
      {
        all: () => [['blueChip', deployment]],
        resolve: async (market: unknown) => market,
        get: async () => deployment,
      } as never,
      {
        readContract: vi.fn(
          async (_address: string, _abi: unknown, functionName: string) =>
            functionName === 'listingOf' ? { listed: true, tier: 1 } : 7500,
        ),
      } as never,
      indexer.indexer as never,
      { history: vi.fn(), latest: vi.fn(), insert: vi.fn() } as never,
      new TtlCacheService(),
    );

    const pools = await service.pools('blueChip');
    expect(pools).toHaveLength(75);
    expect(
      indexer.requests.filter(({ query }) => query.includes('query Pools(')),
    ).toHaveLength(1);
  });
});

async function withIndexer(
  rowsOf: (table: object) => Record<string, unknown>[],
) {
  const indexer = await startPonderIndexer(rowsOf);
  activeIndexers.push(indexer);
  return indexer;
}

function hash(index: number) {
  return `0x${index.toString(16).padStart(64, '0')}`;
}
