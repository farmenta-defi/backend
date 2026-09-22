import { INestApplication } from '@nestjs/common';
import { SettingsService } from './config/settings.service.js';

export function configureApp(app: INestApplication) {
  const settings = app.get(SettingsService);
  app.enableCors({
    origin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) {
      if (!origin || settings.corsOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Origin is not allowed by CORS'));
    },
  });
}
