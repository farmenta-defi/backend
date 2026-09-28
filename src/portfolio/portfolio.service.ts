import { BadRequestException, Injectable } from '@nestjs/common';
import { isAddress } from 'viem';
import { IndexerService } from '../indexer/indexer.service.js';
import { RpcService } from '../rpc/rpc.service.js';
import { TtlCacheService } from '../shared/ttl-cache.service.js';
import { lensAbi, marketAbi, policyAbi, valuerAbi } from '../markets/contracts.js';
import { DeploymentService } from '../markets/deployment.service.js';

const PORTFOLIO = `query Portfolio($owner: String!) {
  positions(where: { owner: { equals: $owner } }) { items { tokenId poolId tickLower tickUpper liquidity } }
  loans(where: { owner: { equals: $owner }, status: { equals: "in_custody" } }) { items { market tokenId poolId status } }
  vaultBalances(where: { account: { equals: $owner } }) { items { market shares } }
}`;

@Injectable()
export class PortfolioService {
  constructor(private readonly indexer: IndexerService, private readonly deployments: DeploymentService, private readonly rpc: RpcService, private readonly cache: TtlCacheService) {}

  async portfolio(address: string) {
    if (!isAddress(address) || /^0x0{40}$/i.test(address)) throw new BadRequestException('address must be a non-zero address');
    return this.cache.get(`portfolio:${address.toLowerCase()}`, async () => {
      const data = await this.indexer.query<PortfolioData>(PORTFOLIO, { owner: address.toLowerCase() });
      const wallet = (await Promise.all(data.positions.items.map(async (position) => (await this.isListedPosition(position)) ? { ...position, status: 'wallet' } : undefined))).filter(Boolean);
      const custody = await Promise.all(data.loans.items.map((loan) => this.enrichLoan(loan)));
      const vaultShares = await Promise.all(data.vaultBalances.items.map(async (share) => ({ ...share, assetsUsdg: (await this.rpc.readContract<bigint>(share.market, marketAbi, 'convertToAssets', [BigInt(share.shares)])).toString() })));
      return { address: address.toLowerCase(), positions: [...wallet, ...custody], vaultShares };
    });
  }

  private async isListedPosition(position: Record<string, unknown>) {
    const poolId = position.poolId;
    if (typeof poolId !== 'string') return false;
    const listings = await Promise.all(this.deployments.all().map(async ([, market]) => {
      try { return (await this.rpc.readContract<{ listed: boolean }>(market.policy, policyAbi, 'listingOf', [poolId])).listed; } catch { return false; }
    }));
    return listings.some(Boolean);
  }

  private async enrichLoan(loan: Loan) {
    const deployment = this.deployments.all().map(([, value]) => value).find((value) => value.address.toLowerCase() === loan.market.toLowerCase());
    if (!deployment) return { ...loan, status: 'in_custody' };
    const tokenId = BigInt(loan.tokenId);
    const [debt, collateralUsd, healthFactor, valuation] = await this.rpc.multicall([
      { address: deployment.address, abi: marketAbi, functionName: 'debtOf', args: [tokenId] },
      { address: deployment.lens, abi: lensAbi, functionName: 'positionValue', args: [tokenId] },
      { address: deployment.lens, abi: lensAbi, functionName: 'healthFactor', args: [tokenId] },
      { address: deployment.valuer, abi: valuerAbi, functionName: 'value', args: [tokenId] },
    ]) as [bigint, bigint, bigint, readonly unknown[]];
    // IPositionValuer.Valuation: feesUsd is index 6 and intentionally has no 10% cap.
    return { ...loan, debtUsdg: debt.toString(), collateralUsd: collateralUsd.toString(), uncollectedFeesUsd: BigInt(valuation[6] as bigint).toString(), healthFactor: healthFactor.toString(), status: 'in_custody' };
  }
}

type Loan = { market: `0x${string}`; tokenId: string; poolId: string; status: string };
type PortfolioData = { positions: { items: Array<Record<string, unknown>> }; loans: { items: Loan[] }; vaultBalances: { items: Array<{ market: `0x${string}`; shares: string }> } };
