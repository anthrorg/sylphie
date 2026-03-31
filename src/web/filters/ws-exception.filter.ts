/**
 * WsExceptionFilter — exception handler for WebSocket message processing.
 *
 * Catches exceptions thrown during WebSocket message handlers and sends
 * error frames to connected clients. Implements different handling based on
 * error severity:
 *
 * - Recoverable errors (e.g., InvalidSessionError, validation failures):
 *   Send error frame and keep connection open. Client can retry or take corrective action.
 *
 * - Unrecoverable errors (e.g., WebSocketConnectionError):
 *   Send error frame, log error, and close the connection.
 *
 * CANON §Communication: WebSocket is the primary real-time transport.
 * Connection state must be preserved across recoverable errors to maintain
 * session continuity and event correlation.
 *
 * In development mode, error frames include diagnostic fields (code, subsystem).
 * In production mode, only generic error messages are exposed.
 */

import {
  Catch,
  ExceptionFilter,
  ArgumentsHost,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WsException } from '@nestjs/websockets';

import { SylphieException } from '../../shared/exceptions/sylphie.exception';
import { WebSocketConnectionError } from '../exceptions/web.exceptions';
import type { WebConfig } from '../web.config';

/**
 * Error frame sent to WebSocket clients.
 *
 * In production mode, only 'type', 'error', and 'timestamp' are included.
 * In development mode, 'code' and 'subsystem' are also included for debugging.
 */
interface WsErrorFrame {
  type: 'error';
  error: string;
  code?: string;
  subsystem?: string;
  timestamp: string;
}

@Catch()
export class WsExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(WsExceptionFilter.name);

  constructor(private readonly configService: ConfigService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const wsHost = host.switchToWs();
    const client = wsHost.getClient();
    const data = wsHost.getData();

    const isDevelopment = this.isDevelopmentMode();
    const isRecoverable = this.isRecoverableError(exception);

    // Build error frame to send to client
    const errorFrame = this.buildErrorFrame(exception);

    // Send error frame to client
    try {
      client.emit('error', errorFrame);
    } catch (sendErr) {
      this.logger.error(
        'Failed to send error frame to WebSocket client',
        sendErr instanceof Error ? sendErr.message : String(sendErr),
      );
    }

    // Log the error
    this.logError(exception, data);

    // Close connection if unrecoverable
    if (!isRecoverable) {
      try {
        client.close();
      } catch (closeErr) {
        this.logger.debug(
          'Error closing WebSocket connection',
          closeErr instanceof Error ? closeErr.message : String(closeErr),
        );
      }
    }
  }

  /**
   * Determine if an error is recoverable (connection should remain open).
   *
   * Recoverable errors:
   * - InvalidSessionError (client can re-authenticate)
   * - Validation errors (client can retry with corrected input)
   * - Generic WebException (client-side issue, retry may succeed)
   *
   * Unrecoverable errors:
   * - WebSocketConnectionError (handshake/allocation failure)
   * - System errors indicating connection cannot continue
   */
  private isRecoverableError(exception: unknown): boolean {
    // WebSocketConnectionError is unrecoverable
    if (exception instanceof WebSocketConnectionError) {
      return false;
    }

    // WsException wrapping an unrecoverable error
    if (exception instanceof WsException) {
      const cause = (exception as unknown as { cause?: unknown }).cause;
      if (cause instanceof WebSocketConnectionError) {
        return false;
      }
    }

    // All other errors (including InvalidSessionError) are recoverable
    return true;
  }

  /**
   * Build error frame to send to WebSocket client.
   */
  private buildErrorFrame(exception: unknown): WsErrorFrame {
    const isDevelopment = this.isDevelopmentMode();
    const timestamp = new Date().toISOString();

    const frame: WsErrorFrame = {
      type: 'error',
      error: this.getErrorMessage(exception),
      timestamp,
    };

    // Add development-only fields
    if (isDevelopment && exception instanceof SylphieException) {
      frame.code = exception.code;
      frame.subsystem = exception.subsystem;
    }

    return frame;
  }

  /**
   * Extract human-readable error message.
   *
   * In production, returns generic message for security.
   * In development, returns the actual exception message.
   */
  private getErrorMessage(exception: unknown): string {
    const isDevelopment = this.isDevelopmentMode();

    if (exception instanceof SylphieException) {
      return isDevelopment
        ? exception.message
        : 'A processing error occurred';
    }

    if (exception instanceof WsException) {
      const message = exception.getError();
      if (typeof message === 'string') {
        return isDevelopment ? message : 'A processing error occurred';
      }
      if (message instanceof Error) {
        return isDevelopment
          ? message.message
          : 'A processing error occurred';
      }
    }

    if (exception instanceof Error) {
      return isDevelopment ? exception.message : 'A processing error occurred';
    }

    return 'An unexpected error occurred';
  }

  /**
   * Check if development mode is enabled.
   */
  private isDevelopmentMode(): boolean {
    const webConfig = this.configService.get<WebConfig>('web');
    return webConfig?.development.enabled ?? true;
  }

  /**
   * Log error with appropriate context for debugging.
   */
  private logError(exception: unknown, data: unknown): void {
    const isDevelopment = this.isDevelopmentMode();

    if (exception instanceof SylphieException) {
      const context = {
        subsystem: exception.subsystem,
        code: exception.code,
        messageData: data,
        ...exception.context,
      };

      const logMessage = `[${exception.subsystem}] ${exception.code}: ${exception.message}`;

      this.logger.warn(logMessage, JSON.stringify(context));
      return;
    }

    if (exception instanceof WsException) {
      const message = exception.getError();
      const logMessage = `WsException: ${
        typeof message === 'string'
          ? message
          : message instanceof Error
            ? message.message
            : 'unknown'
      }`;

      const context = {
        messageData: data,
        ...(message instanceof Error && isDevelopment
          ? { stack: message.stack }
          : {}),
      };

      this.logger.warn(logMessage, JSON.stringify(context));
      return;
    }

    if (exception instanceof Error) {
      const logMessage = `${exception.constructor.name}: ${exception.message}`;
      const context = { messageData: data };

      if (isDevelopment && exception.stack) {
        this.logger.warn(logMessage, exception.stack);
      } else {
        this.logger.warn(logMessage, JSON.stringify(context));
      }
      return;
    }

    this.logger.warn(
      'Unknown WebSocket exception',
      JSON.stringify({ exception, data }),
    );
  }
}
