import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ConfigModule } from './config/config.module.js';
import { HealthModule } from './health/health.module.js';
import { RpcModule } from './rpc/rpc.module.js';

@Module({
  imports: [ConfigModule, ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]), RpcModule, HealthModule],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
