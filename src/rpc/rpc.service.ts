import { Injectable } from '@nestjs/common';
import { Abi, Address, createPublicClient, http, PublicClient } from 'viem';
import { SettingsService } from '../config/settings.service.js';

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
    return this.client.multicall({ contracts: contracts as never, allowFailure: false }) as Promise<unknown[]>;
  }

  get clientForRead(): PublicClient { return this.client; }
}
