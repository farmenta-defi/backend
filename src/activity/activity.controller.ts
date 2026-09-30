import { Controller, Get, Param, Query } from '@nestjs/common';
import { ActivityService } from './activity.service.js';
@Controller('activity')
export class ActivityController {
  constructor(private readonly activityService: ActivityService) {}
  @Get(':address') get(
    @Param('address') address: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string | string[],
  ) {
    return this.activityService.activity(
      address,
      limit === undefined ? 25 : Number(limit),
      cursor,
    );
  }
}
