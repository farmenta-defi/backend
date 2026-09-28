import { BadRequestException, Injectable } from '@nestjs/common';
import { isAddress } from 'viem';
import { IndexerService } from '../indexer/indexer.service.js';
import { RpcService } from '../rpc/rpc.service.js';
import { TtlCacheService } from '../shared/ttl-cache.service.js';
import {
  lensAbi,
  marketAbi,
  policyAbi,
  valuerAbi,
} from '../markets/contracts.js';
import { DeploymentService } from '../markets/deployment.service.js';

const PORTFOLIO = `query Portfolio($owner: String!) {
  positions(where: { owner: $owner }) { items { tokenId poolId tickLower tickUpper liquidity } }
  loans(where: { owner: $owner, status: "in_custody" }) { items { market tokenId poolId status } }
  vaultBalances(where: { account: $owner }) { items { market shares } }
}`;

@Injectable()
export class PortfolioService {
  constructor(
    private readonly indexer: IndexerService,
    private readonly deployments: DeploymentService,
    private readonly rpc: RpcService,
    private readonly cache: TtlCacheService,
  ) {}

  async portfolio(address: string) {
    if (!isAddress(address) || /^0x0{40}$/i.test(address))
      throw new BadRequestException('address must be a non-zero address');
    return this.cache.get(`portfolio:${address.toLowerCase()}`, async () => {
      const data = await this.indexer.query<PortfolioData>(PORTFOLIO, {
        owner: address.toLowerCase(),
      });
      const wallet = (
        await Promise.all(
          data.positions.items.map((position) =>
            this.enrichWalletPosition(position),
          ),
        )
      ).filter(Boolean);
      const custody = await Promise.all(
        data.loans.items.map((loan) => this.enrichLoan(loan)),
      );
      const vaultShares = await Promise.all(
        data.vaultBalances.items.map(async (share) => ({
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

  private async enrichWalletPosition(position: Record<string, unknown>) {
    const poolId = position.poolId;
    if (typeof poolId !== 'string') return undefined;
    for (const [, raw] of this.deployments.all()) {
      const market = await this.deployments.resolve(raw);
      if (
        !(
          await this.rpc.readContract<{ listed: boolean }>(
            market.policy,
            policyAbi,
            'listingOf',
            [poolId],
          )
        ).listed
      )
        continue;
      const [value] = (await this.rpc.multicall([
        {
          address: market.valuer,
          abi: valuerAbi,
          functionName: 'value',
          args: [BigInt(position.tokenId as string)],
        },
      ])) as MulticallResult[];
      const valuation = resultOf(value) as readonly unknown[] | null;
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
    return undefined;
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
type PortfolioData = {
  positions: { items: Array<Record<string, unknown>> };
  loans: { items: Loan[] };
  vaultBalances: { items: Array<{ market: `0x${string}`; shares: string }> };
};
type MulticallResult =
  | { status: 'success'; result: unknown }
  | { status: 'failure'; error: unknown };
function resultOf(call: MulticallResult) {
  return call.status === 'success' ? call.result : null;
}
