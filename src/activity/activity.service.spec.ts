import { describe, expect, it, vi } from 'vitest';
import { ActivityService } from './activity.service.js';

describe('ActivityService', () => {
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
      query: vi.fn(async (query: string) => {
        const cursor = /logIndex_lt: (\d+)/.exec(query)?.[1];
        const threshold = cursor === undefined ? Infinity : Number(cursor);
        const items = sources.map((source) =>
          source
            .filter((item) => item.logIndex < threshold)
            .sort((a, b) => b.logIndex - a.logIndex)
            .slice(0, 101),
        );
        return {
          loanActivitys: { items: items[0] },
          liquidations: { items: items[1] },
          vaultActivitys: { items: items[2] },
        };
      }),
    };
    const service = new ActivityService(
      indexer as never,
      { get: (_key: string, load: () => Promise<unknown>) => load() } as never,
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
    expect(indexer.query.mock.calls[1][0]).toContain('logIndex_lt: 203');
  });
});
