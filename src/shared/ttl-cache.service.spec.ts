import { afterEach, describe, expect, it, vi } from 'vitest';
import { TtlCacheService } from './ttl-cache.service.js';

describe('TtlCacheService', () => {
  afterEach(() => vi.useRealTimers());

  it('caps requested TTL at thirty seconds and reloads expired entries', async () => {
    vi.useFakeTimers();
    const cache = new TtlCacheService();
    const load = vi
      .fn()
      .mockResolvedValueOnce('first')
      .mockResolvedValueOnce('second');

    await expect(cache.get('market', load, 60_000)).resolves.toBe('first');
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(cache.get('market', load, 60_000)).resolves.toBe('second');

    expect(load).toHaveBeenCalledTimes(2);
  });
});
