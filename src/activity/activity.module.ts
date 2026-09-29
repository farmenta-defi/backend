import { Module } from '@nestjs/common';
import { ActivityController } from './activity.controller.js';
import { ActivityService } from './activity.service.js';
import { PoolActivityController } from './pool-activity.controller.js';
import { PoolActivityService } from './pool-activity.service.js';
@Module({ controllers: [ActivityController, PoolActivityController], providers: [ActivityService, PoolActivityService] }) export class ActivityModule {}
