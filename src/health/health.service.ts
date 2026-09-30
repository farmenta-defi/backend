import { Injectable } from '@nestjs/common';
import { SettingsService } from '../config/settings.service.js';
import { RpcService } from '../rpc/rpc.service.js';
import { HealthRepository } from './health.repository.js';
import { IndexerService } from '../indexer/indexer.service.js';

@Injectable()
export class HealthService {
  constructor(
    private readonly repository: HealthRepository,
    private readonly rpc: RpcService,
    private readonly settings: SettingsService,
    private readonly indexer: IndexerService,
  ) {}

  async getHealth() {
    const [database, rpc, indexer] = await Promise.all([
      this.checkDatabase(),
      this.checkRpc(),
      this.checkIndexer(),
    ]);
    return {
      status: [database, rpc, indexer].every((check) => check.status === 'ok')
        ? 'ok'
        : 'error',
      checkedAt: new Date().toISOString(),
      database,
      rpc,
      indexer,
    };
  }

  private async checkDatabase() {
    try {
      await this.repository.ping();
      return { status: 'ok' as const };
    } catch {
      return { status: 'error' as const };
    }
  }

  private async checkRpc() {
    try {
      return {
        status: 'ok' as const,
        blockNumber: (await this.rpc.getBlockNumber()).toString(),
      };
    } catch {
      return { status: 'error' as const };
    }
  }

  private async checkIndexer() {
    try {
      const lagSeconds = await this.indexer.lagSeconds();
      return {
        status:
          lagSeconds <= this.settings.maxIndexerLagSeconds
            ? ('ok' as const)
            : ('error' as const),
        lagSeconds,
      };
    } catch {
      return { status: 'error' as const };
    }
  }
}
