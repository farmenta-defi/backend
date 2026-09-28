import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { isAddress } from 'viem';
import { IndexerService } from '../indexer/indexer.service.js';
import { RpcService } from '../rpc/rpc.service.js';
import { TtlCacheService } from '../shared/ttl-cache.service.js';
import { lensAbi, marketAbi, valuerAbi } from '../markets/contracts.js';
import { DeploymentService } from '../markets/deployment.service.js';
import { MarketsService } from '../markets/markets.service.js';

const PORTFOLIO_POSITIONS = `query PortfolioPositions($owner: String!, $after: String) {
  positions(where: { owner: $owner }, limit: 1000, after: $after) { items { tokenId poolId tickLower tickUpper liquidity } pageInfo { hasNextPage endCursor } }
}`;
const PORTFOLIO_LOANS = `query PortfolioLoans($owner: String!, $after: String) {
  loans(where: { owner: $owner, status: "in_custody" }, limit: 1000, after: $after) { items { market tokenId poolId status } pageInfo { hasNextPage endCursor } }
}`;
const PORTFOLIO_VAULTS = `query PortfolioVaults($owner: String!, $after: String) {
  vaultBalances(where: { account: $owner }, limit: 1000, after: $after) { items { market shares } pageInfo { hasNextPage endCursor } }
}`;

@Injectable()
export class PortfolioService {
  constructor(
    private readonly indexer: IndexerService,
    private readonly deployments: DeploymentService,
    private readonly markets: MarketsService,
    private readonly rpc: RpcService,
    private readonly cache: TtlCacheService,
  ) {}

  async portfolio(address: string) {
    if (!isAddress(address) || /^0x0{40}$/i.test(address))
      throw new BadRequestException('address must be a non-zero address');
    return this.cache.get(`portfolio:${address.toLowerCase()}`, async () => {
      const owner = address.toLowerCase();
      const [positions, loans, vaultBalances] = await Promise.all([
        this.loadCollection<Record<string, unknown>, 'positions'>(
          PORTFOLIO_POSITIONS,
          'positions',
          owner,
        ),
        this.loadCollection<Loan, 'loans'>(PORTFOLIO_LOANS, 'loans', owner),
        this.loadCollection<
          { market: `0x${string}`; shares: string },
          'vaultBalances'
        >(PORTFOLIO_VAULTS, 'vaultBalances', owner),
      ]);
      const wallet = await this.enrichWalletPositions(positions);
      const custody = await Promise.all(
        loans.map((loan) => this.enrichLoan(loan)),
      );
      const vaultShares = await Promise.all(
        vaultBalances.map(async (share) => ({
          ...share,
          assetsUsdg: (
            await this.rpc.readContract<bigint>(
              share.market,
              marketAbi,
              'convertToAssets',
              [BigInt(share.shares)],
            )
          ).toString(),
        })),
      );
      return {
        address: address.toLowerCase(),
        positions: [...wallet, ...custody],
        vaultShares,
      };
    });
  }

  private async loadCollection<
    T,
    K extends 'positions' | 'loans' | 'vaultBalances',
  >(query: string, key: K, owner: string): Promise<T[]> {
    const items: T[] = [];
    let after: string | undefined;
    do {
      const data = await this.indexer.query<
        Record<
          K,
          { items: T[]; pageInfo: { hasNextPage: boolean; endCursor?: string } }
        >
      >(query, { owner, after }, `portfolio:${key}:${owner}:${after ?? ''}`);
      const page = data[key];
      items.push(...page.items);
      if (page.pageInfo.hasNextPage && !page.pageInfo.endCursor)
        throw new ServiceUnavailableException(
          'Indexer pagination is unavailable',
        );
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : undefined;
    } while (after);
    return items;
  }

