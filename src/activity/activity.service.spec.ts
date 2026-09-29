import { describe, expect, it, vi } from 'vitest';
import { ActivityService } from './activity.service.js';

describe('ActivityService', () => {
  it('rejects an invalid wallet address', async () => {
    const service = new ActivityService(
      { query: vi.fn() } as never,
      { all: () => [] } as never,
    );

    await expect(service.activity('not-an-address')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('accepts the minimum page size and cursor boundary', async () => {
    const query = vi.fn().mockResolvedValue({});
    const service = new ActivityService(
      { query } as never,
      { all: () => [] } as never,
    );

    await expect(
      service.activity('0x00000000000000000000000000000000000000aa', 1, '0:0'),
    ).resolves.toMatchObject({ items: [], nextCursor: null, hasMore: false });
    expect(query).toHaveBeenCalledOnce();
  });

  it('paginates a merged activity feed without duplicates when tables share a timestamp', async () => {
    const rows = (category: string, start: number) =>
      Array.from({ length: 101 }, (_, index) => ({
        category,
        timestamp: '1000',
        blockNumber: '50',
        logIndex: start + index,
        transactionHash: `0x${String(start + index).padStart(64, '0')}`,
      }));
    const sources = [
      rows('loan', 0),
      rows('liquidation', 101),
      rows('vault', 202),
    ];
    const indexer = {
      query: vi.fn(async (_query: string, variables: { logIndex?: number }) => {
        const threshold =
          variables.logIndex === undefined ? Infinity : variables.logIndex;
        const items = sources.map((source) =>
          source
            .filter((item) => item.logIndex < threshold)
            .sort((a, b) => b.logIndex - a.logIndex)
            .slice(0, 101),
        );
        return {
          loan_blueChip: { items: items[0] },
          liquidation_blueChip: { items: items[1] },
          vault_blueChip: { items: items[2] },
        };
      }),
    };
    const service = new ActivityService(
      indexer as never,
      {
        all: () => [
          [
            'blueChip',
            { address: '0x0000000000000000000000000000000000000001' },
          ],
        ],
      } as never,
    );

    const address = '0x00000000000000000000000000000000000000aa';
    const first = await service.activity(address, 100);
    const second = await service.activity(
      address,
      100,
      first.nextCursor ?? undefined,
    );

    expect(first.items).toHaveLength(100);
    expect(second.items).toHaveLength(100);
    expect(
      new Set(
        [...first.items, ...second.items].map((item) => item.transactionHash),
      ),
    ).toHaveLength(200);
    expect(indexer.query.mock.calls[1][0]).toContain(
      'blockNumber: $blockNumber',
    );
  });
});
