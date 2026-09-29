import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.config.js';
import { vi } from 'vitest';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    process.env.DATABASE_URL =
      'postgres://backend:password@localhost:5432/farmenta';
    process.env.RPC_URL = 'http://127.0.0.1:8545';
    process.env.INDEXER_STATUS_URL = 'http://127.0.0.1:42069/status';
    process.env.INDEXER_GRAPHQL_URL = 'http://127.0.0.1:42069/graphql';
    process.env.INDEXER_MAX_LAG_SECONDS = '60';
    process.env.FARMENTA_DEPLOYMENT = '';
    process.env.CORS_ORIGINS = 'https://app.farmenta.example';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  it('/health (GET)', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          status: 'error',
          database: { status: 'error' },
          rpc: { status: 'error' },
          indexer: { status: 'error' },
        });
      });
  });

  it('keeps /markets available while the indexer is far behind', () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ robinhood: { block: { timestamp: 1 } } }),
    });
    vi.stubGlobal('fetch', fetch);

    return request(app.getHttpServer())
      .get('/markets')
      .expect(200)
      .expect([])
      .then(() => expect(fetch).not.toHaveBeenCalled());
  });

  it('rejects an origin outside the frontend allowlist', () => {
    return request(app.getHttpServer())
      .get('/health')
      .set('Origin', 'https://attacker.example')
      .expect(500);
  });

  it('does not expose a generic JSON-RPC proxy', () => {
    return request(app.getHttpServer())
      .post('/rpc')
      .send({ method: 'eth_call', params: [] })
      .expect(404);
  });

  it('returns 429 after the per-IP request limit', async () => {
    const responses = await Promise.all(
      Array.from({ length: 61 }, () =>
        request(app.getHttpServer()).get('/health'),
      ),
    );
    expect(responses.some((response) => response.status === 429)).toBe(true);
  });

  afterEach(async () => {
    await app?.close();
    vi.unstubAllGlobals();
  });
});
