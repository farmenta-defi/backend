import { afterEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../ponder.schema.ts';
import { ActivityService } from '../src/activity/activity.service.js';
import { MarketsService } from '../src/markets/markets.service.js';
import { PortfolioService } from '../src/portfolio/portfolio.service.js';
import { TtlCacheService } from '../src/shared/ttl-cache.service.js';
import {
  startPonderIndexer,
  type PonderIndexer,
} from './support/ponder-graphql.js';

const owner = '0x00000000000000000000000000000000000000aa';
const marketAddresses = [
  '0x0000000000000000000000000000000000000001',
  '0x0000000000000000000000000000000000000002',
];
const poolId = `0x${'a'.repeat(64)}`;
const activeIndexers: PonderIndexer[] = [];

afterEach(async () => {
  await Promise.all(activeIndexers.splice(0).map((indexer) => indexer.close()));
});

describe('backend indexer queries against Ponder 0.17.10', () => {
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
    const deployments = {
      all: () =>
        marketAddresses.map((address, index) => [
          index ? 'meme' : 'blueChip',
          { address },
        ]),
    };
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
        actual.push(...(page.items as typeof actual));
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
      { findListedMarket: async () => deployment } as never,
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
            functionName === 'listingOf' ? { listed: true } : 7500,
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
