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
    databaseUrl: requiredDatabaseUrl(env),
    indexerUrl: requiredUrl(env, 'INDEXER_URL'),
    rpcUrl: requiredUrl(env, 'RPC_URL'),
    privateKey: requiredHex(env, 'KEEPER_PRIVATE_KEY'),
    twapRecorder: requiredAddress(env, 'TWAP_RECORDER_ADDRESS'),
    multicall3: requiredAddress(env, 'MULTICALL3_ADDRESS'),
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    telegramChatId: env.TELEGRAM_CHAT_ID,
    maxIndexerLagSeconds: requiredNonNegativeInteger(env, 'KEEPER_MAX_INDEXER_LAG_SECONDS', 60),
  };
}

function requiredUrl(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return new URL(value).toString();
}

function requiredDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const databaseUrl = requiredUrl(env, 'DATABASE_URL');
  if (new URL(databaseUrl).pathname !== '/farmenta') {
    throw new Error('DATABASE_URL must target the farmenta database');
  }
  return databaseUrl;
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

function requiredNonNegativeInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}
