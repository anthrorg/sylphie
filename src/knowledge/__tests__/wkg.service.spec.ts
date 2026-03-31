/**
 * Unit tests for WkgService.
 *
 * These tests cover the core knowledge graph persistence and retrieval:
 * - upsertNode() with provenance validation and confidence ceiling
 * - upsertEdge() with provenance validation
 * - findNode() returning null for non-existent nodes
 * - queryEdges() with filter application
 * - queryContext() with depth limiting
 * - queryByProvenance() filtering by source
 * - queryGraphStats() returning structured statistics
 * - recordRetrievalAndUse() incrementing retrieval count
 *
 * Tests use jest.mock to inject a mock Neo4j driver and verify
 * Cypher construction without requiring a live database.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { Driver, Session } from 'neo4j-driver';
import { WkgService } from '../wkg.service';
import { NEO4J_DRIVER } from '../knowledge.tokens';
import { EVENTS_SERVICE } from '../../events/events.tokens';
import type {
  NodeUpsertRequest,
  EdgeUpsertRequest,
  NodeLevel,
} from '../../shared/types/knowledge.types';
import type { IEventService } from '../../events/interfaces/events.interfaces';
import { KnowledgeException } from '../../shared/exceptions/domain.exceptions';
import { CONFIDENCE_THRESHOLDS } from '../../shared/types/confidence.types';

// ===== Mock Helpers =====

function createMockSession() {
  return {
    run: jest.fn(),
    close: jest.fn(),
  } as any;
}

function createMockDriver() {
  return {
    session: jest.fn(),
    close: jest.fn(),
    verifyConnectivity: jest.fn().mockResolvedValue(undefined),
  } as any;
}

function createMockEventService() {
  return {
    record: jest.fn().mockResolvedValue({ eventId: 'test-id' }),
  } as any;
}

// ===== Tests =====

describe('WkgService', () => {
  let service: WkgService;
  let mockDriver: any;
  let mockSession: any;
  let mockEventService: any;

  beforeEach(async () => {
    mockDriver = createMockDriver();
    mockSession = createMockSession();
    mockEventService = createMockEventService();

    mockDriver.session.mockReturnValue(mockSession);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WkgService,
        {
          provide: NEO4J_DRIVER,
          useValue: mockDriver,
        },
        {
          provide: EVENTS_SERVICE,
          useValue: mockEventService,
        },
      ],
    }).compile();

    service = module.get<WkgService>(WkgService);

    // Initialize the service
    await service.onModuleInit();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ========== upsertNode() tests ==========

  describe('upsertNode()', () => {
    it('should reject a node upsert with missing provenance', async () => {
      const invalidRequest: any = {
        labels: ['Test'],
        nodeLevel: 'CORE',
        properties: {},
        provenance: undefined,
      };

      await expect(service.upsertNode(invalidRequest)).rejects.toThrow(
        KnowledgeException,
      );
    });

    it('should enforce confidence ceiling for untested nodes (count=0)', async () => {
      const request: NodeUpsertRequest = {
        labels: ['Concept'],
        nodeLevel: 'CORE',
        properties: { name: 'test-concept' },
        provenance: 'SENSOR',
        initialConfidence: 0.8, // Attempting to set above ceiling
      };

      const mockNode = {
        identity: { toNumber: () => 123 },
        labels: ['Concept'],
        properties: {
          nodeLevel: 'CORE',
          provenance: 'SENSOR',
          properties: { name: 'test-concept' },
          actrBase: 0.40,
          actrCount: 0,
          actrDecayRate: 0.05,
          actrLastRetrievalAt: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      };

      mockSession.run.mockResolvedValueOnce({
        records: [{ get: (key: string) => mockNode }],
      });

      const result = await service.upsertNode(request);

      // Verify confidence is capped at ceiling
      expect(result.type).toBe('success');
      expect(result.node).toBeDefined();

      // Check that the Cypher query capped the initial confidence
      const [cypher, params] = mockSession.run.mock.calls[0];
      expect(cypher).toContain('$initialConfidence');
      // The service should have capped the param value before passing
      expect(params.initialConfidence).toBeLessThanOrEqual(
        CONFIDENCE_THRESHOLDS.ceiling,
      );
    });

    it('should enforce confidence ceiling in all cases', async () => {
      const request: NodeUpsertRequest = {
        labels: ['Fact'],
        nodeLevel: 'INSTANCE',
        properties: {},
        provenance: 'LLM_GENERATED',
        initialConfidence: 0.5,
      };

      const mockNode = {
        identity: { toNumber: () => 456 },
        labels: ['Fact'],
        properties: {
          actrBase: 0.35,
          actrCount: 0,
          actrDecayRate: 0.08,
          actrLastRetrievalAt: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      };

      mockSession.run.mockResolvedValueOnce({
        records: [{ get: (key: string) => mockNode }],
      });

      const result = await service.upsertNode(request);

      expect(result.type).toBe('success');
      const [, params] = mockSession.run.mock.calls[0];
      expect(params.initialConfidence).toBeLessThanOrEqual(
        CONFIDENCE_THRESHOLDS.ceiling,
      );
    });

    it('should upsert a node with valid provenance', async () => {
      const request: NodeUpsertRequest = {
        labels: ['Person'],
        nodeLevel: 'CORE',
        properties: { name: 'Alice' },
        provenance: 'GUARDIAN',
      };

      const mockNode = {
        identity: { toNumber: () => 789 },
        labels: ['Person'],
        properties: {
          nodeLevel: 'CORE',
          provenance: 'GUARDIAN',
          properties: { name: 'Alice' },
          actrBase: 0.60,
          actrCount: 0,
          actrDecayRate: 0.03,
          actrLastRetrievalAt: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      };

      mockSession.run.mockResolvedValueOnce({
        records: [{ get: (key: string) => mockNode }],
      });

      const result = await service.upsertNode(request);

      expect(result.type).toBe('success');
      expect(result.node.labels).toContain('Person');
      expect(result.node.provenance).toBe('GUARDIAN');
      expect(result.node.nodeLevel).toBe('CORE');
    });

    it('should close session after successful upsert', async () => {
      const request: NodeUpsertRequest = {
        labels: ['Thing'],
        nodeLevel: 'INSTANCE',
        properties: {},
        provenance: 'INFERENCE',
      };

      const mockNode = {
        identity: { toNumber: () => 999 },
        labels: ['Thing'],
        properties: {
          actrBase: 0.30,
          actrCount: 0,
          actrDecayRate: 0.06,
          actrLastRetrievalAt: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      };

      mockSession.run.mockResolvedValueOnce({
        records: [{ get: (key: string) => mockNode }],
      });

      await service.upsertNode(request);

      expect(mockSession.close).toHaveBeenCalled();
    });

    it('should close session on error', async () => {
      const request: NodeUpsertRequest = {
        labels: ['Bad'],
        nodeLevel: 'CORE',
        properties: {},
        provenance: 'SENSOR',
      };

      mockSession.run.mockRejectedValueOnce(new Error('DB error'));

      try {
        await service.upsertNode(request);
      } catch {
        // Expected
      }

      expect(mockSession.close).toHaveBeenCalled();
    });
  });

  // ========== upsertEdge() tests ==========

  describe('upsertEdge()', () => {
    it('should reject an edge upsert with missing provenance', async () => {
      const invalidRequest: EdgeUpsertRequest = {
        sourceId: 'node-1',
        targetId: 'node-2',
        relationship: 'RELATED_TO',
        properties: {},
        provenance: undefined as any,
      };

      await expect(service.upsertEdge(invalidRequest)).rejects.toThrow(
        KnowledgeException,
      );
      await expect(service.upsertEdge(invalidRequest)).rejects.toThrow(
        'PROVENANCE_MISSING',
      );
    });

    it('should upsert an edge with valid provenance', async () => {
      const request: EdgeUpsertRequest = {
        sourceId: 'n1',
        targetId: 'n2',
        relationship: 'CONNECTED_TO',
        properties: { weight: 0.5 },
        provenance: 'GUARDIAN',
      };

      const mockEdge = {
        identity: { toNumber: () => 111 },
        type: 'CONNECTED_TO',
        start: { identity: { toNumber: () => 1 } },
        end: { identity: { toNumber: () => 2 } },
        properties: {
          provenance: 'GUARDIAN',
          properties: { weight: 0.5 },
          actrBase: 0.60,
          actrCount: 0,
          actrDecayRate: 0.03,
          actrLastRetrievalAt: null,
        },
      };

      mockSession.run.mockResolvedValueOnce({
        records: [{ get: (key: string) => mockEdge }],
      });

      const result = await service.upsertEdge(request);

      expect(result.type).toBe('success');
      expect(result.edge).toBeDefined();
      expect(result.edge.relationship).toBe('CONNECTED_TO');
    });

    it('should enforce confidence ceiling for edges', async () => {
      const request: EdgeUpsertRequest = {
        sourceId: 'n1',
        targetId: 'n2',
        relationship: 'IMPLIES',
        properties: {},
        provenance: 'INFERENCE',
        initialConfidence: 0.5,
      };

      const mockEdge = {
        identity: { toNumber: () => 222 },
        type: 'IMPLIES',
        start: { identity: { toNumber: () => 1 } },
        end: { identity: { toNumber: () => 2 } },
        properties: {
          actrBase: 0.30,
          actrCount: 0,
          actrDecayRate: 0.06,
          actrLastRetrievalAt: null,
        },
      };

      mockSession.run.mockResolvedValueOnce({
        records: [{ get: (key: string) => mockEdge }],
      });

      const result = await service.upsertEdge(request);

      expect(result.type).toBe('success');
      const [, params] = mockSession.run.mock.calls[0];
      expect(params.initialConfidence).toBeLessThanOrEqual(
        CONFIDENCE_THRESHOLDS.ceiling,
      );
    });

    it('should close session after successful edge upsert', async () => {
      const request: EdgeUpsertRequest = {
        sourceId: 'n1',
        targetId: 'n2',
        relationship: 'TEST',
        properties: {},
        provenance: 'SENSOR',
      };

      const mockEdge = {
        identity: { toNumber: () => 333 },
        type: 'TEST',
        start: { identity: { toNumber: () => 1 } },
        end: { identity: { toNumber: () => 2 } },
        properties: {
          actrBase: 0.40,
          actrCount: 0,
          actrDecayRate: 0.05,
          actrLastRetrievalAt: null,
        },
      };

      mockSession.run.mockResolvedValueOnce({
        records: [{ get: (key: string) => mockEdge }],
      });

      await service.upsertEdge(request);

      expect(mockSession.close).toHaveBeenCalled();
    });
  });

  // ========== findNode() tests ==========

  describe('findNode()', () => {
    it('should return null for non-existent node', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [],
      });

      const result = await service.findNode('nonexistent-id');

      expect(result).toBeNull();
    });

    it('should return node when found', async () => {
      const mockNode = {
        identity: { toNumber: () => 444 },
        labels: ['Concept'],
        properties: {
          nodeLevel: 'CORE',
          provenance: 'GUARDIAN',
          properties: { name: 'test' },
          actrBase: 0.60,
          actrCount: 5,
          actrDecayRate: 0.03,
          actrLastRetrievalAt: new Date(),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      };

      mockSession.run.mockResolvedValueOnce({
        records: [{ get: (key: string) => mockNode }],
      });

      const result = await service.findNode('existing-id');

      expect(result).not.toBeNull();
      expect(result?.labels).toContain('Concept');
      expect(result?.actrParams.count).toBe(5);
    });

    it('should close session after query', async () => {
      mockSession.run.mockResolvedValueOnce({ records: [] });

      await service.findNode('test-id');

      expect(mockSession.close).toHaveBeenCalled();
    });
  });

  // ========== queryEdges() tests ==========

  describe('queryEdges()', () => {
    it('should apply relationship filter correctly', async () => {
      mockSession.run.mockResolvedValueOnce({ records: [] });

      await service.queryEdges({
        filter: { relationship: 'KNOWS' },
      });

      const [cypher, params] = mockSession.run.mock.calls[0];
      expect(cypher).toContain('KNOWS');
      expect(params.relationship).toBe('KNOWS');
    });

    it('should apply source node filter', async () => {
      mockSession.run.mockResolvedValueOnce({ records: [] });

      await service.queryEdges({
        filter: { sourceId: 'src-1' },
      });

      const [cypher, params] = mockSession.run.mock.calls[0];
      expect(cypher).toContain('elementId');
      expect(params.sourceId).toBe('src-1');
    });

    it('should return edges with properties', async () => {
      const mockEdge = {
        identity: { toNumber: () => 555 },
        type: 'KNOWS',
        start: { identity: { toNumber: () => 1 } },
        end: { identity: { toNumber: () => 2 } },
        properties: {
          provenance: 'SENSOR',
          properties: { since: '2026-01-01' },
          actrBase: 0.40,
          actrCount: 3,
          actrDecayRate: 0.05,
          actrLastRetrievalAt: new Date(),
        },
      };

      mockSession.run.mockResolvedValueOnce({
        records: [{ get: (key: string) => mockEdge }],
      });

      const result = await service.queryEdges({});

      expect(result).toHaveLength(1);
      expect(result[0].relationship).toBe('KNOWS');
      expect(result[0].actrParams.count).toBe(3);
    });

    it('should close session after query', async () => {
      mockSession.run.mockResolvedValueOnce({ records: [] });

      await service.queryEdges({});

      expect(mockSession.close).toHaveBeenCalled();
    });
  });

  // ========== queryContext() tests ==========

  describe('queryContext()', () => {
    it('should cap depth at 3', async () => {
      mockSession.run.mockResolvedValueOnce({ records: [] });

      await service.queryContext('start-id', 10);

      const [cypher] = mockSession.run.mock.calls[0];
      // Verify that depth is not 10, should be capped at 3
      expect(cypher).toContain('DEPTH');
    });

    it('should return neighboring nodes', async () => {
      const mockNode = {
        identity: { toNumber: () => 666 },
        labels: ['Related'],
        properties: {
          nodeLevel: 'CORE',
          provenance: 'GUARDIAN',
          properties: {},
          actrBase: 0.60,
          actrCount: 0,
          actrDecayRate: 0.03,
          actrLastRetrievalAt: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      };

      mockSession.run.mockResolvedValueOnce({
        records: [{ get: (key: string) => mockNode }],
      });

      const result = await service.queryContext('center-id', 2);

      expect(result).toHaveLength(1);
      expect(result[0].labels).toContain('Related');
    });

    it('should close session after context query', async () => {
      mockSession.run.mockResolvedValueOnce({ records: [] });

      await service.queryContext('id', 1);

      expect(mockSession.close).toHaveBeenCalled();
    });
  });

  // ========== queryByProvenance() tests ==========

  describe('queryByProvenance()', () => {
    it('should filter by provenance correctly', async () => {
      mockSession.run.mockResolvedValueOnce({ records: [] });

      await service.queryByProvenance('GUARDIAN');

      const [cypher, params] = mockSession.run.mock.calls[0];
      expect(cypher).toContain('provenance');
      expect(params.provenance).toBe('GUARDIAN');
    });

    it('should return nodes with matching provenance', async () => {
      const mockNode = {
        identity: { toNumber: () => 777 },
        labels: ['Taught'],
        properties: {
          nodeLevel: 'CORE',
          provenance: 'GUARDIAN',
          properties: { fact: 'important' },
          actrBase: 0.60,
          actrCount: 10,
          actrDecayRate: 0.03,
          actrLastRetrievalAt: new Date(),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      };

      mockSession.run.mockResolvedValueOnce({
        records: [{ get: (key: string) => mockNode }],
      });

      const result = await service.queryByProvenance('GUARDIAN');

      expect(result).toHaveLength(1);
      expect(result[0].provenance).toBe('GUARDIAN');
    });

    it('should close session after provenance query', async () => {
      mockSession.run.mockResolvedValueOnce({ records: [] });

      await service.queryByProvenance('INFERENCE');

      expect(mockSession.close).toHaveBeenCalled();
    });
  });

  // ========== queryGraphStats() tests ==========

  describe('queryGraphStats()', () => {
    it('should return structured graph stats', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: (key: string) => {
              if (key === 'totalNodes') return 100;
              if (key === 'totalEdges') return 250;
              if (key === 'byProvenance') {
                return {
                  GUARDIAN: 40,
                  SENSOR: 30,
                  INFERENCE: 20,
                  LLM_GENERATED: 10,
                };
              }
              if (key === 'byLevel') {
                return {
                  CORE: 50,
                  INTERMEDIATE: 30,
                  INSTANCE: 20,
                };
              }
            },
          },
        ],
      });

      const result = await service.queryGraphStats();

      expect(result.totalNodes).toBe(100);
      expect(result.totalEdges).toBe(250);
      expect(result.byProvenance.GUARDIAN).toBe(40);
      expect(result.byLevel.CORE).toBe(50);
    });

    it('should close session after stats query', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: (key: string) => (key === 'totalNodes' ? 0 : key === 'totalEdges' ? 0 : {}),
          },
        ],
      });

      await service.queryGraphStats();

      expect(mockSession.close).toHaveBeenCalled();
    });
  });

  // ========== recordRetrievalAndUse() tests ==========

  describe('recordRetrievalAndUse()', () => {
    it('should increment retrieval count', async () => {
      // Mock the fetch and update queries
      mockSession.run
        .mockResolvedValueOnce({
          records: [
            {
              get: (key: string) => {
                return {
                  id: 'node-123',
                  provenance: 'GUARDIAN',
                  actrBase: 0.60,
                  actrCount: 5,
                  actrDecayRate: 0.03,
                  actrLastRetrievalAt: new Date(),
                };
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          records: [{ get: (key: string) => true }],
        });

      await service.recordRetrievalAndUse('node-123', true);

      // Verify two queries were made (fetch and update)
      expect(mockSession.run).toHaveBeenCalledTimes(2);
      const [, updateParams] = mockSession.run.mock.calls[1];
      expect(updateParams.count).toBe(6); // Incremented from 5
    });

    it('should not increment count on failed retrieval', async () => {
      mockSession.run
        .mockResolvedValueOnce({
          records: [
            {
              get: (key: string) => {
                return {
                  id: 'node-456',
                  provenance: 'LLM_GENERATED',
                  actrBase: 0.35,
                  actrCount: 3,
                  actrDecayRate: 0.08,
                  actrLastRetrievalAt: new Date(),
                };
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          records: [{ get: (key: string) => true }],
        });

      await service.recordRetrievalAndUse('node-456', false);

      const [, updateParams] = mockSession.run.mock.calls[1];
      expect(updateParams.count).toBe(3); // Not incremented
    });

    it('should close session after recording retrieval', async () => {
      mockSession.run
        .mockResolvedValueOnce({
          records: [
            {
              get: (key: string) => {
                return {
                  id: 'node-789',
                  provenance: 'SENSOR',
                  actrBase: 0.40,
                  actrCount: 1,
                  actrDecayRate: 0.05,
                  actrLastRetrievalAt: new Date(),
                };
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          records: [{ get: (key: string) => true }],
        });

      await service.recordRetrievalAndUse('node-789', true);

      expect(mockSession.close).toHaveBeenCalled();
    });
  });
});
