import { Injectable } from '@nestjs/common';
import { Abi, Address, createPublicClient, http, PublicClient } from 'viem';
import { SettingsService } from '../config/settings.service.js';

// Canonical Multicall3 address, verified for Robinhood Chain in docs research/03 §4.
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address;

@Injectable()
export class RpcService {
  private readonly client: PublicClient;

  constructor(settings: SettingsService) {
    this.client = createPublicClient({ transport: http(settings.rpcUrl) });
  }

  getBlockNumber(): Promise<bigint> {
    return this.client.getBlockNumber();
  }

  readContract<T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = [], blockNumber?: bigint): Promise<T> {
    return this.client.readContract({ address, abi, functionName, args, blockNumber } as never) as Promise<T>;
  }

  async multicall(contracts: Array<{ address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }>) {
    return this.client.multicall({ contracts: contracts as never, allowFailure: false, multicallAddress: MULTICALL3 }) as Promise<unknown[]>;
  }

  get clientForRead(): PublicClient { return this.client; }
}
