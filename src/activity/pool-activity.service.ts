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
type PoolActivityData = {
  loanActivitys?: { items: Array<Omit<ActivityRow, 'kind'> & { kind: string }> };
  liquidations?: {
    items: Array<
      Omit<ActivityRow, 'kind' | 'amountUsdg'> & {
        liquidator: string;
        repaidUsdg: string;
        badDebtUsdg: string;
        full: boolean;
      }
    >;
  };
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
    if (!(await this.markets.findListedMarket(normalizedPoolId)))
      throw new NotFoundException('Pool is not listed');
    await this.indexer.assertFresh();
    return this.cache.get(
      `pool-activity:${normalizedPoolId}:${limit}:${cursor ?? ''}:${kind ?? ''}`,
      async () => {
        const [blockNumber, logIndex] = cursor?.split(':') ?? [];
        const data = await this.indexer.query<PoolActivityData>(
          poolActivityQuery(normalizedKind, cursor !== undefined),
          {
            poolId: normalizedPoolId,
            limit: limit + 1,
            ...(blockNumber !== undefined
              ? { blockNumber, logIndex: Number(logIndex) }
              : {}),
          },
        );
        const entries: ActivityRow[] = [
          ...(data.loanActivitys?.items ?? []).map((item) => ({
            ...item,
            kind: item.kind as PoolActivityKind,
            amountUsdg: item.amountUsdg ?? null,
          })),
          ...(data.liquidations?.items ?? []).map((item) => ({
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

function poolActivityQuery(kind?: PoolActivityKind, hasCursor = false) {
  const cursorVariables = hasCursor
    ? ', $blockNumber: BigInt!, $logIndex: Int!'
    : '';
  const cursorFilter = hasCursor
    ? ', OR: [{ blockNumber_lt: $blockNumber }, { AND: [{ blockNumber: $blockNumber }, { logIndex_lt: $logIndex }] }]'
    : '';
  const loanKind = kind && kind !== 'liquidation' ? `, kind: "${kind}"` : '';
  const loanQuery = kind === 'liquidation'
    ? ''
    : `loanActivitys(where: { poolId: $poolId${loanKind}${cursorFilter} }, orderBy: "blockNumber", orderDirection: "desc", limit: $limit) { items { market poolId blockNumber logIndex timestamp transactionHash tokenId owner kind amountUsdg } }`;
  const liquidationQuery = kind && kind !== 'liquidation'
    ? ''
    : `liquidations(where: { poolId: $poolId${cursorFilter} }, orderBy: "blockNumber", orderDirection: "desc", limit: $limit) { items { market poolId blockNumber logIndex timestamp transactionHash tokenId owner liquidator full repaidUsdg badDebtUsdg } }`;
  return `query PoolActivity($poolId: String!, $limit: Int!${cursorVariables}) { ${loanQuery} ${liquidationQuery} }`;
}

function compareActivity(a: ActivityRow, b: ActivityRow) {
  return Number(BigInt(b.blockNumber) - BigInt(a.blockNumber)) || b.logIndex - a.logIndex;
}

function isCursor(cursor: string) {
  const [blockNumber, logIndex, extra] = cursor.split(':');
  return extra === undefined && /^\d+$/.test(blockNumber ?? '') && /^\d+$/.test(logIndex ?? '');
}
