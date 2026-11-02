import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import appConfig, { AppConfig } from './config/app.config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // SIGTERM -> OnModuleDestroy: the worker stops claiming and drains in-flight batches.
  app.enableShutdownHooks();
  await app.listen(app.get<AppConfig>(appConfig.KEY).port);
}

void bootstrap();
