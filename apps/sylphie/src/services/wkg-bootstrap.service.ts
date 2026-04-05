import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Neo4jService, Neo4jInstanceName, DriveName, DRIVE_INDEX_ORDER, CORE_DRIVES } from '@sylphie/shared';
import { VOCABULARY } from './wkg-vocabulary';

/**
 * Seeds the World Knowledge Graph with bootstrap nodes on startup.
 *
 * Creates three categories of nodes:
 *   1. CoBeing anchor — Sylphie's self-reference node
 *   2. Drive nodes — the 12 drives (not pre-connected to actions)
 *   3. Vocabulary — ~1000 common words for communication
 *
 * Idempotent — uses MERGE so re-runs are safe.
 */
@Injectable()
export class WkgBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(WkgBootstrapService.name);

  constructor(private readonly neo4j: Neo4jService) {}

  async onModuleInit() {
    await this.bootstrap();
  }

  /**
   * Run the full bootstrap sequence. Safe to call multiple times (idempotent).
   * Called automatically on module init and after a WKG reset.
   */
  async bootstrap(): Promise<{ nodes: number }> {
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');
    const now = new Date().toISOString();

    try {
      // ── 1. CoBeing self-anchor node ──────────────────────────────
      await session.run(
        `MERGE (n:CoBeing {node_id: $id})
         ON CREATE SET
           n.node_type       = 'CoBeing',
           n.schema_level    = 'schema',
           n.label           = 'Sylphie',
           n.name            = 'Sylphie',
           n.description     = 'A young mind learning about the world through direct experience',
           n.phase           = '1.5',
           n.version         = '0.1.0',
           n.provenance_type = 'INFERENCE',
           n.confidence      = 1.0,
           n.created_at      = $now`,
        { id: 'cobeing-self', now },
      );

      // ── 2. Drive nodes (12 drives, not pre-connected) ────────────
      for (const driveName of DRIVE_INDEX_ORDER) {
        const category = CORE_DRIVES.includes(driveName) ? 'core' : 'complement';
        await session.run(
          `MERGE (d:Drive {node_id: $id})
           ON CREATE SET
             d.node_type       = 'Drive',
             d.schema_level    = 'schema',
             d.label           = $label,
             d.drive_name      = $driveName,
             d.category        = $category,
             d.provenance_type = 'INFERENCE',
             d.confidence      = 1.0,
             d.created_at      = $now`,
          {
            id: `drive:${driveName}`,
            label: DRIVE_LABELS[driveName],
            driveName,
            category,
            now,
          },
        );
      }

      // ── 3. Vocabulary words (batch via UNWIND) ───────────────────
      // Deduplicate the vocabulary list before inserting
      const uniqueWords = [...new Set(VOCABULARY)];

      await session.run(
        `UNWIND $words AS word
         MERGE (w:Word {node_id: 'word:' + word})
         ON CREATE SET
           w.node_type       = 'Word',
           w.schema_level    = 'schema',
           w.label           = word,
           w.provenance_type = 'GUARDIAN',
           w.confidence      = 0.6,
           w.created_at      = $now`,
        { words: uniqueWords, now },
      );

      // ── 4. Verify counts ─────────────────────────────────────────
      const result = await session.run(`MATCH (n) RETURN count(n) AS cnt`);
      const cnt = result.records[0].get('cnt').toNumber();
      this.logger.log(
        `WKG bootstrap complete: ${cnt} nodes (1 anchor + 12 drives + ${uniqueWords.length} words)`,
      );
      return { nodes: cnt };
    } finally {
      await session.close();
    }
  }

  /**
   * Delete everything in the WKG and re-bootstrap from scratch.
   * Returns counts of what was deleted and what was re-created.
   */
  async resetAndBootstrap(): Promise<{
    nodesDeleted: number;
    edgesDeleted: number;
    nodesCreated: number;
  }> {
    let nodesDeleted = 0;
    let edgesDeleted = 0;

    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');
    try {
      // Count existing state before deletion
      const countResult = await session.run(
        `MATCH (n) OPTIONAL MATCH (n)-[r]-() RETURN count(DISTINCT n) AS nodes, count(DISTINCT r) AS edges`,
      );
      nodesDeleted = countResult.records[0].get('nodes').toNumber();
      edgesDeleted = countResult.records[0].get('edges').toNumber();

      // Wipe everything
      await session.run(`MATCH (n) DETACH DELETE n`);
      this.logger.warn(`WKG reset: deleted ${nodesDeleted} nodes, ${edgesDeleted} edges`);
    } finally {
      await session.close();
    }

    // Re-bootstrap
    const { nodes: nodesCreated } = await this.bootstrap();
    return { nodesDeleted, edgesDeleted, nodesCreated };
  }
}

// ---------------------------------------------------------------------------
// Human-readable labels for each drive
// ---------------------------------------------------------------------------

const DRIVE_LABELS: Readonly<Record<DriveName, string>> = {
  [DriveName.SystemHealth]: 'System Health',
  [DriveName.MoralValence]: 'Moral Valence',
  [DriveName.Integrity]: 'Integrity',
  [DriveName.CognitiveAwareness]: 'Cognitive Awareness',
  [DriveName.Guilt]: 'Guilt',
  [DriveName.Curiosity]: 'Curiosity',
  [DriveName.Boredom]: 'Boredom',
  [DriveName.Anxiety]: 'Anxiety',
  [DriveName.Satisfaction]: 'Satisfaction',
  [DriveName.Sadness]: 'Sadness',
  [DriveName.Focus]: 'Focus',
  [DriveName.Social]: 'Social',
};
