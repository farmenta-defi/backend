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
});
