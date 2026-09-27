import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { SettingsService } from '../config/settings.service.js';

@Injectable()
export class HealthRepository implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(settings: SettingsService) {
    this.pool = new Pool({ connectionString: settings.databaseUrl });
  }

  async ping(): Promise<void> {
    await this.pool.query('select 1');
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
