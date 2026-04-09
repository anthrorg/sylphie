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

  // CORS — allow the Vite dev server and any configured origins
  app.enableCors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
    credentials: true,
  });

  // Wire the logger to the broadcast service so logs stream to the frontend
  const broadcast = app.get(TelemetryBroadcastService);
  logger.setTelemetryBroadcast(broadcast);

  // Railway injects PORT; fall back to APP_PORT for local dev
  const port = process.env.PORT || process.env.APP_PORT || 3000;
  await app.listen(port);
  Logger.log(`Sylphie backend listening on port ${port}`, 'Bootstrap');
}

bootstrap();
