# 2026-03-30 -- Create Global Exception Filters (E9-T013)

## Changes
- NEW: `src/web/filters/http-exception.filter.ts` -- Global HTTP exception handler for all requests. Maps domain exceptions to HTTP status codes (NOT_FOUND → 404, InvalidSessionError → 401, GraphQueryTimeoutError → 504, WebException → 400, SylphieException → 500). Includes development-mode stack traces and debug info (code, subsystem) while hiding internal details in production.
- NEW: `src/web/filters/ws-exception.filter.ts` -- WebSocket exception handler for message processing. Sends error frames to clients, preserves connection for recoverable errors (InvalidSessionError, validation), closes only on unrecoverable errors (WebSocketConnectionError). Development mode includes code/subsystem in error frames.
- NEW: `src/web/filters/index.ts` -- Barrel export for both filters.
- MODIFIED: `src/web/web.module.ts` -- Imported APP_FILTER from @nestjs/core, imported HttpExceptionFilter, registered it as APP_FILTER provider for global HTTP coverage.

## Wiring Changes
- HttpExceptionFilter is registered globally via APP_FILTER provider in WebModule, catches all HTTP exceptions across all controllers.
- WsExceptionFilter is available for per-gateway decoration via @UseFilters() (not yet applied; filters exist as reusable components).

## Known Issues
- None

## Gotchas for Next Session
- WsExceptionFilter is created but not yet wired into gateways. When applying it, use @UseFilters(WsExceptionFilter) on gateway classes or message handlers.
- Development mode flag is checked at filter runtime via ConfigService.get<WebConfig>('web').development.enabled. Ensure WEB_DEVELOPMENT_MODE env var is set correctly.
- Error response structure differs between HTTP (error, message, statusCode, timestamp, optional code/subsystem/stack) and WS (type: 'error', error, timestamp, optional code/subsystem).
