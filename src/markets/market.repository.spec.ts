import { describe, expect, it, vi } from 'vitest';
import { MarketRepository } from './market.repository.js';

describe('MarketRepository', () => {
  it('rounds averaged on-chain integer amounts before returning decimal strings', async () => {
    const repository = new MarketRepository({
      databaseUrl: 'postgres://localhost/farmenta',
    } as never);
    const query = vi.fn().mockResolvedValue({ rows: [] });
    (
      repository as unknown as {
        pool: { query: typeof query; end: () => Promise<void> };
      }
    ).pool = { query, end: vi.fn().mockResolvedValue(undefined) };

    await repository.history(
      '0x0000000000000000000000000000000000000001',
      '1w',
    );

    expect(query.mock.calls[0][0]).toContain(
      'round(avg(total_assets))::numeric(78,0)::text',
    );
    expect(query.mock.calls[0][0]).toContain(
      'round(avg(total_borrows))::numeric(78,0)::text',
    );
    expect(query.mock.calls[0][0]).toContain(
      'round(avg(reserves))::numeric(78,0)::text',
    );
    expect(query.mock.calls[0][1]).toEqual([
      '0x0000000000000000000000000000000000000001',
      '30 minutes',
      '1 week',
    ]);
    await repository.onModuleDestroy();
  });
});
