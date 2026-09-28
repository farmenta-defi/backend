import { describe, expect, it, vi } from 'vitest';
import { DeploymentService } from './deployment.service.js';

describe('DeploymentService', () => {
  it('retries market metadata reads after a failed resolution', async () => {
    const policy = '0x0000000000000000000000000000000000000002';
    const valuer = '0x0000000000000000000000000000000000000003';
    const reads = new Map<string, number>();
    const readContract = vi.fn(
      async (_address: string, _abi: unknown, functionName: string) => {
        const count = (reads.get(functionName) ?? 0) + 1;
        reads.set(functionName, count);
        if (functionName === 'policy' && count === 1)
          throw new Error('temporary RPC outage');
        if (functionName === 'policy') return policy;
        if (functionName === 'valuer') return valuer;
        return 1;
      },
    );
    const service = new DeploymentService(
      { deployment: undefined } as never,
      { readContract } as never,
    );
    const deployment = {
      address: '0x0000000000000000000000000000000000000001',
      lens: '0x0000000000000000000000000000000000000004',
    } as const;

    await expect(service.resolve(deployment)).rejects.toThrow(
      'temporary RPC outage',
    );
    await expect(service.resolve(deployment)).resolves.toMatchObject({
      policy,
      valuer,
      tier: 1,
    });
    expect(readContract).toHaveBeenCalledTimes(6);
  });
});
