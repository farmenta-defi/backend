import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { SettingsService } from '../config/settings.service.js';
import { TtlCacheService } from '../shared/ttl-cache.service.js';

@Injectable()
export class IndexerService {
  constructor(private readonly settings: SettingsService, private readonly cache: TtlCacheService) {}

  query<T>(query: string, variables: Record<string, unknown> = {}, cacheKey?: string): Promise<T> {
    const load = async () => {
      try {
        const response = await fetch(this.settings.indexerGraphqlUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(5_000),
      });
        if (!response.ok) throw new ServiceUnavailableException('Indexer is unavailable');
        const body = await response.json() as { data?: T; errors?: Array<{ message: string }> };
        if (body.errors?.length || !body.data) throw new ServiceUnavailableException('Indexer query failed');
        return body.data;
      } catch (error) {
        if (error instanceof ServiceUnavailableException) throw error;
        throw new ServiceUnavailableException('Indexer is unavailable');
      }
    };
    return cacheKey ? this.cache.get(`indexer:${cacheKey}`, load) : load();
  }
}
