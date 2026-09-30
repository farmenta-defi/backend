import { describe, expect, it, vi } from 'vitest';
import { HealthService } from './health.service.js';

function service(lagSeconds: number | Error, maxIndexerLagSeconds = 60) {
  return new HealthService(
    { ping: vi.fn().mockResolvedValue(undefined) } as never,
    { getBlockNumber: vi.fn().mockResolvedValue(123n) } as never,
    { maxIndexerLagSeconds } as never,
    {
      lagSeconds:
        typeof lagSeconds === 'number'
          ? vi.fn().mockResolvedValue(lagSeconds)
          : vi.fn().mockRejectedValue(lagSeconds),
    } as never,
  );
}

describe('HealthService', () => {
  it('reports indexer healthy below the configured lag threshold', async () => {
    await expect(service(59).getHealth()).resolves.toMatchObject({
      status: 'ok',
      database: { status: 'ok' },
      rpc: { status: 'ok', blockNumber: '123' },
      indexer: { status: 'ok', lagSeconds: 59 },
    });
  });

  it('reports indexer and overall health as error above the threshold, retaining lag', async () => {
    await expect(service(61).getHealth()).resolves.toMatchObject({
      status: 'error',
      indexer: { status: 'error', lagSeconds: 61 },
    });
  });

  it('accepts lag exactly at the configured threshold', async () => {
    await expect(service(60).getHealth()).resolves.toMatchObject({
      status: 'ok',
      indexer: { status: 'ok', lagSeconds: 60 },
    });
  });

  it.each(['missing timestamp', 'non-200 response', 'timeout'])(
    'reports indexer unavailable for %s',
    async () => {
      await expect(
        service(new Error('Indexer is unavailable')).getHealth(),
      ).resolves.toMatchObject({
        status: 'error',
        indexer: { status: 'error' },
      });
    },
  );
});
