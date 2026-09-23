import { privateKeyToAccount } from 'viem/accounts';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Account,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import type { PoolKey, RecordReceipt, RecorderRepository } from './keeper.types.js';

const marketAbi = [{ type: 'function', name: 'debtOf', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'uint256' }] }] as const;
const recorderAbi = [{
  type: 'function',
  name: 'recordBatch',
  stateMutability: 'nonpayable',
  inputs: [{
    name: 'keys',
    type: 'tuple[]',
    components: [
      { name: 'currency0', type: 'address' },
      { name: 'currency1', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'tickSpacing', type: 'int24' },
      { name: 'hooks', type: 'address' },
    ],
  }],
  outputs: [],
}] as const;
const observationAbi = [{ type: 'function', name: 'observationCount', stateMutability: 'view', inputs: [{ name: 'poolId', type: 'bytes32' }], outputs: [{ type: 'uint16' }] }] as const;
const robinhoodChain = defineChain({
  id: 4_663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Robinhood', symbol: 'RBH', decimals: 18 },
  rpcUrls: { default: { http: [] } },
});

export class ViemRecorderRepository implements RecorderRepository {
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly account: Account;

  constructor(
    rpcUrl: string,
    privateKey: Hex,
    private readonly recorderAddress: Address,
    private readonly multicallAddress: Address,
  ) {
    const transport = http(rpcUrl, { retryCount: 0 });
    this.publicClient = createPublicClient({ chain: robinhoodChain, transport });
    this.account = privateKeyToAccount(privateKey);
    this.walletClient = createWalletClient({ account: this.account, chain: robinhoodChain, transport });
  }

  async debts(market: Address, tokenIds: bigint[]): Promise<bigint[]> {
    if (tokenIds.length === 0) return [];
    return retryWithBackoff(async () => {
      const results = await this.publicClient.multicall({
        multicallAddress: this.multicallAddress,
        allowFailure: false,
        contracts: tokenIds.map((tokenId) => ({ address: market, abi: marketAbi, functionName: 'debtOf', args: [tokenId] })),
      });
      return results as bigint[];
    });
  }

  async submitBatch(pools: PoolKey[]): Promise<string> {
    const nonce = await retryWithBackoff(() => this.publicClient.getTransactionCount({
      address: this.account.address,
      blockTag: 'pending',
    }));
    const hash = await retryWithBackoff(() =>
      this.walletClient.writeContract({
        chain: robinhoodChain,
        account: this.account,
        nonce,
        address: this.recorderAddress,
        abi: recorderAbi,
        functionName: 'recordBatch',
        args: [pools.map(({ currency0, currency1, fee, tickSpacing, hooks }) => ({ currency0, currency1, fee, tickSpacing, hooks }))],
      }),
    );
    return hash;
  }

  async waitForReceipt(hash: string): Promise<RecordReceipt> {
    return retryWithBackoff(async () => {
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash: hash as Hex, timeout: 90_000 });
      if (receipt.status !== 'success') throw new Error(`recordBatch transaction ${hash} reverted`);
      return { hash, gasUsed: receipt.gasUsed, gasPrice: receipt.effectiveGasPrice };
    });
  }

  async observationCounts(poolIds: `0x${string}`[]): Promise<number[]> {
    if (poolIds.length === 0) return [];
    return retryWithBackoff(async () => {
      const results = await this.publicClient.multicall({
        multicallAddress: this.multicallAddress,
        allowFailure: false,
        contracts: poolIds.map((poolId) => ({ address: this.recorderAddress, abi: observationAbi, functionName: 'observationCount', args: [poolId] })),
      });
      return results.map(Number);
    });
  }
}

async function retryWithBackoff<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let failure: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      failure = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1_000));
    }
  }
  throw failure;
}
