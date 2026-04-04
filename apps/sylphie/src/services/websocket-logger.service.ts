import { ConsoleLogger, Injectable } from '@nestjs/common';
import { TelemetryGateway } from '../gateways/telemetry.gateway';

/**
 * Custom NestJS logger that forwards log output to the TelemetryGateway
 * so the frontend System Logs panel shows backend activity in real time.
 *
 * Extends ConsoleLogger so logs still appear in the terminal.
 */
@Injectable()
export class WebSocketLoggerService extends ConsoleLogger {
  private telemetry?: TelemetryGateway;

  /** Called after DI container is ready to inject the gateway */
  setTelemetryGateway(gateway: TelemetryGateway) {
    this.telemetry = gateway;
  }

  log(message: string, context?: string) {
    super.log(message, context);
    this.forward('info', message, context);
  }

  warn(message: string, context?: string) {
    super.warn(message, context);
    this.forward('warn', message, context);
  }

  error(message: string, stackOrContext?: string) {
    super.error(message, stackOrContext);
    this.forward('error', message, stackOrContext);
  }

  private forward(
    level: 'info' | 'warn' | 'error',
    message: string,
    context?: string,
  ) {
    if (!this.telemetry) return;
    const text = context ? `[${context}] ${message}` : message;
    this.telemetry.sendLog(level, text);
  }
}
