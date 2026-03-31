/**
 * Graph store module: Abstraction layer for graph database implementations.
 *
 * This module provides a clean, technology-agnostic interface for managing
 * isolated graph databases used by Self KG and Other KG services.
 *
 * Current implementation: Grafeo (@grafeo-db/js)
 * Fallback implementation (if needed): SQLite + custom graph layer
 */

export {
  IGraphStore,
  GraphNode,
  GraphEdge,
  CreateNodeRequest,
  CreateEdgeRequest,
  NodeFilter,
  EdgeFilter,
  TraversalPath,
} from './graph-store.interface';

export { GrafeoStore, GraphStoreException } from './grafeo-store';
