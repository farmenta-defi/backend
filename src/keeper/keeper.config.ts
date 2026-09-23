import { isAddress, isHex, type Address, type Hex } from 'viem';

export interface KeeperConfig {
  databaseUrl: string;
  indexerUrl: string;
  rpcUrl: string;
  privateKey: Hex;
  twapRecorder: Address;
  multicall3: Address;
  telegramBotToken?: string;
  telegramChatId?: string;
  maxIndexerLagSeconds: number;
}

export function readKeeperConfig(env = process.env): KeeperConfig {
  return {
    databaseUrl: requiredUrl(env, 'DATABASE_URL'),
    indexerUrl: requiredUrl(env, 'INDEXER_URL'),
    rpcUrl: requiredUrl(env, 'RPC_URL'),
    privateKey: requiredHex(env, 'KEEPER_PRIVATE_KEY'),
    twapRecorder: requiredAddress(env, 'TWAP_RECORDER_ADDRESS'),
    multicall3: requiredAddress(env, 'MULTICALL3_ADDRESS'),
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    telegramChatId: env.TELEGRAM_CHAT_ID,
    maxIndexerLagSeconds: Number(env.KEEPER_MAX_INDEXER_LAG_SECONDS ?? 60),
  };
}

function requiredUrl(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return new URL(value).toString();
}

function requiredAddress(env: NodeJS.ProcessEnv, name: string): Address {
  const value = env[name];
  if (!value || !isAddress(value)) throw new Error(`${name} must be an address`);
  return value;
}

function requiredHex(env: NodeJS.ProcessEnv, name: string): Hex {
  const value = env[name];
  if (!value || !isHex(value) || value.length !== 66) throw new Error(`${name} must be a 32-byte private key`);
  return value;
}
