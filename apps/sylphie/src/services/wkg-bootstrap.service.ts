import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { Neo4jService, Neo4jInstanceName, TimescaleService, DriveName, DRIVE_INDEX_ORDER, CORE_DRIVES } from '@sylphie/shared';
import { ACTION_OUTCOME_REPORTER, IActionOutcomeReporter } from '@sylphie/drive-engine';
import { LatentSpaceService, SensoryPredictionService } from '@sylphie/decision-making';
import { VoiceLatentSpaceService } from './voice-latent-space.service';
import { ConversationHistoryService } from './conversation-history.service';

/**
 * Seeds the World Knowledge Graph with bootstrap nodes on startup.
 *
 * Creates two categories of nodes:
 *   1. CoBeing anchor — Sylphie's self-reference node
 *   2. Drive nodes — the 12 drives (not pre-connected to actions)
 *
 * Also handles full system reset — clears all persistent stores
 * (Neo4j graphs, TimescaleDB tables, latent spaces, conversation history)
 * and re-bootstraps the WKG from scratch.
 *
 * Idempotent — uses MERGE so re-runs are safe.
 */
@Injectable()
export class WkgBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(WkgBootstrapService.name);

  constructor(
    private readonly neo4j: Neo4jService,
    private readonly timescale: TimescaleService,
    private readonly latentSpace: LatentSpaceService,
    private readonly sensoryPrediction: SensoryPredictionService,
    private readonly voiceLatentSpace: VoiceLatentSpaceService,
    private readonly conversationHistory: ConversationHistoryService,
    private readonly config: ConfigService,
    @Inject(ACTION_OUTCOME_REPORTER)
    private readonly outcomeReporter: IActionOutcomeReporter,
  ) {}

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

      // ── 3. Verify counts ──────────────────────────────────────────
      const result = await session.run(`MATCH (n) RETURN count(n) AS cnt`);
      const cnt = result.records[0].get('cnt').toNumber();
      this.logger.log(
        `WKG bootstrap complete: ${cnt} nodes (1 anchor + 12 drives)`,
      );

      // ── 4. Bootstrap Self KG (Grafeo self-model) ──────────────────
      await this.bootstrapSelfKg(now);

      return { nodes: cnt };
    } finally {
      await session.close();
    }
  }

  /**
   * Bootstrap Self KG with Sylphie's core identity.
   *
   * Creates a CoBeing anchor and foundational Attribute facts so the
   * Self KG is never empty. These mirror the WKG CoBeing anchor but live
   * in the SELF graph per CANON §KG Separation.
   */
  private async bootstrapSelfKg(now: string): Promise<void> {
    const session = this.neo4j.getSession(Neo4jInstanceName.SELF, 'WRITE');
    try {
      // CoBeing anchor node
      await session.run(
        `MERGE (self:CoBeing {node_id: 'cobeing-self'})
         ON CREATE SET
           self.label           = 'Sylphie',
           self.name            = 'Sylphie',
           self.node_type       = 'CoBeing',
           self.schema_level    = 'schema',
           self.description     = 'A young mind learning about the world through direct experience',
           self.phase           = '1.5',
           self.provenance_type = 'SYSTEM_BOOTSTRAP',
           self.confidence      = 1.0,
           self.created_at      = $now`,
        { now },
      );

      // Core identity facts as Attribute nodes
      const selfFacts = [
        { key: 'name', value: 'Sylphie' },
        { key: 'identity', value: 'a developing cognitive being' },
        { key: 'phase', value: '1.5 — early development' },
      ];

      for (const fact of selfFacts) {
        const attrId = `self-attr-${fact.key}`;
        await session.run(
          `MERGE (self:CoBeing {node_id: 'cobeing-self'})
           MERGE (a:Attribute {attr_id: $attrId})
           ON CREATE SET
             a.key              = $key,
             a.value            = $value,
             a.confidence       = 1.0,
             a.provenance_type  = 'SYSTEM_BOOTSTRAP',
             a.source           = 'bootstrap',
             a.learned_at       = datetime()
           MERGE (self)-[:HAS_FACT]->(a)`,
          { attrId, key: fact.key, value: fact.value },
        );
      }

      this.logger.log('Self KG bootstrap complete: CoBeing anchor + 3 identity facts');
    } catch (err) {
      this.logger.warn(
        `Self KG bootstrap failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Full system reset: clear ALL persistent stores, then re-bootstrap WKG.
   *
   * Clears:
   *   - Neo4j: World KG, Self KG, Other KG
   *   - TimescaleDB: learned_patterns, voice_patterns, sensory_ticks, events, reflected_sessions
   *   - PostgreSQL: proposed_drive_rules
   *   - Drive Engine: in-memory state reset to INITIAL_DRIVE_STATE via SESSION_START
   *   - In-memory: latent space hot layer, voice cache hot layer, conversation history
   */
  async resetAndBootstrap(): Promise<{
    nodesDeleted: number;
    edgesDeleted: number;
    nodesCreated: number;
  }> {
    // ── 1. Clear all three Neo4j graphs ──────────────────────────────
    let nodesDeleted = 0;
    let edgesDeleted = 0;

    for (const instance of [Neo4jInstanceName.WORLD, Neo4jInstanceName.SELF, Neo4jInstanceName.OTHER]) {
      const session = this.neo4j.getSession(instance, 'WRITE');
      try {
        const countResult = await session.run(
          `MATCH (n) OPTIONAL MATCH (n)-[r]-() RETURN count(DISTINCT n) AS nodes, count(DISTINCT r) AS edges`,
        );
        nodesDeleted += countResult.records[0].get('nodes').toNumber();
        edgesDeleted += countResult.records[0].get('edges').toNumber();

        await session.run(`MATCH (n) DETACH DELETE n`);
        this.logger.warn(`Neo4j [${instance}] reset: cleared`);
      } finally {
        await session.close();
      }
    }

    // ── 2. Clear TimescaleDB tables ──────────────────────────────────
    const tables = [
      'learned_patterns',
      'voice_patterns',
      'sensory_ticks',
      'events',
      'reflected_sessions',
    ];

    for (const table of tables) {
      try {
        await this.timescale.query(`TRUNCATE ${table} CASCADE`);
        this.logger.warn(`TimescaleDB: truncated ${table}`);
      } catch (err) {
        // Table may not exist yet on first run — that's fine
        this.logger.debug(`TimescaleDB: ${table} truncate skipped (${err instanceof Error ? err.message : String(err)})`);
      }
    }

    // ── 3. Clear PostgreSQL drive tables ────────────────────────────────
    const pgPool = new Pool({
      host: this.config.get('postgres.host', 'localhost'),
      port: this.config.get('postgres.port', 5434),
      database: this.config.get('postgres.database', 'sylphie_system'),
      user: this.config.get('postgres.adminUser', 'postgres'),
      password: this.config.get('postgres.adminPassword', 'postgres'),
      max: 1,
      connectionTimeoutMillis: 5000,
    });

    try {
      await pgPool.query('TRUNCATE proposed_drive_rules CASCADE');
      this.logger.warn('PostgreSQL: truncated proposed_drive_rules');
    } catch (err) {
      this.logger.debug(
        `PostgreSQL: proposed_drive_rules truncate skipped (${err instanceof Error ? err.message : String(err)})`,
      );
    } finally {
      await pgPool.end();
    }

    // ── 4. Reset Drive Engine in-memory state ───────────────────────────
    this.outcomeReporter.resetDriveState();
    this.logger.warn('Drive Engine: in-memory state reset to INITIAL_DRIVE_STATE');

    // ── 5. Clear in-memory state ─────────────────────────────────────
    await this.latentSpace.clear();
    this.sensoryPrediction.reset();
    await this.voiceLatentSpace.clear();
    this.conversationHistory.clear();

    this.logger.warn(
      `Full system reset complete: ${nodesDeleted} Neo4j nodes, ${edgesDeleted} edges deleted. ` +
        `TimescaleDB tables truncated. PostgreSQL proposed rules cleared. Drive state reset. In-memory caches cleared.`,
    );

    // ── 6. Re-bootstrap WKG ──────────────────────────────────────────
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
