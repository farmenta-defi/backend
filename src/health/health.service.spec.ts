import { describe, expect, it, vi } from 'vitest';
import { HealthService } from './health.service.js';

describe('HealthService', () => {
  it('reports database, RPC, and indexer checks separately', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(120_000));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ robinhood: { block: { timestamp: 100 } } }),
    }));
    const service = new HealthService(
      { ping: vi.fn().mockResolvedValue(undefined) },
      { getBlockNumber: vi.fn().mockResolvedValue(123n) },
      { indexerStatusUrl: 'http://indexer/status' },
    );

    await expect(service.getHealth()).resolves.toMatchObject({
      status: 'ok',
      database: { status: 'ok' },
      rpc: { status: 'ok', blockNumber: '123' },
      indexer: { status: 'ok', lagSeconds: 20 },
    });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
