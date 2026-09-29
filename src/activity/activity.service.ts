import { BadRequestException, Injectable } from '@nestjs/common';
import { isAddress } from 'viem';
import { IndexerService } from '../indexer/indexer.service.js';
import { DeploymentService } from '../markets/deployment.service.js';

@Injectable()
export class ActivityService {
  constructor(
    private readonly indexer: IndexerService,
    private readonly deployments: DeploymentService,
  ) {}
  async activity(address: string, limit = 25, cursor?: string) {
    if (!isAddress(address) || /^0x0{40}$/i.test(address))
      throw new BadRequestException('address must be a non-zero address');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new BadRequestException('limit must be between 1 and 100');
    if (cursor && !isCursor(cursor))
      throw new BadRequestException('cursor must be blockNumber:logIndex');
    const markets = this.deployments.all().map(([name, market]) => ({
      name,
      address: market.address,
    }));
    const data = await this.indexer.query<ActivityData>(
      activityQuery(markets, cursor),
      activityVariables(address, limit, markets, cursor),
    );
    const entries = [
      ...activityItems(data, 'loan'),
      ...activityItems(data, 'liquidation'),
      ...activityItems(data, 'vault'),
    ].sort(compareActivity);
    const page = entries.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page,
      nextCursor: last ? cursorOf(last) : null,
      hasMore: entries.length > limit,
    };
  }
}

type Activity = {
  timestamp: string;
  blockNumber: string;
  logIndex: number;
  [key: string]: unknown;
};
type ActivityData = {
  [alias: string]: { items: Activity[] };
};
function compareActivity(a: Activity, b: Activity) {
  return (
    Number(BigInt(b.blockNumber) - BigInt(a.blockNumber)) ||
    b.logIndex - a.logIndex
  );
}
function cursorOf(value: Activity) {
  return `${value.blockNumber}:${value.logIndex}`;
}
function isCursor(cursor: string) {
  const [blockNumber, logIndex, extra] = cursor.split(':');
  return (
    extra === undefined &&
    /^\d+$/.test(blockNumber ?? '') &&
    /^\d+$/.test(logIndex ?? '')
  );
}

function activityQuery(
  markets: Array<{ name: string; address: string }>,
  cursor?: string,
) {
  const fields = markets.flatMap(({ name }, index) => [
    `${alias('loan', name)}: loanActivitys(where: ${activityWhere(index, cursor)}, orderBy: "blockNumber", orderDirection: "desc", limit: $limit) { items { market blockNumber logIndex timestamp transactionHash tokenId owner kind amountUsdg } }`,
    `${alias('liquidation', name)}: liquidations(where: ${activityWhere(index, cursor)}, orderBy: "blockNumber", orderDirection: "desc", limit: $limit) { items { market blockNumber logIndex timestamp transactionHash tokenId full repaidUsdg badDebtUsdg } }`,
    `${alias('vault', name)}: vaultActivitys(where: ${activityWhere(index, cursor)}, orderBy: "blockNumber", orderDirection: "desc", limit: $limit) { items { market blockNumber logIndex timestamp transactionHash kind assetsUsdg shares } }`,
  ]);
  const marketVariables = markets
    .map((_, index) => `$market${index}: String!`)
    .join(', ');
  const cursorVariables = cursor
    ? ', $blockNumber: BigInt!, $logIndex: Int!'
    : '';
  return `query Activity($owner: String!, $limit: Int!${marketVariables ? `, ${marketVariables}` : ''}${cursorVariables}) { ${fields.join('\n')} }`;
}
function activityWhere(index: number, cursor?: string) {
  const base = `owner: $owner, market: $market${index}`;
  return cursor
    ? `{ ${base}, OR: [{ blockNumber_lt: $blockNumber }, { AND: [{ blockNumber: $blockNumber }, { logIndex_lt: $logIndex }] }] }`
    : `{ ${base} }`;
}
function activityVariables(
  address: string,
  limit: number,
  markets: Array<{ address: string }>,
  cursor?: string,
) {
  const marketVariables = Object.fromEntries(
    markets.map((market, index) => [`market${index}`, market.address]),
  );
  const [blockNumber, logIndex] = cursor?.split(':') ?? [];
  return {
    owner: address.toLowerCase(),
    limit: limit + 1,
    ...(blockNumber ? { blockNumber, logIndex: Number(logIndex) } : {}),
    ...marketVariables,
  };
}
function alias(category: string, market: string) {
  return `${category}_${market.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}
function activityItems(data: ActivityData, category: string) {
  return Object.entries(data)
    .filter(([key]) => key.startsWith(`${category}_`))
    .flatMap(([, value]) => value.items.map((item) => ({ ...item, category })));
}
