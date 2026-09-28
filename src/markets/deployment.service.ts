import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAddress, zeroAddress, type Address } from 'viem';
import { SettingsService } from '../config/settings.service.js';
import { RpcService } from '../rpc/rpc.service.js';
import { marketAbi } from './contracts.js';

export type MarketDeployment = { address: Address; lens: Address; valuer?: Address; policy?: Address; tier?: number };
export type ResolvedMarketDeployment = { address: Address; lens: Address; valuer: Address; policy: Address; tier: number };

@Injectable()
export class DeploymentService {
  private readonly markets: Record<string, MarketDeployment>;

  constructor(settings: SettingsService, private readonly rpc: RpcService) {
    if (!settings.deployment) { this.markets = {}; return; }
    const file = join(process.cwd(), 'deployments', `${settings.deployment}.json`);
    const json = JSON.parse(readFileSync(file, 'utf8')) as { markets?: Record<string, unknown> };
    this.markets = Object.fromEntries(Object.entries(json.markets ?? {}).map(([name, raw]) => [name, parseMarket(raw, name, json)]));
  }

  all(): Array<[string, MarketDeployment]> { return Object.entries(this.markets); }
  async get(tier: string): Promise<ResolvedMarketDeployment> {
    const market = this.markets[normalizeTier(tier)];
    if (!market) throw new ServiceUnavailableException('Market deployment is not configured');
    return this.resolve(market);
  }
  async resolve(market: MarketDeployment): Promise<ResolvedMarketDeployment> {
    const [policy, valuer, tier] = await Promise.all([
      market.policy ?? this.rpc.readContract<Address>(market.address, marketAbi, 'policy'),
      market.valuer ?? this.rpc.readContract<Address>(market.address, marketAbi, 'valuer'),
      market.tier ?? this.rpc.readContract<number>(market.address, marketAbi, 'tier'),
    ]);
    return { ...market, policy, valuer, tier };
  }
}

function parseMarket(raw: unknown, name: string, manifest: Record<string, unknown>): MarketDeployment {
  const value = raw as Partial<MarketDeployment>;
  const lens = value.lens ?? ((manifest.lenses as Record<string, { address?: Address }> | undefined)?.[name]?.address);
  const policy = value.policy ?? (manifest.collateralPolicy as { address?: Address } | undefined)?.address;
  for (const key of ['address'] as const) {
    if (!isAddress(value[key] ?? '') || value[key]?.toLowerCase() === zeroAddress) throw new Error(`markets.${name}.${key} must be a deployed contract address`);
  }
  if (!isAddress(lens ?? '') || lens?.toLowerCase() === zeroAddress) throw new Error(`lenses.${name}.address must be a deployed contract address`);
  if (policy && (!isAddress(policy) || policy.toLowerCase() === zeroAddress)) throw new Error('collateralPolicy.address must be a deployed contract address');
  return { ...value, lens, policy } as MarketDeployment;
}
function normalizeTier(tier: string) { return tier === 'blue-chip' ? 'blueChip' : tier; }
