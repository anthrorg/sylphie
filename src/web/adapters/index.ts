/**
 * Barrel export for src/web/adapters.
 *
 * Consumers of co-being wire format types and adapter functions import from
 * this barrel. Internal file paths inside src/web/adapters/ are an
 * implementation detail.
 */
export type {
  CoBeing_DriveFrame,
  CoBeing_ConversationTurn,
  CoBeing_GraphNode,
  CoBeing_GraphEdge,
  CoBeing_GraphDelta,
} from './cobeing-types';

export { adaptTelemetryFrame } from './telemetry.adapter';
export { adaptConversationMessage } from './conversation.adapter';
export {
  adaptGraphNode,
  adaptGraphEdge,
  adaptGraphUpdate,
  adaptGraphSnapshot,
} from './graph.adapter';
