import * as fs from 'fs';
import * as path from 'path';
import { ConsoleLogger, Injectable } from '@nestjs/common';
import { TelemetryGateway } from '../gateways/telemetry.gateway';

/**
 * Custom NestJS logger that:
 * 1. Prints to the terminal (ConsoleLogger)
 * 2. Forwards to the frontend via TelemetryGateway
 * 3. Appends to logs/sylphie.log for external tooling to tail
 */
@Injectable()
export class WebSocketLoggerService extends ConsoleLogger {
  private telemetry?: TelemetryGateway;
  private readonly logStream: fs.WriteStream;

  constructor() {
    super();
    const logDir = path.resolve(process.cwd(), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    this.logStream = fs.createWriteStream(
      path.join(logDir, 'sylphie.log'),
      { flags: 'a' },
    );
  }

  /** Called after DI container is ready to inject the gateway */
  setTelemetryGateway(gateway: TelemetryGateway) {
    this.telemetry = gateway;
  }

  log(message: string, context?: string) {
    super.log(message, context);
    this.forward('info', message, context);
    this.appendFile('LOG', message, context);
  }

  debug(message: string, context?: string) {
    super.debug(message, context);
    this.appendFile('DEBUG', message, context);
  }

  warn(message: string, context?: string) {
    super.warn(message, context);
    this.forward('warn', message, context);
    this.appendFile('WARN', message, context);
  }

  error(message: string, stackOrContext?: string) {
    super.error(message, stackOrContext);
    this.forward('error', message, stackOrContext);
    this.appendFile('ERROR', message, stackOrContext);
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

  private appendFile(
    level: string,
    message: string,
    context?: string,
  ) {
    const ts = new Date().toISOString();
    const ctx = context ? `[${context}] ` : '';
    this.logStream.write(`${ts} ${level.padEnd(5)} ${ctx}${message}\n`);
  }
}
