import { Injectable } from '@nestjs/common';
import { SettingsService } from '../config/settings.service.js';
import { RpcService } from '../rpc/rpc.service.js';
import { HealthRepository } from './health.repository.js';

@Injectable()
export class HealthService {
  constructor(
    private readonly repository: HealthRepository,
    private readonly rpc: RpcService,
    private readonly settings: SettingsService,
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
      return { status: 'ok' as const, blockNumber: (await this.rpc.getBlockNumber()).toString() };
    } catch {
      return { status: 'error' as const };
    }
  }

  private async checkIndexer() {
    try {
      const response = await fetch(this.settings.indexerStatusUrl, {
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) return { status: 'error' as const };
      const payload = (await response.json()) as { robinhood?: { block?: { timestamp?: number } } };
      const timestamp = payload.robinhood?.block?.timestamp;
      if (!timestamp) return { status: 'error' as const };
      return {
        status: 'ok' as const,
        lagSeconds: Math.max(0, Math.floor(Date.now() / 1_000) - timestamp),
      };
    } catch {
      return { status: 'error' as const };
    }
  }
}
