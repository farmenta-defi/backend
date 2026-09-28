import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ConfigModule } from './config/config.module.js';
import { HealthModule } from './health/health.module.js';
import { RpcModule } from './rpc/rpc.module.js';
import { IndexerModule } from './indexer/indexer.module.js';
import { SharedModule } from './shared/shared.module.js';
import { MarketsModule } from './markets/markets.module.js';
import { PortfolioModule } from './portfolio/portfolio.module.js';
import { ActivityModule } from './activity/activity.module.js';

@Module({
  imports: [ConfigModule, ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]), SharedModule, RpcModule, IndexerModule, HealthModule, MarketsModule, PortfolioModule, ActivityModule],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
