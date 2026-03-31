/**
 * Barrel export for Web module exception filters.
 *
 * These filters are used by WebModule to provide global exception handling
 * for both HTTP requests and WebSocket messages.
 */

export { HttpExceptionFilter } from './http-exception.filter';
export { WsExceptionFilter } from './ws-exception.filter';
