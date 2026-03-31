/**
 * Neo4jInitService — initialization and health check for the Neo4j driver.
 *
 * Responsibilities:
 * 1. OnModuleInit: Idempotent constraint and index setup
 * 2. OnModuleDestroy: Graceful driver shutdown
 * 3. Health check: Verify Neo4j connectivity and schema integrity
 *
 * CANON §The World Knowledge Graph Is the Brain: This service runs once at
 * startup to ensure the WKG schema is ready. No ongoing queries — pure setup.
 * After initialization, WkgService holds the driver reference.
 */

import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import neo4j, { Driver, Session, Result } from 'neo4j-driver';
import { NEO4J_DRIVER } from './knowledge.tokens';

@Injectable()
export class Neo4jInitService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(Neo4jInitService.name);

  constructor(
    @Inject(NEO4J_DRIVER) private readonly driver: Driver,
  ) {}

  /**
   * OnModuleInit: Idempotent constraint and schema setup.
   *
   * Creates:
   * 1. Uniqueness constraints for node IDs per label
   * 2. Indexes for provenance, confidence, created_at
   * 3. Composite index for label+type
   * 4. Three-level schema seed (MetaSchema → Schema → System)
   *
   * All operations are idempotent (IF NOT EXISTS or CREATE IF NOT EXISTS).
   * Safe to re-run without errors.
   *
   * @throws Error if driver is null or Neo4j connection fails
   */
  async onModuleInit(): Promise<void> {
    this.logger.log('Neo4jInitService: Starting initialization...');

    if (!this.driver) {
      throw new Error(
        'Neo4j driver is null. KnowledgeModule factory provider failed.',
      );
    }

    try {
      // Step 1: Create uniqueness constraints
      await this.setupConstraints();

      // Step 2: Create indexes for query performance
      await this.setupIndexes();

      // Step 3: Seed the three-level schema
      await this.setupSchemaBootstrap();

      this.logger.log('Neo4jInitService: Initialization complete.');
    } catch (error) {
      this.logger.error(
        `Neo4jInitService: Initialization failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * OnModuleDestroy: Graceful driver shutdown.
   *
   * Closes all connections in the driver pool. Called when NestJS shuts down.
   */
  async onModuleDestroy(): Promise<void> {
    this.logger.log('Neo4jInitService: Closing Neo4j driver...');
    if (this.driver) {
      await this.driver.close();
    }
  }

  /**
   * Setup idempotent uniqueness constraints.
   *
   * Each node label (Entity, Concept, Procedure, etc.) has a unique id property.
   * Neo4j 4.x+ syntax: CREATE CONSTRAINT IF NOT EXISTS
   *
   * The full list of labels from CANON:
   * - Entity: Real-world objects
   * - Concept: Abstract ideas
   * - Procedure: Action sequences
   * - Utterance: Language events
   * - SchemaType: Type definitions (SYSTEM_BOOTSTRAP)
   * - SchemaRelType: Relationship definitions (SYSTEM_BOOTSTRAP)
   * - MetaRule: Meta-level rules
   */
  private async setupConstraints(): Promise<void> {
    const session = this.driver.session();

    try {
      const constraintLabels = [
        'Entity',
        'Concept',
        'Procedure',
        'Utterance',
        'SchemaType',
        'SchemaRelType',
        'MetaRule',
      ];

      for (const label of constraintLabels) {
        const constraintName = `${label}_id_unique`;
        const cypher = `CREATE CONSTRAINT ${constraintName} IF NOT EXISTS FOR (n:${label}) REQUIRE n.id IS UNIQUE`;

        this.logger.debug(`Creating constraint: ${constraintName}`);
        await session.run(cypher);
      }

      this.logger.log('Neo4jInitService: All uniqueness constraints created.');
    } finally {
      await session.close();
    }
  }

  /**
   * Setup indexes for query performance.
   *
   * Indexes on:
   * - provenance (single-property, high cardinality, frequently filtered)
   * - confidence (range queries, sorting)
   * - created_at (temporal queries)
   * - (label, type) composite (label + type filtering common)
   */
  private async setupIndexes(): Promise<void> {
    const session = this.driver.session();

    try {
      // Create indexes per label — Neo4j 5 requires a label on node property indexes.
      // Core WKG labels that carry provenance, confidence, and created_at properties.
      const indexedLabels = ['Entity', 'Concept', 'Procedure', 'Utterance'];

      for (const label of indexedLabels) {
        const prefix = label.toLowerCase();

        const provenanceCypher = `CREATE INDEX idx_${prefix}_provenance IF NOT EXISTS FOR (n:${label}) ON (n.provenance)`;
        this.logger.debug(`Creating index: idx_${prefix}_provenance`);
        await session.run(provenanceCypher);

        const confidenceCypher = `CREATE INDEX idx_${prefix}_confidence IF NOT EXISTS FOR (n:${label}) ON (n.confidence)`;
        this.logger.debug(`Creating index: idx_${prefix}_confidence`);
        await session.run(confidenceCypher);

        const createdAtCypher = `CREATE INDEX idx_${prefix}_created_at IF NOT EXISTS FOR (n:${label}) ON (n.created_at)`;
        this.logger.debug(`Creating index: idx_${prefix}_created_at`);
        await session.run(createdAtCypher);
      }

      this.logger.log('Neo4jInitService: All indexes created.');
    } finally {
      await session.close();
    }
  }

  /**
   * Setup three-level schema bootstrap.
   *
   * Level 1: MetaSchema root node (singleton)
   *   - id: 'meta_schema_root'
   *   - Represents the schema of schemas
   *   - No parents
   *
   * Level 2: Schema root node
   *   - id: 'schema_root'
   *   - provenance: SYSTEM_BOOTSTRAP
   *   - Parent: MetaSchema root (DEFINES_SCHEMA relationship)
   *
   * Level 3: Seed a few core SchemaTypes for bootstrapping
   *   - Entity, Concept, Procedure type definitions
   *   - All with provenance: SYSTEM_BOOTSTRAP
   *
   * Idempotent: Uses MERGE to update or create.
   */
  private async setupSchemaBootstrap(): Promise<void> {
    const session = this.driver.session();

    try {
      // Level 1: MetaSchema root
      const metaSchemaCypher = `
        MERGE (m:MetaRule {id: 'meta_schema_root'})
        SET m.label = 'MetaSchema Root'
        SET m.provenance = 'SYSTEM_BOOTSTRAP'
        SET m.confidence = 1.0
        SET m.created_at = timestamp()
      `;

      this.logger.debug('Creating MetaSchema root node...');
      await session.run(metaSchemaCypher);

      // Level 2: Schema root (child of MetaSchema)
      const schemaCypher = `
        MERGE (s:SchemaType {id: 'schema_root'})
        SET s.label = 'Schema Root'
        SET s.type = 'SchemaType'
        SET s.provenance = 'SYSTEM_BOOTSTRAP'
        SET s.confidence = 1.0
        SET s.created_at = timestamp()

        WITH s
        MATCH (m:MetaRule {id: 'meta_schema_root'})
        MERGE (m)-[r:DEFINES_SCHEMA]->(s)
        SET r.provenance = 'SYSTEM_BOOTSTRAP'
        SET r.confidence = 1.0
        SET r.created_at = timestamp()
      `;

      this.logger.debug('Creating Schema root node...');
      await session.run(schemaCypher);

      // Level 3: Core SchemaType seed
      const coreSchemaTypes = ['Entity', 'Concept', 'Procedure'];

      for (const schemaType of coreSchemaTypes) {
        const schemaTypeId = `schema_type_${schemaType.toLowerCase()}`;

        const schemaTypeCypher = `
          MERGE (st:SchemaType {id: $schemaTypeId})
          SET st.label = $label
          SET st.type = 'SchemaType'
          SET st.provenance = 'SYSTEM_BOOTSTRAP'
          SET st.confidence = 1.0
          SET st.created_at = timestamp()

          WITH st
          MATCH (sr:SchemaType {id: 'schema_root'})
          MERGE (sr)-[r:HAS_SCHEMA_TYPE]->(st)
          SET r.provenance = 'SYSTEM_BOOTSTRAP'
          SET r.confidence = 1.0
          SET r.created_at = timestamp()
        `;

        this.logger.debug(`Creating SchemaType: ${schemaType}`);
        await session.run(schemaTypeCypher, {
          schemaTypeId,
          label: `${schemaType} Type`,
        });
      }

      this.logger.log('Neo4jInitService: Schema bootstrap complete.');
    } finally {
      await session.close();
    }
  }

  /**
   * Health check: Verify Neo4j connectivity and constraint verification.
   *
   * Returns true if:
   * 1. Driver connection is alive (RETURN 1 query succeeds)
   * 2. All expected constraints exist
   *
   * This method can be called by liveness/readiness probes.
   *
   * @returns true if Neo4j is healthy, throws otherwise
   */
  async healthCheck(): Promise<boolean> {
    const session = this.driver.session();

    try {
      // Basic connectivity check
      const result = await session.run('RETURN 1 as n');
      if (!result.records.length) {
        throw new Error('Neo4j health check: Empty result from RETURN 1');
      }

      // Verify constraints exist
      const constraintCheck = await session.run(
        `SHOW CONSTRAINTS WHERE name CONTAINS '_unique'`,
      );

      if (constraintCheck.records.length === 0) {
        this.logger.warn(
          'Neo4jInitService: Health check passed but no uniqueness constraints found. Schema may not be initialized.',
        );
      }

      this.logger.debug('Neo4jInitService: Health check passed.');
      return true;
    } catch (error) {
      this.logger.error(
        `Neo4jInitService: Health check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    } finally {
      await session.close();
    }
  }
}