  private async enrichWalletPositions(
    positions: Array<Record<string, unknown>>,
  ) {
    const listedByPool = new Map<
      string,
      Awaited<ReturnType<MarketsService['findListedMarket']>>
    >();
    const poolIds = [
      ...new Set(
        positions
          .map((position) => position.poolId)
          .filter((poolId): poolId is string => typeof poolId === 'string'),
      ),
    ];
    await Promise.all(
      poolIds.map(async (poolId) =>
        listedByPool.set(
          poolId.toLowerCase(),
          await this.markets.findListedMarket(poolId),
        ),
      ),
    );
    const listed = positions.flatMap((position) => {
      const poolId = position.poolId;
      const market =
        typeof poolId === 'string'
          ? listedByPool.get(poolId.toLowerCase())
          : undefined;
      return market ? [{ position, market }] : [];
    });
    if (!listed.length) return [];
    const results = (await this.rpc.multicall(
      listed.map(({ position, market }) => ({
        address: market!.valuer,
        abi: valuerAbi,
        functionName: 'value',
        args: [BigInt(position.tokenId as string)],
      })),
    )) as MulticallResult[];
    return listed.map(({ position }, index) =>
      this.walletPosition(position, results[index]),
    );
  }

  private walletPosition(
    position: Record<string, unknown>,
    call: MulticallResult,
  ) {
    const valuation = resultOf(call) as readonly unknown[] | null;
    if (!valuation)
      return {
        ...position,
        status: 'wallet',
        valueUsd: null,
        uncollectedFeesUsd: null,
        composition: null,
        valuationError: 'unavailable',
      };
    const principalUsd = BigInt(valuation[5] as bigint);
    const feesUsd = BigInt(valuation[6] as bigint);
    return {
      ...position,
      status: 'wallet',
      valueUsd: (principalUsd + feesUsd).toString(),
      uncollectedFeesUsd: feesUsd.toString(),
      composition: {
        amount0: BigInt(valuation[1] as bigint).toString(),
        amount1: BigInt(valuation[2] as bigint).toString(),
        fees0: BigInt(valuation[3] as bigint).toString(),
        fees1: BigInt(valuation[4] as bigint).toString(),
      },
    };
  }

  private async enrichLoan(loan: Loan) {
    const deployment = await Promise.all(
      this.deployments
        .all()
        .map(([, value]) => this.deployments.resolve(value)),
    ).then((markets) =>
      markets.find(
        (value) => value.address.toLowerCase() === loan.market.toLowerCase(),
      ),
    );
    if (!deployment) return { ...loan, status: 'in_custody' };
    const tokenId = BigInt(loan.tokenId);
    const calls = (await this.rpc.multicall([
      {
        address: deployment.address,
        abi: marketAbi,
        functionName: 'debtOf',
        args: [tokenId],
      },
      {
        address: deployment.lens,
        abi: lensAbi,
        functionName: 'positionValue',
        args: [tokenId],
      },
      {
        address: deployment.lens,
        abi: lensAbi,
        functionName: 'healthFactor',
        args: [tokenId],
      },
      {
        address: deployment.valuer,
        abi: valuerAbi,
        functionName: 'value',
        args: [tokenId],
      },
    ])) as MulticallResult[];
    const [debt, collateralUsd, healthFactor, valuation] = calls.map(
      resultOf,
    ) as [
      bigint | null,
      bigint | null,
      bigint | null,
      readonly unknown[] | null,
    ];
    // IPositionValuer.Valuation: feesUsd is index 6 and intentionally has no 10% cap.
    if (
      !valuation ||
      collateralUsd === null ||
      debt === null ||
      healthFactor === null
    )
      return {
        ...loan,
        debtUsdg: debt?.toString() ?? null,
        collateralUsd: null,
        principalUsd: null,
        uncollectedFeesUsd: null,
        composition: null,
        healthFactor: null,
        valuationError: 'unavailable',
        status: 'in_custody',
      };
    return {
      ...loan,
      debtUsdg: debt.toString(),
      collateralUsd: collateralUsd.toString(),
      principalUsd: BigInt(valuation[5] as bigint).toString(),
      uncollectedFeesUsd: BigInt(valuation[6] as bigint).toString(),
      composition: {
        amount0: BigInt(valuation[1] as bigint).toString(),
        amount1: BigInt(valuation[2] as bigint).toString(),
        fees0: BigInt(valuation[3] as bigint).toString(),
        fees1: BigInt(valuation[4] as bigint).toString(),
      },
      healthFactor:
        healthFactor === 2n ** 256n - 1n ? null : healthFactor.toString(),
      status: 'in_custody',
    };
  }
}

type Loan = {
  market: `0x${string}`;
  tokenId: string;
  poolId: string;
  status: string;
};
type MulticallResult =
  | { status: 'success'; result: unknown }
  | { status: 'failure'; error: unknown };
function resultOf(call: MulticallResult) {
  return call.status === 'success' ? call.result : null;
}
