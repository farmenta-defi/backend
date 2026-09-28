import { Global, Module } from '@nestjs/common';
import { TtlCacheService } from './ttl-cache.service.js';

@Global()
@Module({ providers: [TtlCacheService], exports: [TtlCacheService] })
export class SharedModule {}
