import { Injectable } from '@nestjs/common';

type Entry<T> = { expiresAt: number; value: Promise<T> };

/** Small in-process cache for RPC/indexer aggregate reads. Values never outlive 30 seconds. */
@Injectable()
export class TtlCacheService {
  private readonly entries = new Map<string, Entry<unknown>>();

  get<T>(key: string, load: () => Promise<T>, ttlMs = 30_000): Promise<T> {
    const current = this.entries.get(key) as Entry<T> | undefined;
    if (current && current.expiresAt > Date.now()) return current.value;
    const value = load().catch((error) => {
      this.entries.delete(key);
      throw error;
    });
    this.entries.set(key, { value, expiresAt: Date.now() + Math.min(ttlMs, 30_000) });
    return value;
  }
}
