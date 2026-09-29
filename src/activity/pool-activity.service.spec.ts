import { describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PoolActivityService } from './pool-activity.service.js';
import { TtlCacheService } from '../shared/ttl-cache.service.js';

const POOL = `0x${'a'.repeat(64)}`;
const MARKET = '0x0000000000000000000000000000000000000001';
const OWNER = '0x00000000000000000000000000000000000000aa';

describe('PoolActivityService', () => {
  describe('positive', () => {
    it('filters kinds in the Ponder query and formats amounts as decimal strings', async () => {
      const indexer = {
        assertFresh: vi.fn(async () => undefined),
        query: vi.fn(async (_query: string, _variables: Record<string, unknown>) => ({
          loanActivitys: {
            items: [{
              market: MARKET,
              poolId: POOL,
              blockNumber: '42',
              logIndex: 3,
              timestamp: '1800000000',
              transactionHash: `0x${'1'.repeat(64)}`,
              tokenId: '7',
              owner: OWNER,
              kind: 'borrow',
              amountUsdg: '1230000',
            }],
          },
          liquidations: { items: [] },
        })),
      };
      const service = makeService(indexer);

      const page = await service.activity(POOL, 25, undefined, 'borrow');

      expect(page.items).toMatchObject([
        { kind: 'borrow', poolId: POOL, amountUsdg: '1230000', tokenId: '7' },
      ]);
      expect(page.nextCursor).toBe('42:3');
      expect(page.hasMore).toBe(false);
      expect(indexer.query.mock.calls[0]?.[0]).toContain('kind: "borrow"');
      expect(indexer.query.mock.calls[0]?.[0]).not.toContain('liquidations(');
    });
  });

  describe('negative', () => {
    it('rejects malformed pool ids and unknown kinds with 400', async () => {
      const service = makeService();

      await expect(service.activity('0x123')).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.activity(POOL, 25, undefined, 'supply')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('returns 404 when the pool is not listed', async () => {
      const service = makeService(undefined, false);

      await expect(service.activity(POOL)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('propagates the indexer stale-data 503', async () => {
      const service = makeService({
        assertFresh: vi.fn(async () => { throw new ServiceUnavailableException(); }),
        query: vi.fn(),
      });

      await expect(service.activity(POOL)).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe('edge case', () => {
    it('returns an empty first page and validates the inclusive pagination bounds', async () => {
      const service = makeService({
        assertFresh: vi.fn(async () => undefined),
        query: vi.fn(async () => ({ loanActivitys: { items: [] }, liquidations: { items: [] } })),
      });

      await expect(service.activity(POOL, 1, 'not-a-cursor')).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.activity(POOL, 0)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.activity(POOL, 101)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.activity(POOL)).resolves.toMatchObject({ items: [], nextCursor: null, hasMore: false });
    });
  });
});

function makeService(
  indexer: unknown = {
    assertFresh: vi.fn(async () => undefined),
    query: vi.fn(async () => ({ loanActivitys: { items: [] }, liquidations: { items: [] } })),
  },
  listed = true,
) {
  return new PoolActivityService(
    indexer as never,
    { findListedMarket: vi.fn(async () => listed ? { address: MARKET } : undefined) } as never,
    new TtlCacheService(),
  );
}
