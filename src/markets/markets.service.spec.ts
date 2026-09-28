import { describe, expect, it, vi } from 'vitest';
import { MarketsService } from './markets.service.js';

describe('MarketsService', () => {
  it('uses the contract utilization definition and applies the tier reserve factor', async () => {
    const reads = vi
      .fn()
      .mockResolvedValueOnce(700n) // totalAssets = cash + borrows - reserves
      .mockResolvedValueOnce(300n) // totalBorrows
      .mockResolvedValueOnce(50n) // reserves
      .mockResolvedValueOnce('0x0000000000000000000000000000000000000001') // rate model
      .mockResolvedValueOnce(10n ** 18n / 31_536_000n); // 100% annual borrow rate
    const repository = {
      history: vi.fn().mockResolvedValue([]),
      latest: vi.fn().mockResolvedValue(undefined),
      insert: vi.fn().mockResolvedValue(undefined),
    };
    const service = new MarketsService(
      {
        all: () => [
          [
            'blueChip',
            {
              address: '0x0000000000000000000000000000000000000002',
              policy: '0x0000000000000000000000000000000000000003',
              lens: '0x0000000000000000000000000000000000000004',
              valuer: '0x0000000000000000000000000000000000000005',
              tier: 1,
            },
          ],
        ],
        resolve: async (market: unknown) => market,
        get: vi.fn(),
      },
      { readContract: reads, getBlockNumber: vi.fn().mockResolvedValue(99n) },
      { query: vi.fn() },
      repository,
      { get: (_key: string, load: () => Promise<unknown>) => load() },
    );
    const [market] = await service.markets();
    // Integer rate-per-second arithmetic intentionally rounds down before annualizing.
    expect(market.snapshot).toMatchObject({
      utilizationBps: 4000,
      borrowAprBps: 9999,
      supplyApyBps: 3399,
      blockNumber: '99',
    });
    expect(repository.insert).toHaveBeenCalledOnce();
  });

  it('does not expose an indexer pool that collateral policy has not listed', async () => {
    const poolId = `0x${'a'.repeat(64)}`;
    const market = {
      address: '0x0000000000000000000000000000000000000002',
      policy: '0x0000000000000000000000000000000000000003',
      lens: '0x0000000000000000000000000000000000000004',
      valuer: '0x0000000000000000000000000000000000000005',
      tier: 1,
    };
    const service = new MarketsService(
      {
        all: () => [['blueChip', market]],
        resolve: async (deployment: unknown) => deployment,
        get: vi.fn().mockResolvedValue(market),
      },
      {
        readContract: vi.fn().mockResolvedValue({ listed: false }),
        getBlockNumber: vi.fn(),
      },
      {
        query: vi
          .fn()
          .mockResolvedValue({
            pools: {
              items: [{ id: poolId, tier: 1 }],
              pageInfo: { hasNextPage: false },
            },
          }),
      },
      { history: vi.fn(), latest: vi.fn(), insert: vi.fn() },
      { get: (_key: string, load: () => Promise<unknown>) => load() },
    );

    await expect(service.pool(poolId)).rejects.toMatchObject({ status: 404 });
  });
});
