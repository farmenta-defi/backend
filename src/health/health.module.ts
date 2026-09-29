import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { HealthRepository } from './health.repository.js';
import { HealthService } from './health.service.js';
import { IndexerModule } from '../indexer/indexer.module.js';

@Module({
  controllers: [HealthController],
  imports: [IndexerModule],
  providers: [HealthRepository, HealthService],
})
export class HealthModule {}
