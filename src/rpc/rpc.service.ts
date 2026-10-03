import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  Abi,
  Address,
  createPublicClient,
  fallback,
  http,
  PublicClient,
} from 'viem';
import { SettingsService } from '../config/settings.service.js';

// Canonical Multicall3 address, verified for Robinhood Chain in docs research/03 §4.
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address;

// The frontend gives up after 10 seconds. One try per endpoint, each cut at 4 seconds, keeps a slow
// primary plus its fallback inside that budget instead of viem's default 10 seconds and 3 retries.
const RPC_TIMEOUT_MS = 4_000;

@Injectable()
export class RpcService {
  private readonly client: PublicClient;

  constructor(settings: SettingsService) {
    const endpoint = (url: string) =>
      http(url, { timeout: RPC_TIMEOUT_MS, retryCount: 0 });
    const transport = settings.rpcFallbackUrl
      ? fallback(
          [endpoint(settings.rpcUrl), endpoint(settings.rpcFallbackUrl)],
          { retryCount: 0 },
        )
      : endpoint(settings.rpcUrl);
    this.client = createPublicClient({ transport });
  }

  getBlockNumber(): Promise<bigint> {
    return this.client.getBlockNumber().catch(() => {
      throw new ServiceUnavailableException('RPC is unavailable');
    });
  }

  readContract<T>(
    address: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[] = [],
    blockNumber?: bigint,
  ): Promise<T> {
    return this.client
      .readContract({ address, abi, functionName, args, blockNumber } as never)
      .catch(() => {
        throw new ServiceUnavailableException('RPC is unavailable');
      }) as Promise<T>;
  }

  async multicall(
    contracts: Array<{
      address: Address;
      abi: Abi;
      functionName: string;
      args?: readonly unknown[];
    }>,
  ) {
    return this.client
      .multicall({
        contracts: contracts as never,
        allowFailure: true,
        multicallAddress: MULTICALL3,
      })
      .catch(() => {
        throw new ServiceUnavailableException('RPC is unavailable');
      }) as Promise<unknown[]>;
  }

  get clientForRead(): PublicClient {
    return this.client;
  }
}
