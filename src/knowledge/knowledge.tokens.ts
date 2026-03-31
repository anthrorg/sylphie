/**
 * Injection tokens for the Knowledge module.
 *
 * All five tokens are Symbols to prevent accidental collisions with tokens
 * from other modules. Consumers inject by referencing the token:
 *
 *   @Inject(WKG_SERVICE) private readonly wkg: IWkgService
 *
 * Token definitions are co-located here so that importing modules need only
 * reference knowledge.tokens.ts, not any internal service file path.
 *
 * CANON §Module boundary: Consumers must import from the barrel (index.ts),
 * not from this file directly. This file is re-exported by the barrel.
 */

/** DI token for IWkgService. Provided by KnowledgeModule, backed by WkgService. */
export const WKG_SERVICE = Symbol('WKG_SERVICE');

/** DI token for ISelfKgService. Provided by KnowledgeModule, backed by SelfKgService. */
export const SELF_KG_SERVICE = Symbol('SELF_KG_SERVICE');

/** DI token for IOtherKgService. Provided by KnowledgeModule, backed by OtherKgService. */
export const OTHER_KG_SERVICE = Symbol('OTHER_KG_SERVICE');

/**
 * DI token for the Neo4j Driver instance.
 *
 * Provided as a factory provider in KnowledgeModule. The driver is the raw
 * neo4j-driver Driver object — only WkgService holds a reference to it.
 * No other service may inject NEO4J_DRIVER directly; use WKG_SERVICE instead.
 */
export const NEO4J_DRIVER = Symbol('NEO4J_DRIVER');

/** DI token for IConfidenceService. Provided by KnowledgeModule, backed by ConfidenceService. */
export const CONFIDENCE_SERVICE = Symbol('CONFIDENCE_SERVICE');
