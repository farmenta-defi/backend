import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    process.env.DATABASE_URL = 'postgres://backend:password@localhost:5432/farmenta';
    process.env.RPC_URL = 'http://127.0.0.1:8545';
    process.env.INDEXER_STATUS_URL = 'http://127.0.0.1:42069/status';
    process.env.CORS_ORIGINS = 'https://app.farmenta.example';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
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

  afterEach(async () => {
    await app?.close();
  });
});
