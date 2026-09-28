import { Global, Module } from '@nestjs/common';
import { MarketsController } from './markets.controller.js';
import { DeploymentService } from './deployment.service.js';
import { MarketRepository } from './market.repository.js';
import { MarketsService } from './markets.service.js';
import { LiquidationsService } from './liquidations.service.js';

@Global()
@Module({
  controllers: [MarketsController],
  providers: [
    DeploymentService,
    MarketRepository,
    MarketsService,
    LiquidationsService,
  ],
  exports: [DeploymentService, MarketsService, LiquidationsService],
})
export class MarketsModule {}
