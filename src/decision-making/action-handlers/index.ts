/**
 * Action Handlers module barrel export.
 *
 * Exports the ActionHandlerRegistry service and its public types.
 * This is the only public API for the action-handlers subsystem.
 */

export {
  ActionHandlerRegistry,
  type ActionHandler,
  type ActionHandlerResult,
  type ActionExecutionContext,
} from './action-handler-registry.service';
