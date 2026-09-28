import { describe, expect, it, vi } from 'vitest';
import { LiquidationsService } from './liquidations.service.js';

const market = '0x0000000000000000000000000000000000000001';
const lens = '0x0000000000000000000000000000000000000002';
const policy = '0x0000000000000000000000000000000000000003';
const asset = '0x0000000000000000000000000000000000000004';
const oracle = '0x0000000000000000000000000000000000000005';
const poolId = `0x${'a'.repeat(64)}`;
const ok = (result: unknown) => ({ status: 'success' as const, result });
const failed = { status: 'failure' as const, error: new Error('stale price') };

describe('LiquidationsService', () => {
  it('keeps a reverted position isolated and converts debt at the snapshot USDG price', async () => {
    const rpc = {
      multicall: vi
        .fn()
        .mockResolvedValueOnce([ok(asset), ok(oracle)])
        .mockResolvedValueOnce([ok(97n * 10n ** 16n), ok(6n)])
        .mockResolvedValueOnce([
          failed,
          ok(1_000_000n),
          ok(99n * 10n ** 16n),
          ok(1_000_000n),
          ok({
            ltStartBps: 8000n,
            ltTargetBps: 8000n,
            rampStart: 0n,
            rampDuration: 0n,
            liquidatorBonusBps: 500n,
          }),
          ok(8000),
        ]),
    };
    const service = new LiquidationsService(
      {} as never,
      rpc as never,
      {} as never,
      {} as never,
    );
    const captureMarket = (
      service as unknown as {
        captureMarket: (...args: unknown[]) => Promise<unknown[]>;
      }
    ).captureMarket;
    const observedAt = new Date('2026-09-28T00:00:30Z');

    const rows = await captureMarket.call(
      service,
      market,
      lens,
      policy,
      [
        { tokenId: '41', owner: '0xborrower', poolId },
        { tokenId: '42', owner: '0xborrower', poolId },
      ],
      new Map([[poolId, 'ETH/USDG']]),
      123n,
      observedAt,
    );

    expect(rows[0]).toMatchObject({ status: 'error', healthFactor: null });
    expect(rows[1]).toMatchObject({
      status: 'liquidatable',
      healthFactor: '990000000000000000',
      debtUsdg: '1000000',
      debtUsd: '970000000000000000',
      poolId: 'ETH/USDG',
      thresholdBps: 8000,
      bonusBps: 500,
    });
    expect(rpc.multicall.mock.calls.map((call) => call[1])).toEqual([
      123n,
      123n,
      123n,
    ]);
  });

  it('marks a ramp active only within its on-chain start and end timestamps', async () => {
    const rpc = {
      multicall: vi
        .fn()
        .mockResolvedValueOnce([ok(asset), ok(oracle)])
        .mockResolvedValueOnce([ok(10n ** 18n), ok(6n)])
        .mockResolvedValueOnce([
          ok(10n ** 18n),
          ok(1n),
          ok({
            ltStartBps: 8000n,
            ltTargetBps: 7000n,
            rampStart: 1_790_000_000n,
            rampDuration: 1000n,
            liquidatorBonusBps: 500n,
          }),
          ok(7500),
        ]),
    };
    const service = new LiquidationsService(
      {} as never,
      rpc as never,
      {} as never,
      {} as never,
    );
    const captureMarket = (
      service as unknown as {
        captureMarket: (...args: unknown[]) => Promise<unknown[]>;
      }
    ).captureMarket;
    const rows = await captureMarket.call(
      service,
      market,
      lens,
      policy,
      [{ tokenId: '7', owner: '0xborrower', poolId }],
      new Map(),
      123n,
      new Date(1_790_000_500_000),
    );

    expect(rows[0]).toMatchObject({ rampActive: true, thresholdBps: 7500 });
    expect(rpc.multicall.mock.calls.every((call) => call[1] === 123n)).toBe(
      true,
    );
  });

  it('excludes debt-free positions and marks snapshots older than 90 seconds stale', async () => {
    const observedAt = new Date('2026-09-28T00:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(observedAt.getTime() + 91_000));
    try {
      const repository = {
        latestHealthFactors: vi.fn().mockResolvedValue([
          {
            market,
            tokenId: '1',
            healthFactor: '1000000000000000000',
            debtUsdg: '0',
            debtUsd: '0',
            status: 'healthy',
            observedAt,
            blockNumber: '123',
          },
          {
            market,
            tokenId: '2',
            healthFactor: '900000000000000000',
            debtUsdg: '1000000',
            debtUsd: '1000000000000000000',
            status: 'liquidatable',
            observedAt,
            blockNumber: '123',
          },
        ]),
        latestHealthFactorHeartbeat: vi.fn().mockResolvedValue(undefined),
      };
      const service = new LiquidationsService(
        {} as never,
        {} as never,
        {} as never,
        repository as never,
      );

      await expect(service.liquidations()).resolves.toMatchObject({
        items: [{ positionId: '2', status: 'liquidatable' }],
        snapshotAt: observedAt,
        blockNumber: '123',
        stale: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns an empty fresh queue when the newest cycle has no loans', async () => {
    const observedAt = new Date('2026-09-28T00:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(observedAt.getTime() + 1_000));
    try {
      const repository = {
        latestHealthFactors: vi.fn(async (snapshotId?: string) =>
          snapshotId
            ? []
            : [{ observedAt: new Date(observedAt.getTime() - 30_000) }],
        ),
        latestHealthFactorHeartbeat: vi.fn().mockResolvedValue({
          observedAt,
          details: { snapshotId: 'current-cycle', blockNumber: '124' },
        }),
      };
      const service = new LiquidationsService(
        {} as never,
        {} as never,
        {} as never,
        repository as never,
      );

      await expect(service.liquidations()).resolves.toMatchObject({
        items: [],
        snapshotAt: observedAt,
        blockNumber: '124',
        stale: false,
      });
      expect(repository.latestHealthFactors).toHaveBeenCalledWith(
        'current-cycle',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('loads every indexer loan page before building a snapshot', async () => {
    const indexer = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          loans: {
            items: [{ tokenId: '1', owner: '0xborrower', poolId }],
            pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
          },
        })
        .mockResolvedValueOnce({
          loans: {
            items: [{ tokenId: '2', owner: '0xborrower', poolId }],
            pageInfo: { hasNextPage: false },
          },
        }),
    };
    const service = new LiquidationsService(
      {} as never,
      {} as never,
      indexer as never,
      {} as never,
    );
    const allLoans = (
      service as unknown as {
        allLoans: (...args: unknown[]) => Promise<unknown[]>;
      }
    ).allLoans;

    await expect(allLoans.call(service, market)).resolves.toHaveLength(2);
    expect(indexer.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('pageInfo { hasNextPage endCursor }'),
      { market, after: 'cursor-1' },
    );
  });

  it('stops loan pagination when the indexer repeats a cursor', async () => {
    const indexer = {
      query: vi.fn().mockResolvedValue({
        loans: {
          items: [{ tokenId: '1', owner: '0xborrower', poolId }],
          pageInfo: { hasNextPage: true, endCursor: 'stuck-cursor' },
        },
      }),
    };
    const service = new LiquidationsService(
      {} as never,
      {} as never,
      indexer as never,
      {} as never,
    );
    const allLoans = (
      service as unknown as {
        allLoans: (...args: unknown[]) => Promise<unknown[]>;
      }
    ).allLoans;

    await expect(allLoans.call(service, market)).rejects.toThrow(
      'Indexer loan pagination cursor did not advance',
    );
    expect(indexer.query).toHaveBeenCalledTimes(2);
  });

  it('records a partial snapshot and heartbeat when a market RPC call fails', async () => {
    const deployment = { address: market, lens, policy };
    const deployments = {
      all: () => [['market', {}]],
      resolve: vi.fn().mockResolvedValue(deployment),
    };
    const rpc = {
      getBlockNumber: vi.fn().mockResolvedValue(123n),
      clientForRead: {
        getBlock: vi.fn().mockResolvedValue({ timestamp: 1_790_000_000n }),
      },
      multicall: vi.fn().mockRejectedValue(new Error('RPC unavailable')),
    };
    const indexer = {
      query: vi.fn(async (query: string) =>
        query.includes('query Loans')
          ? {
              loans: {
                items: [{ tokenId: '41', owner: '0xborrower', poolId }],
                pageInfo: { hasNextPage: false },
              },
            }
          : { pools: { items: [], pageInfo: { hasNextPage: false } } },
      ),
    };
    const repository = {
      insertHealthFactors: vi.fn(),
      pruneHealthFactors: vi.fn(),
      heartbeat: vi.fn(),
    };
    const service = new LiquidationsService(
      deployments as never,
      rpc as never,
      indexer as never,
      repository as never,
    );
    const capture = (
      service as unknown as { capture: () => Promise<void> }
    ).capture;

    await capture.call(service);

    expect(repository.insertHealthFactors).toHaveBeenCalledWith(
      [expect.objectContaining({ status: 'error', tokenId: '41' })],
      123n,
      new Date(1_790_000_000_000),
      expect.any(String),
    );
    expect(repository.heartbeat).toHaveBeenCalledWith(
      new Date(1_790_000_000_000),
      expect.objectContaining({ positions: 1, errors: 1 }),
    );
  });
});
