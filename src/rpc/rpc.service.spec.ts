import { describe, expect, it, vi } from 'vitest';
import { RpcService } from './rpc.service.js';

describe('RpcService', () => {
  it('maps provider failures to a sanitized 503 response', async () => {
    const service = new RpcService({
      rpcUrl: 'http://127.0.0.1:9/v2/secret-token',
    } as never);
    (
      service as unknown as {
        client: { getBlockNumber: () => Promise<bigint> };
      }
    ).client = {
      getBlockNumber: vi
        .fn()
        .mockRejectedValue(
          new Error('request failed for http://127.0.0.1:9/v2/secret-token'),
        ),
    };

    await expect(service.getBlockNumber()).rejects.toMatchObject({
      status: 503,
      message: 'RPC is unavailable',
    });
    await expect(service.getBlockNumber()).rejects.not.toThrow('secret-token');
  });
});
