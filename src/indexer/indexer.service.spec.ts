import { afterEach, describe, expect, it, vi } from 'vitest';
import { TtlCacheService } from '../shared/ttl-cache.service.js';
import { IndexerService } from './indexer.service.js';

const settings = {
  indexerStatusUrl: 'http://indexer/status',
  indexerGraphqlUrl: 'http://indexer/graphql',
  maxIndexerLagSeconds: 60,
};

function statusResponse(timestamp: number) {
  return {
    ok: true,
    json: async () => ({ robinhood: { block: { timestamp } } }),
  };
}

function service() {
  return new IndexerService(settings as never, new TtlCacheService());
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('IndexerService', () => {
  it('serves indexer data when lag is below the threshold', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(120_000);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(statusResponse(61))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: { pools: [] } }),
        }),
    );

    await expect(
      service().query('query { pools { items { id } } }'),
    ).resolves.toEqual({ pools: [] });
  });

  it('returns 503 when indexer lag exceeds the threshold', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(120_000);
    const fetch = vi.fn().mockResolvedValue(statusResponse(59));
    vi.stubGlobal('fetch', fetch);

    await expect(
      service().query('query { pools { items { id } } }'),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('serves data when lag is exactly at the threshold', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(120_000);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(statusResponse(60))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: { pools: [] } }),
        }),
    );

    await expect(
      service().query('query { pools { items { id } } }'),
    ).resolves.toEqual({ pools: [] });
  });

  it('recalculates lag during the status cache window before serving each query', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(120_000);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(statusResponse(61))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { pools: [] } }),
      });
    vi.stubGlobal('fetch', fetch);
    const indexer = service();

    await expect(
      indexer.query('query { pools { items { id } } }'),
    ).resolves.toEqual({
      pools: [],
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(
      indexer.query('query { pools { items { id } } }'),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'missing timestamp',
      { ok: true, json: async () => ({ robinhood: { block: {} } }) },
    ],
    ['non-200 status', { ok: false, json: async () => ({}) }],
    ['timeout', new Error('aborted')],
  ])(
    'returns 503 for an unavailable status endpoint (%s)',
    async (_name, response) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      await expect(
        service().query('query { pools { items { id } } }'),
      ).rejects.toMatchObject({ status: 503 });
    },
  );
});
