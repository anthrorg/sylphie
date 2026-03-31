/**
 * Grafeo Spike Test: E3-T001
 *
 * This test validates Grafeo v0.5.28 viability for Self KG and Other KG implementations.
 *
 * Coverage:
 * - Basic node/edge creation and retrieval
 * - Metadata persistence (provenance, ACT-R parameters)
 * - Cypher query execution (MATCH, WHERE, SET)
 * - File persistence (write, close, reopen, verify)
 * - Supported vs. unsupported Cypher operations
 * - Performance baseline for 10-node graphs
 *
 * Result: Documents findings and blockers for fallback planning.
 */

import { GrafeoDB } from '@grafeo-db/js';
import * as fs from 'fs';
import * as path from 'path';

describe('Grafeo v0.5.28 Spike Test', () => {
  let testDbPath: string;
  let db: GrafeoDB | null = null;

  beforeAll(() => {
    // Create temp file path for persistence test
    testDbPath = path.join('/tmp', `grafeo-spike-${Date.now()}.db`);
  });

  afterEach(() => {
    if (db) {
      db.close();
      db = null;
    }
  });

  afterAll(() => {
    // Cleanup
    if (fs.existsSync(testDbPath)) {
      try {
        // Remove directory if it exists as directory
        const stats = fs.statSync(testDbPath);
        if (stats.isDirectory()) {
          fs.rmSync(testDbPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(testDbPath);
        }
      } catch (err) {
        // Ignore cleanup errors
      }
    }
  });

  // ============================================================================
  // TEST 1: In-Memory Creation and Node Operations
  // ============================================================================

  test('[S1] Should create in-memory database', () => {
    db = GrafeoDB.create();
    expect(db).toBeDefined();
    expect(db.nodeCount()).toBe(0);
    expect(db.edgeCount()).toBe(0);
  });

  test('[S2] Should create nodes with metadata', () => {
    db = GrafeoDB.create();

    const node1 = db.createNode(['Entity', 'Self'], {
      id: 'entity_1',
      name: 'Sylphie Self-Model',
      provenance: 'GUARDIAN',
      actr_base: 0.60,
      actr_count: 5,
      actr_decay_rate: 0.5,
      created_at: new Date().toISOString(),
    });

    expect(node1).toBeDefined();
    expect(node1.id).toBeDefined();
    expect(node1.labels).toContain('Entity');
    expect(node1.labels).toContain('Self');
    expect(node1.get('name')).toBe('Sylphie Self-Model');
    expect(node1.get('provenance')).toBe('GUARDIAN');
    expect(node1.get('actr_base')).toBe(0.60);
  });

  test('[S3] Should create 10 test nodes with confidence/provenance', () => {
    db = GrafeoDB.create();

    const provenances = ['SENSOR', 'GUARDIAN', 'LLM_GENERATED', 'INFERENCE'];
    const nodeIds: number[] = [];

    for (let i = 0; i < 10; i++) {
      const provenance = provenances[i % provenances.length];
      const actrBase = 0.3 + (i % 4) * 0.15; // 0.3, 0.45, 0.6, 0.75

      const node = db.createNode([`Type_${i % 3}`], {
        id: `test_node_${i}`,
        name: `Node ${i}`,
        provenance,
        actr_base: actrBase,
        actr_count: i,
        actr_decay_rate: 0.5 + (i % 3) * 0.1,
        created_at: new Date().toISOString(),
      });

      nodeIds.push(node.id);
      expect(node).toBeDefined();
    }

    expect(db.nodeCount()).toBe(10);
    expect(nodeIds.length).toBe(10);
  });

  // ============================================================================
  // TEST 2: Query Operations (MATCH, WHERE, SET)
  // ============================================================================

  test('[Q1] Should execute MATCH query and retrieve nodes', async () => {
    db = GrafeoDB.create();

    // Create 3 nodes
    db.createNode(['Person'], {
      name: 'Alice',
      provenance: 'GUARDIAN',
    });
    db.createNode(['Person'], {
      name: 'Bob',
      provenance: 'SENSOR',
    });
    db.createNode(['Place'], {
      name: 'Office',
      provenance: 'GUARDIAN',
    });

    // Query all Person nodes
    const result = await db.executeCypher('MATCH (n:Person) RETURN n');

    expect(result.length).toBe(2);
    const nodes = result.nodes();
    expect(nodes).toHaveLength(2);
    expect(nodes[0].labels).toContain('Person');
  });

  test('[Q2] Should execute WHERE clause filtering', async () => {
    db = GrafeoDB.create();

    const n1 = db.createNode(['Entity'], {
      name: 'High Confidence',
      confidence: 0.85,
      provenance: 'GUARDIAN',
    });
    const n2 = db.createNode(['Entity'], {
      name: 'Low Confidence',
      confidence: 0.25,
      provenance: 'LLM_GENERATED',
    });
    const n3 = db.createNode(['Entity'], {
      name: 'Medium Confidence',
      confidence: 0.55,
      provenance: 'SENSOR',
    });

    // Query with WHERE
    const result = await db.executeCypher(
      'MATCH (n:Entity) WHERE n.confidence > 0.5 RETURN n ORDER BY n.confidence DESC',
    );

    // Should return 2 nodes (High and Medium, not Low)
    expect(result.length).toBe(2);
    // Grafeo query result contains rows with WHERE filtering applied
    expect(result.columns).toContain('n');
  });

  test('[Q3] Should execute SET operations for property updates', async () => {
    db = GrafeoDB.create();

    const node = db.createNode(['Knowledge'], {
      fact: 'Initial',
      version: 1,
      provenance: 'SENSOR',
    });

    const numericId = node.id;

    // Update via db.setNodeProperty (direct API)
    db.setNodeProperty(numericId, 'fact', 'Updated');
    db.setNodeProperty(numericId, 'version', 2);

    const updated = db.getNode(numericId);
    expect(updated).toBeDefined();
    expect(updated!.get('fact')).toBe('Updated');
    expect(updated!.get('version')).toBe(2);
  });

  // ============================================================================
  // TEST 3: Edge Operations
  // ============================================================================

  test('[E1] Should create edges with metadata', () => {
    db = GrafeoDB.create();

    const source = db.createNode(['Entity'], { name: 'Source' });
    const target = db.createNode(['Entity'], { name: 'Target' });

    const edge = db.createEdge(source.id, target.id, 'KNOWS', {
      confidence: 0.75,
      provenance: 'INFERENCE',
      actr_base: 0.45,
      created_at: new Date().toISOString(),
    });

    expect(edge).toBeDefined();
    expect(edge.sourceId).toBe(source.id);
    expect(edge.targetId).toBe(target.id);
    expect(edge.edgeType).toBe('KNOWS');
    expect(edge.get('confidence')).toBe(0.75);
  });

  test('[E2] Should query edges with MATCH', async () => {
    db = GrafeoDB.create();

    const n1 = db.createNode(['Entity'], { id: 'e1' });
    const n2 = db.createNode(['Entity'], { id: 'e2' });
    const n3 = db.createNode(['Entity'], { id: 'e3' });

    db.createEdge(n1.id, n2.id, 'RELATED', {
      confidence: 0.8,
    });
    db.createEdge(n2.id, n3.id, 'RELATED', {
      confidence: 0.6,
    });

    const result = await db.executeCypher(
      'MATCH (s)-[r:RELATED]->(t) RETURN s, r, t',
    );

    expect(result.length).toBe(2);
    const edges = result.edges();
    expect(edges).toHaveLength(2);
  });

  // ============================================================================
  // TEST 4: Persistence (File-Backed Store)
  // ============================================================================

  test('[P1] Should create persistent database file', () => {
    const p1Path = testDbPath + '_p1';
    db = GrafeoDB.create(p1Path);
    expect(db).toBeDefined();

    db.createNode(['Persistent'], {
      data: 'test',
      provenance: 'GUARDIAN',
    });

    expect(db.nodeCount()).toBe(1);
    db.close();
    db = null;

    expect(fs.existsSync(p1Path)).toBe(true);

    // Cleanup
    try {
      const stats = fs.statSync(p1Path);
      if (stats.isDirectory()) {
        fs.rmSync(p1Path, { recursive: true, force: true });
      } else {
        fs.unlinkSync(p1Path);
      }
    } catch (err) {
      // Ignore
    }
  });

  test('[P2] Should reopen persistent database and verify data', () => {
    const p2Path = testDbPath + '_p2';
    // Create initial data
    db = GrafeoDB.create(p2Path);
    db.createNode(['Original'], {
      message: 'First write',
      provenance: 'SENSOR',
    });
    db.close();
    db = null;

    // Reopen and verify
    db = GrafeoDB.open(p2Path);
    expect(db.nodeCount()).toBe(1);

    db.close();
    db = null;

    // Cleanup
    try {
      const stats = fs.statSync(p2Path);
      if (stats.isDirectory()) {
        fs.rmSync(p2Path, { recursive: true, force: true });
      } else {
        fs.unlinkSync(p2Path);
      }
    } catch (err) {
      // Ignore
    }
  });

  test('[P3] Should survive close and reopen cycle', async () => {
    const p3Path = testDbPath + '_p3';
    // Write phase
    db = GrafeoDB.create(p3Path);
    const n1 = db.createNode(['Entity'], {
      id: 'persistent_1',
      name: 'Test Data',
      provenance: 'GUARDIAN',
      actr_base: 0.65,
    });
    const n2 = db.createNode(['Entity'], {
      id: 'persistent_2',
      name: 'Test Data 2',
      provenance: 'SENSOR',
    });
    db.createEdge(n1.id, n2.id, 'LINKS', {
      provenance: 'INFERENCE',
    });

    expect(db.nodeCount()).toBe(2);
    expect(db.edgeCount()).toBe(1);
    db.close();
    db = null;

    // Read phase
    db = GrafeoDB.open(p3Path);
    expect(db.nodeCount()).toBe(2);
    expect(db.edgeCount()).toBe(1);

    const result = await db.executeCypher('MATCH (n) RETURN n');
    expect(result.length).toBe(2);

    db.close();
    db = null;

    // Cleanup
    try {
      const stats = fs.statSync(p3Path);
      if (stats.isDirectory()) {
        fs.rmSync(p3Path, { recursive: true, force: true });
      } else {
        fs.unlinkSync(p3Path);
      }
    } catch (err) {
      // Ignore
    }
  });

  // ============================================================================
  // TEST 5: ACT-R Dynamics and Metadata
  // ============================================================================

  test('[ACT-R1] Should store and retrieve ACT-R parameters', async () => {
    db = GrafeoDB.create();

    const node = db.createNode(['Knowledge'], {
      name: 'Test Fact',
      provenance: 'GUARDIAN',
      actr_base: 0.55,
      actr_count: 12,
      actr_decay_rate: 0.45,
      actr_last_retrieval_at: new Date().toISOString(),
    });

    const retrieved = db.getNode(node.id);
    expect(retrieved!.get('actr_base')).toBe(0.55);
    expect(retrieved!.get('actr_count')).toBe(12);
    expect(retrieved!.get('actr_decay_rate')).toBe(0.45);
  });

  test('[ACT-R2] Should compute confidence using ACT-R formula', async () => {
    db = GrafeoDB.create();

    // Create node with known ACT-R params
    // confidence = min(1.0, base + 0.12*ln(count) - decay*ln(hours+1))
    // With base=0.6, count=10, decay=0.5, hours=0:
    // confidence = 0.6 + 0.12*ln(10) - 0.5*ln(1)
    //            = 0.6 + 0.12*2.303 = 0.6 + 0.276 = 0.876

    const node = db.createNode(['TestFact'], {
      actr_base: 0.6,
      actr_count: 10,
      actr_decay_rate: 0.5,
      provenance: 'GUARDIAN',
    });

    // Verify we can retrieve these values for external computation
    const retrieved = db.getNode(node.id);
    const base = retrieved!.get('actr_base') as number;
    const count = retrieved!.get('actr_count') as number;
    const decay = retrieved!.get('actr_decay_rate') as number;

    const confidence =
      Math.min(1.0, base + 0.12 * Math.log(count) - decay * Math.log(1));
    expect(confidence).toBeGreaterThan(0.85);
    expect(confidence).toBeLessThanOrEqual(1.0);
  });

  // ============================================================================
  // TEST 6: Provenance Tracking
  // ============================================================================

  test('[PROV1] Should distinguish provenance types', async () => {
    db = GrafeoDB.create();

    db.createNode(['Data'], { provenance: 'SENSOR' });
    db.createNode(['Data'], { provenance: 'GUARDIAN' });
    db.createNode(['Data'], { provenance: 'LLM_GENERATED' });
    db.createNode(['Data'], { provenance: 'INFERENCE' });

    const result = await db.executeCypher(
      "MATCH (n:Data) WHERE n.provenance = 'GUARDIAN' RETURN n",
    );
    expect(result.length).toBe(1);
  });

  // ============================================================================
  // TEST 7: Unsupported / Limited Cypher Operations
  // ============================================================================

  test('[CYPHER-LIMIT1] OPTIONAL MATCH is limited', async () => {
    db = GrafeoDB.create();

    db.createNode(['A'], { name: 'a1' });
    db.createNode(['B'], { name: 'b1' });

    // OPTIONAL MATCH may not be fully supported; test it
    try {
      const result = await db.executeCypher(
        'MATCH (a:A) OPTIONAL MATCH (a)-[:REL]->(b:B) RETURN a, b',
      );
      // If we get here, it works
      expect(result).toBeDefined();
    } catch (err) {
      // Expected: OPTIONAL MATCH limited in Grafeo 0.5.28
      console.log('[INFO] OPTIONAL MATCH not fully supported:', err);
    }
  });

  test('[CYPHER-LIMIT2] Aggregation functions may be limited', async () => {
    db = GrafeoDB.create();

    db.createNode(['Value'], { num: 10 });
    db.createNode(['Value'], { num: 20 });
    db.createNode(['Value'], { num: 30 });

    // Test COUNT aggregation
    try {
      const result = await db.executeCypher(
        'MATCH (v:Value) RETURN COUNT(v) as cnt',
      );
      expect(result.length).toBe(1);
      // COUNT should work
    } catch (err) {
      console.log('[INFO] COUNT aggregation failed:', err);
    }
  });

  test('[CYPHER-LIMIT3] Complex WHERE expressions', async () => {
    db = GrafeoDB.create();

    db.createNode(['Item'], { x: 5, y: 10 });
    db.createNode(['Item'], { x: 15, y: 20 });

    // Test compound WHERE
    try {
      const result = await db.executeCypher(
        'MATCH (i:Item) WHERE i.x > 7 AND i.y < 25 RETURN i',
      );
      expect(result.length).toBeGreaterThanOrEqual(1);
    } catch (err) {
      console.log('[INFO] Complex WHERE expressions failed:', err);
    }
  });

  // ============================================================================
  // TEST 8: Performance Baseline
  // ============================================================================

  test('[PERF1] Should handle 10-node graph efficiently', async () => {
    db = GrafeoDB.create();

    const start = Date.now();

    // Create 10 nodes
    const nodes: number[] = [];
    for (let i = 0; i < 10; i++) {
      const node = db.createNode(['Node'], {
        index: i,
        provenance: i % 2 === 0 ? 'SENSOR' : 'GUARDIAN',
        actr_base: 0.3 + (i % 10) * 0.07,
      });
      nodes.push(node.id);
    }

    // Create edges (simple chain)
    for (let i = 0; i < 9; i++) {
      db.createEdge(nodes[i], nodes[i + 1], 'NEXT', {
        provenance: 'INFERENCE',
      });
    }

    const setupTime = Date.now() - start;

    // Query performance
    const queryStart = Date.now();
    const result = await db.executeCypher('MATCH (n)-[r]->(m) RETURN n, r, m');
    const queryTime = Date.now() - queryStart;

    expect(db.nodeCount()).toBe(10);
    expect(db.edgeCount()).toBe(9);
    expect(setupTime).toBeLessThan(100); // Setup should be fast
    expect(queryTime).toBeLessThan(50); // Query should be fast

    console.log(
      `[PERF] Setup: ${setupTime}ms, Query: ${queryTime}ms, Nodes: 10, Edges: 9`,
    );
  });

  // ============================================================================
  // TEST 9: Error Handling and Edge Cases
  // ============================================================================

  test('[ERR1] Should handle missing node gracefully', () => {
    db = GrafeoDB.create();

    const node = db.getNode(99999); // Non-existent ID
    expect(node).toBeNull();
  });

  test('[ERR2] Should handle missing edge gracefully', () => {
    db = GrafeoDB.create();

    const edge = db.getEdge(99999); // Non-existent ID
    expect(edge).toBeNull();
  });

  test('[ERR3] Should handle edge creation with non-existent nodes', () => {
    db = GrafeoDB.create();

    // Grafeo allows creating edges with non-existent nodes (orphaned edges)
    // This is a documented behavior: nodes are not validated at edge creation time
    const edge = db.createEdge(9999, 10000, 'INVALID', {});
    expect(edge).toBeDefined();
    // Edge exists but references non-existent nodes
  });

  // ============================================================================
  // TEST 10: Schema and Metadata Operations
  // ============================================================================

  test('[SCHEMA1] Should retrieve database info', () => {
    db = GrafeoDB.create();

    db.createNode(['Test'], { x: 1 });
    const info = db.info();

    expect(info).toBeDefined();
    expect(typeof info).toBe('object');
  });

  test('[SCHEMA2] Should retrieve schema', () => {
    db = GrafeoDB.create();

    db.createNode(['Entity', 'Person'], { name: 'test' });
    db.createNode(['Entity', 'Place'], { name: 'test2' });

    const schema = db.schema();
    expect(schema).toBeDefined();
    // Schema should include label information
  });

  test('[SCHEMA3] Should report Grafeo version', () => {
    const version = GrafeoDB.prototype.version?.call(db || GrafeoDB.create());
    expect(version).toBeDefined();
    console.log(`[INFO] Grafeo version: ${version}`);
  });
});
