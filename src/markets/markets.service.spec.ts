import { ServiceUnavailableException } from '@nestjs/common';
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
        query: vi.fn().mockResolvedValue({
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

  it('derives available pool borrowing from market cash and both debt caps', async () => {
    const poolId = `0x${'a'.repeat(64)}`;
    const market = {
      address: '0x0000000000000000000000000000000000000002',
      policy: '0x0000000000000000000000000000000000000003',
      lens: '0x0000000000000000000000000000000000000004',
      valuer: '0x0000000000000000000000000000000000000005',
      tier: 1,
    };
    const rpc = {
      getBlockNumber: vi.fn().mockResolvedValue(10n),
      readContract: vi.fn(
        async (_address: string, _abi: unknown, name: string) => {
          if (name === 'listingOf') return { listed: true };
          if (name === 'effectiveLt') return 7500;
          if (name === 'acceptsNewPositions') return true;
          if (name === 'paused') return false;
          if (name === 'poolDebt') return 100_000_000n;
          if (name === 'totalAssets') return 1_000_000_000n;
          if (name === 'totalBorrows') return 200_000_000n;
          if (name === 'reserves') return 50_000_000n;
          throw new Error(`unexpected ${name}`);
        },
      ),
    };
    const service = new MarketsService(
      {
        all: () => [['blueChip', market]],
        resolve: async (value: unknown) => value,
        get: vi.fn().mockResolvedValue(market),
      },
      rpc,
      {
        query: vi.fn().mockResolvedValue({
          pools: {
            items: [{ id: poolId, tier: 1, debtCapUsdg: '500000000' }],
            pageInfo: { hasNextPage: false },
          },
        }),
      },
      {
        history: vi.fn().mockResolvedValue([]),
        latest: vi.fn().mockResolvedValue({ borrowAprBps: 500 }),
        averageBorrowAprBps: vi.fn().mockResolvedValue(600),
        insert: vi.fn(),
      },
      { get: (_key: string, load: () => Promise<unknown>) => load() },
    );

    await expect(service.pool(poolId)).resolves.toMatchObject({
      poolDebtUsdg: '100000000',
      debtCapUsdg: '500000000',
      availableToBorrowUsdg: '400000000',
      borrowingClosedReason: null,
      borrowAprPct: '5.00',
      rate6hPct: '6.00',
    });
    expect(rpc.getBlockNumber).toHaveBeenCalledOnce();
    const poolReadNames = [
      'acceptsNewPositions',
      'paused',
      'poolDebt',
      'totalAssets',
      'totalBorrows',
      'reserves',
    ];
    const poolReads = rpc.readContract.mock.calls.filter((call) =>
      poolReadNames.includes(call[2]),
    );
    expect(poolReads).toHaveLength(6);
    for (const call of poolReads) expect(call[4]).toBe(10n);
  });

  it.each([
    ['frozen pool', false, false, 'frozen', '0'],
    ['paused market', true, true, 'paused', '0'],
    ['open market and pool', true, false, null, '200000000'],
  ])(
    'reports borrowing availability for a %s',
    async (_name, canBorrow, paused, reason, available) => {
      const poolId = `0x${'b'.repeat(64)}`;
      const market = {
        address: '0x0000000000000000000000000000000000000002',
        policy: '0x0000000000000000000000000000000000000003',
        lens: '0x0000000000000000000000000000000000000004',
        valuer: '0x0000000000000000000000000000000000000005',
        tier: 1,
      };
      const blockReads: Array<[string, bigint | undefined]> = [];
      const rpc = {
        getBlockNumber: vi.fn().mockResolvedValue(20n),
        readContract: vi.fn(
          async (
            _address: string,
            _abi: unknown,
            name: string,
            _args: unknown[],
            block?: bigint,
          ) => {
            blockReads.push([name, block]);
            if (name === 'listingOf') return { listed: true };
            if (name === 'effectiveLt') return 7500;
            if (name === 'acceptsNewPositions') return canBorrow;
            if (name === 'paused') return paused;
            if (name === 'poolDebt') return 100_000_000n;
            if (name === 'totalAssets') return 1_000_000_000n;
            if (name === 'totalBorrows') return 200_000_000n;
            if (name === 'reserves') return 50_000_000n;
            throw new Error(`unexpected ${name}`);
          },
        ),
      };
      const repository = {
        history: vi.fn().mockResolvedValue([]),
        latest: vi.fn().mockResolvedValue(undefined),
        averageBorrowAprBps: vi.fn().mockResolvedValue(null),
      };
      const service = new MarketsService(
        {
          all: () => [['blueChip', market]],
          resolve: async (value: unknown) => value,
          get: vi.fn().mockResolvedValue(market),
        },
        rpc,
        {
          query: vi.fn().mockResolvedValue({
            pools: {
              items: [{ id: poolId, tier: 1, debtCapUsdg: '300000000' }],
              pageInfo: { hasNextPage: false },
            },
          }),
        },
        repository,
        { get: (_key: string, load: () => Promise<unknown>) => load() },
      );

      const response = await service.pool(poolId);
      expect(response).toMatchObject({
        poolDebtUsdg: '100000000',
        debtCapUsdg: '300000000',
        availableToBorrowUsdg: available,
        borrowingClosedReason: reason,
        borrowAprPct: null,
        rate6hPct: null,
      });
      expect(response).not.toHaveProperty('totalBorrowUsdg');
      expect(response).not.toHaveProperty('marketSizeUsdg');
      expect(
        blockReads.filter(
          ([name]) => name !== 'listingOf' && name !== 'effectiveLt',
        ),
      ).toEqual([
        ['acceptsNewPositions', 20n],
        ['paused', 20n],
        ['poolDebt', 20n],
        ['totalAssets', 20n],
        ['totalBorrows', 20n],
        ['reserves', 20n],
      ]);
    },
  );

  it('keeps a measured zero APR distinct from a missing snapshot', async () => {
    const poolId = `0x${'c'.repeat(64)}`;
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
        resolve: async (value: unknown) => value,
        get: vi.fn().mockResolvedValue(market),
      },
      {
        getBlockNumber: vi.fn().mockResolvedValue(30n),
        readContract: vi.fn(
          async (_address: string, _abi: unknown, name: string) => {
            if (name === 'listingOf') return { listed: true };
            if (name === 'effectiveLt') return 7500;
            if (name === 'acceptsNewPositions') return true;
            if (name === 'paused') return false;
            if (name === 'poolDebt') return 100n;
            if (name === 'totalAssets') return 1000n;
            if (name === 'totalBorrows') return 200n;
            if (name === 'reserves') return 50n;
            throw new Error(`unexpected ${name}`);
          },
        ),
      },
      {
        query: vi.fn().mockResolvedValue({
          pools: {
            items: [{ id: poolId, tier: 1, debtCapUsdg: '300' }],
            pageInfo: { hasNextPage: false },
          },
        }),
      },
      {
        history: vi.fn().mockResolvedValue([]),
        latest: vi.fn().mockResolvedValue({ borrowAprBps: 0 }),
        averageBorrowAprBps: vi.fn().mockResolvedValue(0),
      },
      { get: (_key: string, load: () => Promise<unknown>) => load() },
    );

    await expect(service.pool(poolId)).resolves.toMatchObject({
      borrowAprPct: '0.00',
      rate6hPct: '0.00',
    });
  });

  it.each(['acceptsNewPositions', 'paused'])(
    'propagates a failed %s read as service unavailable',
    async (failedRead) => {
      const poolId = `0x${'d'.repeat(64)}`;
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
          resolve: async (value: unknown) => value,
          get: vi.fn().mockResolvedValue(market),
        },
        {
          getBlockNumber: vi.fn().mockResolvedValue(40n),
          readContract: vi.fn(
            async (_address: string, _abi: unknown, name: string) => {
              if (name === failedRead)
                throw new ServiceUnavailableException('RPC is unavailable');
              if (name === 'listingOf') return { listed: true };
              if (name === 'effectiveLt') return 7500;
              if (name === 'acceptsNewPositions') return true;
              if (name === 'paused') return false;
              throw new Error(`unexpected ${name}`);
            },
          ),
        },
        {
          query: vi.fn().mockResolvedValue({
            pools: {
              items: [{ id: poolId, tier: 1, debtCapUsdg: '300000000' }],
              pageInfo: { hasNextPage: false },
            },
          }),
        },
        {
          history: vi.fn().mockResolvedValue([]),
          latest: vi.fn().mockResolvedValue(undefined),
          averageBorrowAprBps: vi.fn().mockResolvedValue(null),
        },
        { get: (_key: string, load: () => Promise<unknown>) => load() },
      );

      await expect(service.pool(poolId)).rejects.toMatchObject({ status: 503 });
    },
  );
});
