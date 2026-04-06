/**
 * domain-classifier.ts -- Domain labels and write-back for Function nodes.
 *
 * Domain classification is done externally via a local skill, NOT by this
 * pipeline. This module provides:
 *   - The canonical list of domain labels
 *   - writeDomainLabels() to persist labels to the PKG
 *   - isSignificantChange() to detect when re-classification is warranted
 */

import type { Driver } from 'neo4j-driver';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DOMAIN_LABELS = [
  'decision-making',       // Subsystem 1: cognitive loop, Type 1/2 arbitration, episodic memory, predictions
  'communication',         // Subsystem 2: input parsing, LLM voice, person modeling, TTS/chatbox
  'learning',              // Subsystem 3: consolidation, entity extraction, edge refinement
  'drive-engine',          // Subsystem 4: 12 drives, self-evaluation, opportunity detection
  'planning',              // Subsystem 5: opportunity research, simulations, plan creation
  'knowledge-graph',       // WKG interface, Neo4j queries, Grafeo KGs, confidence dynamics
  'event-backbone',        // TimescaleDB event store, event types, subscriptions
  'database',              // PostgreSQL system DB, drive rules, settings, migrations
  'web-api',               // HTTP routes, WebSocket handlers, REST endpoints, controllers
  'metrics',               // Observability, monitoring, health checks
  'orchestration',         // Main loop, app module, startup, module wiring
  'shared-utilities',      // Generic helpers, type definitions, config, logging
  'testing',               // Test utilities, fixtures, test infrastructure
  'unclassified',
] as const;

export type DomainLabel = typeof DOMAIN_LABELS[number];

const SIGNIFICANT_CHANGE_FIELDS = new Set(['full', 'jsDoc', 'returnType', 'bodyText', 'args']);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClassificationResult {
  name: string;
  filePath: string;
  domain: DomainLabel;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isSignificantChange(changedFields: string[]): boolean {
  return changedFields.some(f => SIGNIFICANT_CHANGE_FIELDS.has(f));
}

export async function writeDomainLabels(
  results: ClassificationResult[],
  driver: Driver
): Promise<void> {
  if (results.length === 0) return;

  const session = driver.session({ defaultAccessMode: 'WRITE' });
  const tx = session.beginTransaction();

  try {
    for (const result of results) {
      await tx.run(
        `
        MATCH (f:Function {filePath: $filePath, name: $name})
        SET f.domain = $domain
        `,
        { filePath: result.filePath, name: result.name, domain: result.domain }
      );
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    await session.close();
  }
}
