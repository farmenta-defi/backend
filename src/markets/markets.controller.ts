import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common';
import { MarketsService } from './markets.service.js';
import { HistoryRange } from './market.repository.js';

@Controller()
export class MarketsController {
  constructor(private readonly markets: MarketsService) {}
  @Get('markets') getMarkets(@Query('range') range?: string) {
    return this.markets.markets(historyRange(range));
  }
  @Get('markets/:tier/pools') getPools(@Param('tier') tier: string) {
    return this.markets.pools(tier);
  }
  @Get('pools/:poolId') getPool(
    @Param('poolId') poolId: string,
    @Query('range') range?: string,
  ) {
    return this.markets.pool(poolId, historyRange(range));
  }
}
function historyRange(value?: string): HistoryRange {
  if (value === undefined) return '1w';
  if (value === '1w' || value === '1m' || value === '3m' || value === '1y')
    return value;
  throw new BadRequestException('range must be one of 1w, 1m, 3m, or 1y');
}
