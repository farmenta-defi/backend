import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.config.js';
import { vi } from 'vitest';
import { PoolActivityService } from '../src/activity/pool-activity.service.js';
import { parseActivityCursor } from '../src/activity/activity-cursor.js';

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
    const moduleBuilder = Test.createTestingModule({
      imports: [AppModule],
    }).overrideProvider(PoolActivityService).useValue({
      activity: async (_poolId: string, _limit: number, cursor?: string | string[]) => {
        parseActivityCursor(cursor);
        return { items: [], nextCursor: null, hasMore: false };
      },
    });
    const moduleFixture: TestingModule = await moduleBuilder.compile();

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

  it('/pools/:poolId/activity (GET)', () => {
    return request(app.getHttpServer())
      .get(`/pools/0x${'a'.repeat(64)}/activity?limit=25&kind=borrow`)
      .expect(200)
      .expect({ items: [], nextCursor: null, hasMore: false });
  });

  it('rejects repeated pool activity cursors and log indexes beyond GraphQL Int32', async () => {
    await request(app.getHttpServer())
      .get(`/pools/0x${'a'.repeat(64)}/activity?cursor=1%3A1&cursor=2%3A2`)
      .expect(400);
    await request(app.getHttpServer())
      .get(`/pools/0x${'a'.repeat(64)}/activity?cursor=1%3A2147483648`)
      .expect(400);
  });

  it.each([
    ['below threshold', 59, 200],
    ['at threshold', 60, 200],
    ['above threshold', 61, 503],
  ])(
    'gates an indexer-backed route when lag is %s',
    async (_case, lag, status) => {
      const fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.endsWith('/status')) {
          return {
            ok: true,
            json: async () => ({
              robinhood: {
                block: { timestamp: Math.floor(Date.now() / 1_000) - lag },
              },
            }),
          };
        }
        return { ok: true, json: async () => ({ data: {} }) };
      });
      vi.stubGlobal('fetch', fetch);

      const response = await request(app.getHttpServer())
        .get('/activity/0x00000000000000000000000000000000000000aa')
        .expect(status);

      if (status === 200)
        expect(response.body).toMatchObject({
          items: [],
          nextCursor: null,
          hasMore: false,
        });
      expect(fetch).toHaveBeenCalledTimes(lag > 60 ? 1 : 2);
    },
  );

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
