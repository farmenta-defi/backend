import { describe, expect, it, vi } from 'vitest';
import { KeeperService } from '../../src/keeper/keeper.service.js';

const pool = {
  id: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const,
  currency0: '0x0000000000000000000000000000000000000001' as const,
  currency1: '0x0000000000000000000000000000000000000002' as const,
  fee: 3_000,
  tickSpacing: 60,
  hooks: '0x0000000000000000000000000000000000000000' as const,
  observationAgeSeconds: 601,
};

describe('KeeperService', () => {
  it('records only pools with outstanding debt in one batch and alerts on stale observations', async () => {
    const indexer = {
      assertFresh: vi.fn(),
      candidates: vi.fn().mockResolvedValue([
        { market: '0x0000000000000000000000000000000000000003', tokenId: 1n, poolId: pool.id },
        { market: '0x0000000000000000000000000000000000000003', tokenId: 2n, poolId: pool.id },
      ]),
      pools: vi.fn().mockResolvedValue([pool]),
    };
    const chain = {
      debts: vi.fn().mockResolvedValue([10n, 0n]),
      observationCounts: vi.fn().mockResolvedValue([0]),
      recordBatch: vi.fn().mockResolvedValue({ hash: '0xtransaction', gasUsed: 221_184n, gasPrice: 20_000_000n }),
    };
    const runs = { save: vi.fn(), heartbeat: vi.fn(), dailyCostUsd: vi.fn().mockResolvedValue(1) };
    const alerts = { send: vi.fn() };
    const service = new KeeperService(indexer, chain, runs, alerts, () => 1_700_000_000);

    await expect(service.run({ dryRun: false })).resolves.toMatchObject({
      poolCount: 1,
      transactionHash: '0xtransaction',
    });
    expect(chain.recordBatch).toHaveBeenCalledWith([pool]);
    expect(alerts.send).toHaveBeenCalledWith(expect.stringContaining(pool.id));
    expect(runs.save).toHaveBeenCalledWith(expect.objectContaining({ gasUsed: 221_184n }));
    expect(runs.heartbeat).toHaveBeenCalledOnce();
  });

  it('prints the batch without sending it in dry-run mode', async () => {
    const indexer = {
      assertFresh: vi.fn(),
      candidates: vi.fn().mockResolvedValue([{ market: '0x0000000000000000000000000000000000000003', tokenId: 1n, poolId: pool.id }]),
      pools: vi.fn().mockResolvedValue([pool]),
    };
    const chain = { debts: vi.fn().mockResolvedValue([1n]), observationCounts: vi.fn(), recordBatch: vi.fn() };
    const runs = { save: vi.fn(), heartbeat: vi.fn(), dailyCostUsd: vi.fn() };
    const alerts = { send: vi.fn() };
    const service = new KeeperService(indexer, chain, runs, alerts, () => 1_700_000_000);

    await expect(service.run({ dryRun: true })).resolves.toMatchObject({ poolCount: 1, dryRun: true });
    expect(chain.recordBatch).not.toHaveBeenCalled();
    expect(runs.save).not.toHaveBeenCalled();
  });
});
