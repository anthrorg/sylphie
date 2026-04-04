import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';
import { WebSocketLoggerService } from './services/websocket-logger.service';
import { TelemetryGateway } from './gateways/telemetry.gateway';

async function bootstrap() {
  const logger = new WebSocketLoggerService();
  const app = await NestFactory.create(AppModule, { logger });

  app.setGlobalPrefix('api');
  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableShutdownHooks();

  // Wire the logger to the telemetry gateway so logs stream to the frontend
  const telemetry = app.get(TelemetryGateway);
  logger.setTelemetryGateway(telemetry);

  const port = process.env.APP_PORT || 3000;
  await app.listen(port);
  Logger.log(`Sylphie backend listening on port ${port}`, 'Bootstrap');
}

bootstrap();
