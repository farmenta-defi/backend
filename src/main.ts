import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './app.config.js';
import { SettingsService } from './config/settings.service.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  const settings = app.get(SettingsService);
  await app.listen(settings.port);
}

await bootstrap();
