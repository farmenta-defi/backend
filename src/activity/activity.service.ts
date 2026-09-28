import { BadRequestException, Injectable } from '@nestjs/common';
import { isAddress } from 'viem';
import { IndexerService } from '../indexer/indexer.service.js';
import { TtlCacheService } from '../shared/ttl-cache.service.js';

// A composite cursor (timestamp:block:log) is stable even when several events share a timestamp.
const ACTIVITY = `query Activity($owner: String!, $limit: Int!) {
  loanActivities(where: { owner: { equals: $owner } }, orderBy: "timestamp_DESC", limit: $limit) { items { market blockNumber logIndex timestamp transactionHash tokenId owner kind amountUsdg } pageInfo { hasNextPage } }
  liquidations(where: { owner: { equals: $owner } }, orderBy: "timestamp_DESC", limit: $limit) { items { market blockNumber logIndex timestamp transactionHash tokenId full repaidUsdg badDebtUsdg } }
  vaultActivities(where: { owner: { equals: $owner } }, orderBy: "timestamp_DESC", limit: $limit) { items { market blockNumber logIndex timestamp transactionHash kind assetsUsdg shares } }
}`;

@Injectable()
export class ActivityService {
  constructor(private readonly indexer: IndexerService, private readonly cache: TtlCacheService) {}
  async activity(address: string, limit = 25, cursor?: string) {
    if (!isAddress(address) || /^0x0{40}$/i.test(address)) throw new BadRequestException('address must be a non-zero address');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('limit must be between 1 and 100');
    if (cursor && !isCursor(cursor)) throw new BadRequestException('cursor must be timestamp:blockNumber:logIndex');
    return this.cache.get(`activity:${address.toLowerCase()}:${limit}:${cursor ?? ''}`, async () => {
      const data = await this.indexer.query<ActivityData>(ACTIVITY, { owner: address.toLowerCase(), limit: 100 });
      const entries = [
        ...data.loanActivities.items.map((item) => ({ ...item, category: 'loan' })),
        ...data.liquidations.items.map((item) => ({ ...item, category: 'liquidation' })),
        ...data.vaultActivities.items.map((item) => ({ ...item, category: 'vault' })),
      ].filter((item) => !cursor || compareCursor(item, cursor) < 0).sort(compareActivity);
      const page = entries.slice(0, limit);
      const last = page.at(-1);
      return { items: page, nextCursor: last ? cursorOf(last) : null, hasMore: data.loanActivities.pageInfo.hasNextPage || entries.length > limit };
    });
  }
}

type Activity = { timestamp: string; blockNumber: string; logIndex: number; [key: string]: unknown };
type ActivityData = { loanActivities: { items: Activity[]; pageInfo: { hasNextPage: boolean; endCursor?: string } }; liquidations: { items: Activity[] }; vaultActivities: { items: Activity[] } };
function compareActivity(a: Activity, b: Activity) { return Number(BigInt(b.timestamp) - BigInt(a.timestamp)) || Number(BigInt(b.blockNumber) - BigInt(a.blockNumber)) || b.logIndex - a.logIndex; }
function cursorOf(value: Activity) { return `${value.timestamp}:${value.blockNumber}:${value.logIndex}`; }
function compareCursor(value: Activity, cursor: string) {
  const [timestamp, blockNumber, logIndex] = cursor.split(':');
  if (!timestamp || !blockNumber || logIndex === undefined) return 1;
  return compareActivity(value, { timestamp, blockNumber, logIndex: Number(logIndex) });
}
function isCursor(cursor: string) {
  const [timestamp, blockNumber, logIndex, extra] = cursor.split(':');
  return extra === undefined && /^\d+$/.test(timestamp ?? '') && /^\d+$/.test(blockNumber ?? '') && /^\d+$/.test(logIndex ?? '');
}
