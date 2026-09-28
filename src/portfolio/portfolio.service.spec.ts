import { describe, expect, it, vi } from 'vitest';
import { PortfolioService } from './portfolio.service.js';

describe('PortfolioService', () => {
  it('returns listed wallet NFTs and custody positions with capped collateral separate from uncapped fees', async () => {
    const market = '0x0000000000000000000000000000000000000001';
    const policy = '0x0000000000000000000000000000000000000002';
    const rpc = {
      readContract: vi.fn(async (_address: string, _abi: unknown, functionName: string, args: readonly unknown[]) => {
        if (functionName === 'listingOf') return { listed: true };
        if (functionName === 'debtOf') return 25n;
        if (functionName === 'positionValue') return 110n; // principal 100 + fee capped at 10
        if (functionName === 'healthFactor') return 2n * 10n ** 18n;
        if (functionName === 'value') return [0n, 0n, 0n, 0n, 0n, 100n, 80n, 0n]; // fee > 10% principal
        if (functionName === 'convertToAssets') return BigInt(args[0] as string);
        throw new Error(`unexpected ${functionName}`);
      }),
    };
    const service = new PortfolioService(
      { query: vi.fn().mockResolvedValue({ positions: { items: [{ tokenId: '1', poolId: `0x${'a'.repeat(64)}` }, { tokenId: '2', poolId: `0x${'b'.repeat(64)}` }] }, loans: { items: [{ market, tokenId: '3', poolId: `0x${'c'.repeat(64)}`, status: 'in_custody' }] }, vaultBalances: { items: [] } }) },
      { all: () => [['blueChip', { address: market, policy, lens: '0x0000000000000000000000000000000000000003', valuer: '0x0000000000000000000000000000000000000004', tier: 1 }]] }, rpc,
      { get: (_key: string, load: () => Promise<unknown>) => load() },
    );
    const result = await service.portfolio('0x00000000000000000000000000000000000000aa');
    expect(result.positions).toHaveLength(3);
    expect(result.positions).toEqual(expect.arrayContaining([
      expect.objectContaining({ tokenId: '1', status: 'wallet' }),
      expect.objectContaining({ tokenId: '2', status: 'wallet' }),
      expect.objectContaining({ tokenId: '3', status: 'in_custody', collateralUsd: '110', uncollectedFeesUsd: '80' }),
    ]));
  });
});
