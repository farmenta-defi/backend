import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAddress, type Address } from 'viem';
import { SettingsService } from '../config/settings.service.js';

export type MarketDeployment = { address: Address; lens: Address; valuer: Address; policy: Address; tier: number };

@Injectable()
export class DeploymentService {
  private readonly markets: Record<string, MarketDeployment>;

  constructor(settings: SettingsService) {
    if (!settings.deployment) { this.markets = {}; return; }
    const file = join(process.cwd(), 'deployments', `${settings.deployment}.json`);
    const json = JSON.parse(readFileSync(file, 'utf8')) as { markets?: Record<string, unknown> };
    this.markets = Object.fromEntries(Object.entries(json.markets ?? {}).map(([name, raw]) => [name, parseMarket(raw, name)]));
  }

  all(): Array<[string, MarketDeployment]> { return Object.entries(this.markets); }
  get(tier: string): MarketDeployment {
    const market = this.markets[tier];
    if (!market) throw new ServiceUnavailableException('Market deployment is not configured');
    return market;
  }
}

function parseMarket(raw: unknown, name: string): MarketDeployment {
  const value = raw as Partial<MarketDeployment>;
  for (const key of ['address', 'lens', 'valuer', 'policy'] as const) if (!isAddress(value[key] ?? '')) throw new Error(`markets.${name}.${key} must be an address`);
  if (!Number.isInteger(value.tier) || value.tier! < 1 || value.tier! > 2) throw new Error(`markets.${name}.tier must be 1 or 2`);
  return value as MarketDeployment;
}
