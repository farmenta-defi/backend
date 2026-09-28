import { Controller, Get, Param } from '@nestjs/common';
import { MarketsService } from './markets.service.js';

@Controller()
export class MarketsController {
  constructor(private readonly markets: MarketsService) {}
  @Get('markets') getMarkets() { return this.markets.markets(); }
  @Get('markets/:tier/pools') getPools(@Param('tier') tier: string) { return this.markets.pools(tier); }
  @Get('pools/:poolId') getPool(@Param('poolId') poolId: string) { return this.markets.pool(poolId); }
}
