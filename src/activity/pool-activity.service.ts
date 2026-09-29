import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { IndexerService } from '../indexer/indexer.service.js';
import { MarketsService } from '../markets/markets.service.js';
import { TtlCacheService } from '../shared/ttl-cache.service.js';

const KINDS = ['deposit', 'withdraw', 'borrow', 'repay', 'liquidation'] as const;
type PoolActivityKind = (typeof KINDS)[number];
type ActivityRow = {
  market: string;
  poolId: string;
  timestamp: string;
  blockNumber: string;
  logIndex: number;
  transactionHash: string;
  tokenId: string;
  owner: string;
  kind: PoolActivityKind;
  amountUsdg: string | null;
  liquidator?: string;
  repaidUsdg?: string;
  badDebtUsdg?: string;
  full?: boolean;
};
type PoolActivityData = Record<
  string,
  | { items: Array<Omit<ActivityRow, 'kind'> & { kind: string }> }
  | {
      items: Array<
        Omit<ActivityRow, 'kind' | 'amountUsdg'> & {
          liquidator: string;
          repaidUsdg: string;
          badDebtUsdg: string;
          full: boolean;
        }
      >;
    }
>;

type ActivityMarket = { address: string };

type ActivityItem =
  | (Omit<ActivityRow, 'kind'> & { kind: string })
  | (Omit<ActivityRow, 'kind' | 'amountUsdg'> & {
      liquidator: string;
      repaidUsdg: string;
      badDebtUsdg: string;
      full: boolean;
    });

function itemsForMarkets<T extends ActivityItem>(
  data: PoolActivityData,
  prefix: string,
): T[] {
  return Object.entries(data)
    .filter(([key]) => key.startsWith(`${prefix}_`))
    .flatMap(([, result]) => result.items as T[]);
};

@Injectable()
export class PoolActivityService {
  constructor(
    private readonly indexer: IndexerService,
    private readonly markets: MarketsService,
    private readonly cache: TtlCacheService,
  ) {}

  async activity(
    poolId: string,
    limit = 25,
    cursor?: string,
    kind?: string,
  ) {
    if (!/^0x[\da-f]{64}$/i.test(poolId))
      throw new BadRequestException('poolId must be a 32-byte hex value');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new BadRequestException('limit must be between 1 and 100');
    if (cursor !== undefined && !isCursor(cursor))
      throw new BadRequestException('cursor must be blockNumber:logIndex');
    if (kind !== undefined && !KINDS.includes(kind as PoolActivityKind))
      throw new BadRequestException('kind must be deposit, withdraw, borrow, repay, or liquidation');

    const normalizedPoolId = poolId.toLowerCase();
    const normalizedKind = kind as PoolActivityKind | undefined;
    const markets = await this.markets.findListedMarkets(normalizedPoolId);
    if (markets.length === 0)
      throw new NotFoundException('Pool is not listed');
    await this.indexer.assertFresh();
    return this.cache.get(
      `pool-activity:${normalizedPoolId}:${limit}:${cursor ?? ''}:${kind ?? ''}`,
      async () => {
        const [blockNumber, logIndex] = cursor?.split(':') ?? [];
        const data = await this.indexer.query<PoolActivityData>(
          poolActivityQuery(markets, normalizedKind, cursor !== undefined),
          {
            poolId: normalizedPoolId,
            limit: limit + 1,
            ...Object.fromEntries(
              markets.map((market, index) => [`market${index}`, market.address]),
            ),
            ...(blockNumber !== undefined
              ? { blockNumber, logIndex: Number(logIndex) }
              : {}),
          },
        );
        const entries: ActivityRow[] = [
          ...itemsForMarkets<Omit<ActivityRow, 'kind'> & { kind: string }>(data, 'loanActivity').map((item) => ({
            ...item,
            kind: item.kind as PoolActivityKind,
            amountUsdg: item.amountUsdg ?? null,
          })),
          ...itemsForMarkets<Extract<ActivityItem, { liquidator: string }>>(data, 'liquidations').map((item) => ({
            ...item,
            kind: 'liquidation' as const,
            amountUsdg: null,
          })),
        ].sort(compareActivity);
        const items = entries.slice(0, limit);
        const last = items.at(-1);
        return {
          items,
          nextCursor: last ? `${last.blockNumber}:${last.logIndex}` : null,
          hasMore: entries.length > limit,
        };
      },
    );
  }
}

function poolActivityQuery(
  markets: ActivityMarket[],
  kind?: PoolActivityKind,
  hasCursor = false,
) {
  const cursorVariables = hasCursor
    ? ', $blockNumber: BigInt!, $logIndex: Int!'
    : '';
  const cursorFilter = hasCursor
    ? ', OR: [{ blockNumber_lt: $blockNumber }, { AND: [{ blockNumber: $blockNumber }, { logIndex_lt: $logIndex }] }]'
    : '';
  const loanKind = kind && kind !== 'liquidation' ? `, kind: "${kind}"` : '';
  const marketVariables = markets.map((_, index) => `$market${index}: String!`).join(', ');
  const queries = markets.flatMap((_, index) => {
    const marketFilter = `market: $market${index}`;
    const loanQuery = kind === 'liquidation'
      ? ''
      : `loanActivity_${index}: loanActivitys(where: { poolId: $poolId, ${marketFilter}${loanKind}${cursorFilter} }, orderBy: "blockNumber", orderDirection: "desc", limit: $limit) { items { market poolId blockNumber logIndex timestamp transactionHash tokenId owner kind amountUsdg } }`;
    const liquidationQuery = kind && kind !== 'liquidation'
      ? ''
      : `liquidations_${index}: liquidations(where: { poolId: $poolId, ${marketFilter}${cursorFilter} }, orderBy: "blockNumber", orderDirection: "desc", limit: $limit) { items { market poolId blockNumber logIndex timestamp transactionHash tokenId owner liquidator full repaidUsdg badDebtUsdg } }`;
    return [loanQuery, liquidationQuery].filter(Boolean);
  });
  return `query PoolActivity($poolId: String!, $limit: Int!${marketVariables ? `, ${marketVariables}` : ''}${cursorVariables}) { ${queries.join('\n')} }`;
}

function compareActivity(a: ActivityRow, b: ActivityRow) {
  return Number(BigInt(b.blockNumber) - BigInt(a.blockNumber)) || b.logIndex - a.logIndex;
}

function isCursor(cursor: string) {
  const [blockNumber, logIndex, extra] = cursor.split(':');
  return extra === undefined && /^\d+$/.test(blockNumber ?? '') && /^\d+$/.test(logIndex ?? '');
}
