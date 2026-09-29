import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsService } from './settings.service.js';

function configureRequiredUrls() {
  vi.stubEnv(
    'DATABASE_URL',
    'postgres://backend:password@localhost:5432/farmenta',
  );
  vi.stubEnv('RPC_URL', 'https://rpc.example');
  vi.stubEnv('INDEXER_STATUS_URL', 'http://indexer/status');
  vi.stubEnv('INDEXER_GRAPHQL_URL', 'http://indexer/graphql');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('SettingsService', () => {
  it('defaults the indexer lag threshold to 60 seconds', () => {
    configureRequiredUrls();
    vi.stubEnv('INDEXER_MAX_LAG_SECONDS', '');

    expect(new SettingsService().maxIndexerLagSeconds).toBe(60);
  });

  it('rejects a negative or fractional threshold', () => {
    configureRequiredUrls();
    vi.stubEnv('INDEXER_MAX_LAG_SECONDS', '-1.5');

    expect(() => new SettingsService()).toThrow(
      'INDEXER_MAX_LAG_SECONDS must be a non-negative integer',
    );
  });

  it('allows a zero-second threshold as an exact boundary', () => {
    configureRequiredUrls();
    vi.stubEnv('INDEXER_MAX_LAG_SECONDS', '0');

    expect(new SettingsService().maxIndexerLagSeconds).toBe(0);
  });
});
