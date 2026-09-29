import { Controller, Get, Param, Query } from '@nestjs/common';
import { PoolActivityService } from './pool-activity.service.js';

@Controller('pools')
export class PoolActivityController {
  constructor(private readonly poolActivity: PoolActivityService) {}

  @Get(':poolId/activity')
  get(
    @Param('poolId') poolId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string | string[],
    @Query('kind') kind?: string,
  ) {
    return this.poolActivity.activity(
      poolId,
      limit === undefined ? 25 : Number(limit),
      cursor,
      kind,
    );
  }
}
