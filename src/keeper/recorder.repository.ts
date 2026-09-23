import { privateKeyToAccount } from 'viem/accounts';
import {
  createPublicClient,
  createWalletClient,
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
    this.publicClient = createPublicClient({ transport });
    this.account = privateKeyToAccount(privateKey);
    this.walletClient = createWalletClient({ account: this.account, chain: undefined, transport });
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

  async recordBatch(pools: PoolKey[]): Promise<RecordReceipt> {
    return retryWithBackoff(async () => {
      const hash = await this.walletClient.writeContract({
        chain: undefined,
        account: this.account,
        address: this.recorderAddress,
        abi: recorderAbi,
        functionName: 'recordBatch',
        args: [pools.map(({ currency0, currency1, fee, tickSpacing, hooks }) => ({ currency0, currency1, fee, tickSpacing, hooks }))],
      });
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`recordBatch transaction ${hash} reverted`);
      return { hash, gasUsed: receipt.gasUsed };
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
