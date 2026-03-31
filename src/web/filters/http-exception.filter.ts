/**
 * HttpExceptionFilter — global exception handler for HTTP requests.
 *
 * Catches all exceptions thrown in HTTP request handlers and maps them to
 * appropriate HTTP status codes and response structures. Implements the
 * CANON exception hierarchy:
 *
 * - Domain exceptions (SylphieException subclasses) are mapped to status codes
 *   based on their code attribute.
 * - NestJS HttpExceptions preserve their original status.
 * - All other errors default to 500 Internal Server Error.
 *
 * CANON §Exception Hierarchy: This filter enforces the contract that all
 * domain errors carry subsystem, code, and context for debugging without
 * leaking internal details to clients in production mode.
 *
 * In development mode, stack traces and exception codes are included for
 * debugging. In production mode, only generic messages are exposed.
 */

import {
  Catch,
  ExceptionFilter,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';

import { SylphieException } from '../../shared/exceptions/sylphie.exception';
import { WebException } from '../exceptions/web.exceptions';
import type { WebConfig } from '../web.config';

/**
 * HTTP error response structure sent to clients.
 *
 * In production mode, only 'error' and 'statusCode' are included.
 * In development mode, additional debugging fields are included.
 */
interface HttpErrorResponse {
  error: string;
  message: string;
  statusCode: number;
  timestamp: string;
  // Development-only fields
  code?: string;
  subsystem?: string;
  stack?: string;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  constructor(private readonly configService: ConfigService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();

    const statusCode = this.getStatusCode(exception);
    const errorResponse = this.buildErrorResponse(exception, statusCode);

    // Log the error with context
    this.logError(exception, statusCode);

    // Send response
    res.status(statusCode).json(errorResponse);
  }

  /**
   * Determine HTTP status code from exception type and attributes.
   */
  private getStatusCode(exception: unknown): number {
    // NestJS HttpException — use its own status
    if (exception instanceof HttpException) {
      return exception.getStatus();
    }

    // Domain exceptions — map code to status
    if (exception instanceof SylphieException) {
      const code = exception.code;

      // NOT_FOUND exceptions
      if (code.includes('NOT_FOUND')) {
        return HttpStatus.NOT_FOUND;
      }

      // InvalidSessionError
      if (code === 'INVALID_SESSION') {
        return HttpStatus.UNAUTHORIZED;
      }

      // GraphQueryTimeoutError
      if (code === 'GRAPH_QUERY_TIMEOUT') {
        return HttpStatus.GATEWAY_TIMEOUT;
      }

      // WebException (generic web errors)
      if (exception instanceof WebException) {
        return HttpStatus.BAD_REQUEST;
      }

      // Generic SylphieException defaults to 500
      return HttpStatus.INTERNAL_SERVER_ERROR;
    }

    // Unknown error
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }

  /**
   * Build the error response object with appropriate detail level based on mode.
   */
  private buildErrorResponse(
    exception: unknown,
    statusCode: number,
  ): HttpErrorResponse {
    const isDevelopment = this.isDevelopmentMode();
    const timestamp = new Date().toISOString();

    // Base response
    const response: HttpErrorResponse = {
      error: this.getErrorName(exception),
      message: this.getErrorMessage(exception),
      statusCode,
      timestamp,
    };

    // Add development-only fields
    if (isDevelopment) {
      if (exception instanceof SylphieException) {
        response.code = exception.code;
        response.subsystem = exception.subsystem;
      }

      if (exception instanceof Error && exception.stack) {
        response.stack = exception.stack;
      }
    }

    return response;
  }

  /**
   * Extract human-readable error name.
   */
  private getErrorName(exception: unknown): string {
    if (exception instanceof Error) {
      return exception.constructor.name;
    }
    return 'Error';
  }

  /**
   * Extract human-readable error message.
   */
  private getErrorMessage(exception: unknown): string {
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      if (typeof response === 'object' && response !== null) {
        const obj = response as Record<string, unknown>;
        if (typeof obj['message'] === 'string') {
          return obj['message'];
        }
      }
      return exception.message;
    }

    if (exception instanceof Error) {
      return exception.message;
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
  private logError(exception: unknown, statusCode: number): void {
    const isDevelopment = this.isDevelopmentMode();

    if (exception instanceof SylphieException) {
      const context = {
        subsystem: exception.subsystem,
        code: exception.code,
        ...exception.context,
      };

      const logMessage = `[${exception.subsystem}] ${exception.code}: ${exception.message}`;

      if (statusCode >= 500) {
        this.logger.error(logMessage, JSON.stringify(context));
      } else {
        this.logger.warn(logMessage, JSON.stringify(context));
      }

      return;
    }

    if (exception instanceof HttpException) {
      const message = this.getErrorMessage(exception);
      if (statusCode >= 500) {
        this.logger.error(message);
      } else {
        this.logger.warn(message);
      }
      return;
    }

    if (exception instanceof Error) {
      const message = `${exception.constructor.name}: ${exception.message}`;
      if (isDevelopment && exception.stack) {
        this.logger.error(message, exception.stack);
      } else {
        this.logger.error(message);
      }
      return;
    }

    this.logger.error('Unknown exception:', JSON.stringify(exception));
  }
}
