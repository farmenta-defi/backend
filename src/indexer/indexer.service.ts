import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { SettingsService } from '../config/settings.service.js';
import { TtlCacheService } from '../shared/ttl-cache.service.js';

@Injectable()
export class IndexerService {
  constructor(
    private readonly settings: SettingsService,
    private readonly cache: TtlCacheService,
  ) {}

  async lagSeconds(): Promise<number> {
    const timestamp = await this.cache.get(
      'indexer:status-timestamp',
      async () => {
        try {
          const response = await fetch(this.settings.indexerStatusUrl, {
            signal: AbortSignal.timeout(3_000),
          });
          if (!response.ok) throw new Error('Indexer status failed');
          const payload = (await response.json()) as {
            robinhood?: { block?: { timestamp?: number } };
          };
          const timestamp = payload.robinhood?.block?.timestamp;
          if (
            typeof timestamp !== 'number' ||
            !Number.isFinite(timestamp) ||
            timestamp <= 0
          )
            throw new Error('Indexer status timestamp is unavailable');
          return timestamp;
        } catch {
          throw new ServiceUnavailableException('Indexer is unavailable');
        }
      },
      5_000,
    );
    return Math.max(0, Math.floor(Date.now() / 1_000) - timestamp);
  }

  async assertFresh(): Promise<number> {
    const lag = await this.lagSeconds();
    if (lag > this.settings.maxIndexerLagSeconds)
      throw new ServiceUnavailableException('Indexer is behind');
    return lag;
  }

  async query<T>(
    query: string,
    variables: Record<string, unknown> = {},
    cacheKey?: string,
  ): Promise<T> {
    await this.assertFresh();
    const load = async () => {
      try {
        const response = await fetch(this.settings.indexerGraphqlUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok)
          throw new ServiceUnavailableException('Indexer is unavailable');
        const body = (await response.json()) as {
          data?: T;
          errors?: Array<{ message: string }>;
        };
        if (body.errors?.length || !body.data)
          throw new ServiceUnavailableException('Indexer query failed');
        return body.data;
      } catch (error) {
        if (error instanceof ServiceUnavailableException) throw error;
        throw new ServiceUnavailableException('Indexer is unavailable');
      }
    };
    return cacheKey ? this.cache.get(`indexer:${cacheKey}`, load) : load();
  }
}
