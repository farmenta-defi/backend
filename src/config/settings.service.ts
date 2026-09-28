import { Injectable } from '@nestjs/common';

@Injectable()
export class SettingsService {
  readonly port = Number(process.env.PORT ?? 3000);
  readonly databaseUrl = requireUrl('DATABASE_URL');
  readonly rpcUrl = requireUrl('RPC_URL');
  readonly indexerStatusUrl = requireUrl('INDEXER_STATUS_URL');
  readonly indexerGraphqlUrl = requireUrl('INDEXER_GRAPHQL_URL');
  readonly deployment = process.env.FARMENTA_DEPLOYMENT;
  readonly corsOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  readonly trustProxy = process.env.TRUST_PROXY === '1';
}

function requireUrl(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  const url = new URL(value);
  if (name === 'DATABASE_URL' && url.pathname !== '/farmenta') {
    throw new Error('DATABASE_URL must target the farmenta database');
  }
  return value;
}
