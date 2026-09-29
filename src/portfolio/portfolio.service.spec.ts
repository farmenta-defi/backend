import { describe, expect, it, vi } from 'vitest';
import { PortfolioService } from './portfolio.service.js';

describe('PortfolioService', () => {
  it('rejects an invalid wallet address', async () => {
    const service = new PortfolioService(
      { query: vi.fn() } as never,
      { all: () => [] } as never,
      {} as never,
      {} as never,
    );

    await expect(service.portfolio('not-an-address')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('returns an empty portfolio at the no-indexed-positions edge', async () => {
    const service = new PortfolioService(
      {
        query: vi.fn().mockResolvedValue({
          positions: { items: [], pageInfo: { hasNextPage: false } },
          loans: { items: [], pageInfo: { hasNextPage: false } },
          vaultBalances: { items: [], pageInfo: { hasNextPage: false } },
        }),
      } as never,
      { all: () => [] } as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.portfolio('0x00000000000000000000000000000000000000aa'),
    ).resolves.toMatchObject({ positions: [], vaultShares: [] });
  });

  it('batches listed wallet valuations and omits unlisted positions', async () => {
    const market = '0x0000000000000000000000000000000000000001';
    const policy = '0x0000000000000000000000000000000000000002';
    const listedPool = `0x${'a'.repeat(64)}`;
    const unlistedPool = `0x${'b'.repeat(64)}`;
    const valuation = [0n, 1n, 2n, 3n, 4n, 100n, 80n, 0n];
    const rpc = {
      readContract: vi.fn(
        async (
          _address: string,
          _abi: unknown,
          name: string,
          args: readonly unknown[],
        ) => {
          if (name === 'debtOf') return 25n;
          if (name === 'positionValue') return 110n;
          if (name === 'healthFactor') return 2n * 10n ** 18n;
          if (name === 'convertToAssets') return BigInt(args[0] as string);
          throw new Error(`unexpected ${name}`);
        },
      ),
      multicall: vi.fn(async (calls: Array<{ functionName: string }>) =>
        calls.length === 60
          ? Array.from({ length: 60 }, () => ({
              status: 'success',
              result: valuation,
            }))
          : [
              { status: 'success', result: 25n },
              { status: 'success', result: 110n },
              { status: 'success', result: 2n * 10n ** 18n },
              { status: 'success', result: valuation },
            ],
      ),
    };
    const indexer = {
      query: vi.fn(async (query: string, variables: { after?: string }) => {
        if (query.includes('PortfolioPositions') && !variables.after)
          return {
            positions: {
              items: Array.from({ length: 60 }, (_, index) => ({
                tokenId: String(index + 1),
                poolId: listedPool,
              })),
              pageInfo: { hasNextPage: true, endCursor: 'positions-page-1' },
            },
          };
        if (query.includes('PortfolioPositions'))
          return {
            positions: {
              items: [{ tokenId: '61', poolId: unlistedPool }],
              pageInfo: { hasNextPage: false },
            },
          };
        if (query.includes('PortfolioLoans'))
          return {
            loans: {
              items: [
                {
                  market,
                  tokenId: '62',
                  poolId: listedPool,
                  status: 'in_custody',
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          };
        return {
          vaultBalances: { items: [], pageInfo: { hasNextPage: false } },
        };
      }),
    };
    const deployment = {
      address: market,
      policy,
      lens: '0x0000000000000000000000000000000000000003',
      valuer: '0x0000000000000000000000000000000000000004',
      tier: 1,
    };
    const service = new PortfolioService(
      indexer as never,
      {
        all: () => [['blueChip', deployment]],
        resolve: async (value: unknown) => value,
      } as never,
      {
        findListedMarket: async (poolId: string) =>
          poolId === listedPool ? deployment : undefined,
      } as never,
      rpc as never,
    );

    const result = await service.portfolio(
      '0x00000000000000000000000000000000000000aa',
    );

    expect(result.positions).toHaveLength(61);
    expect(result.positions).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ tokenId: '61' })]),
    );
    expect(result.positions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tokenId: '1',
          status: 'wallet',
          valueUsd: '180',
          uncollectedFeesUsd: '80',
          composition: { amount0: '1', amount1: '2', fees0: '3', fees1: '4' },
        }),
        expect.objectContaining({
          tokenId: '62',
          status: 'in_custody',
          collateralUsd: '110',
          uncollectedFeesUsd: '80',
        }),
      ]),
    );
    expect(rpc.multicall).toHaveBeenCalledTimes(2);
    expect(rpc.multicall.mock.calls[0][0]).toHaveLength(60);
    expect(indexer.query).toHaveBeenCalledTimes(4);
  });
});
