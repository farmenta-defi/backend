import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  const servers: Server[] = [];
  afterEach(() => servers.splice(0).forEach((server) => server.close()));

  async function rpcServer(
    answer: (method: string) => { status: number; body?: unknown },
  ) {
    const calls: string[] = [];
    const server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => (raw += chunk));
      request.on('end', () => {
        const { id, method } = JSON.parse(raw) as {
          id: number;
          method: string;
        };
        calls.push(method);
        const { status, body } = answer(method);
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify(
            body ?? {
              jsonrpc: '2.0',
              id,
              error: { code: -32000, message: 'down' },
            },
          ).replace('"__ID__"', String(id)),
        );
      });
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    return {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      calls,
    };
  }

  it('answers from RPC_FALLBACK_URL when RPC_URL fails', async () => {
    const primary = await rpcServer(() => ({ status: 500 }));
    const backup = await rpcServer(() => ({
      status: 200,
      body: { jsonrpc: '2.0', id: '__ID__', result: '0x2a' },
    }));
    const service = new RpcService({
      rpcUrl: primary.url,
      rpcFallbackUrl: backup.url,
    } as never);

    await expect(service.getBlockNumber()).resolves.toBe(42n);
    expect(primary.calls).toEqual(['eth_blockNumber']);
    expect(backup.calls).toEqual(['eth_blockNumber']);
  });

  it('tries RPC_URL once when no fallback is set', async () => {
    const primary = await rpcServer(() => ({ status: 500 }));
    const service = new RpcService({ rpcUrl: primary.url } as never);

    await expect(service.getBlockNumber()).rejects.toMatchObject({
      status: 503,
    });
    expect(primary.calls).toEqual(['eth_blockNumber']);
  });
});
