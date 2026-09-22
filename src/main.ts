import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { SettingsService } from './config/settings.service.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const settings = app.get(SettingsService);
  app.enableCors({
    origin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) {
      if (!origin || settings.corsOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Origin is not allowed by CORS'));
    },
  });
  await app.listen(settings.port);
}
await bootstrap();
