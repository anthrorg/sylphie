import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';
import { WebSocketLoggerService } from './services/websocket-logger.service';
import { TelemetryBroadcastService } from './services/telemetry-broadcast.service';

async function bootstrap() {
  const logger = new WebSocketLoggerService();
  const app = await NestFactory.create(AppModule, { logger });

  app.setGlobalPrefix('api');
  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableShutdownHooks();

  // Wire the logger to the broadcast service so logs stream to the frontend
  const broadcast = app.get(TelemetryBroadcastService);
  logger.setTelemetryBroadcast(broadcast);

  const port = process.env.APP_PORT || 3000;
  await app.listen(port);
  Logger.log(`Sylphie backend listening on port ${port}`, 'Bootstrap');
}

bootstrap();
