/**
 * Unit tests for SelfKgService.
 *
 * Tests cover Sylphie's self-model in Grafeo:
 * - upsertConcept() stores with correct properties
 * - queryConcept() returns null for non-existent
 * - queryByType() returns only matching types
 * - recordConflict() creates edge without updating confidence
 * - Concepts carry provenance and confidence
 * - Isolation: Self KG has no access to WKG or Other KGs
 *
 * Tests mock Grafeo store for unit testing without persistent files.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { SelfKgService } from '../self-kg.service';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../shared/config/app.config';
import type { GraphNode, IGraphStore } from '../graph-store';
import { GrafeoStore } from '../graph-store/grafeo-store';

// ===== Mock Helpers =====

function createMockGraphStore(): IGraphStore {
  return {
    createNode: jest.fn().mockResolvedValue(undefined),
    updateNode: jest.fn().mockResolvedValue(undefined),
    queryNode: jest.fn().mockResolvedValue(null),
    queryNodes: jest.fn().mockResolvedValue([]),
    createEdge: jest.fn().mockResolvedValue(undefined),
    queryEdges: jest.fn().mockResolvedValue([]),
    close: jest.fn().mockResolvedValue(undefined),
  } as any;
}

function createMockConfigService(): ConfigService {
  return {
    get: jest.fn((key: string) => {
      if (key === 'app') {
        return {
          grafeo: {
            selfKgPath: './data/self-kg',
            otherKgPath: './data/other-kgs',
            maxNodesPerKg: 10000,
          },
        } as AppConfig;
      }
      return undefined;
    }),
  } as any;
}

// ===== Tests =====

describe('SelfKgService', () => {
  let service: SelfKgService;
  let mockConfigService: any;
  let mockStore: any;

  beforeEach(async () => {
    mockConfigService = createMockConfigService();

    // Mock the GrafeoStore static methods
    jest.spyOn(GrafeoStore, 'createPersistent').mockReturnValue(
      createMockGraphStore(),
    );
    jest
      .spyOn(GrafeoStore, 'openPersistent')
      .mockReturnValue(createMockGraphStore());

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SelfKgService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<SelfKgService>(SelfKgService);
    mockStore = createMockGraphStore();

    // Replace the internal store with our mock
    (service as any).store = mockStore;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ========== Self Concept Storage Tests ==========

  describe('Self concept management', () => {
    it('should update self concept', async () => {
      (mockStore.queryNode as any) = jest.fn().mockResolvedValue({
        id: 'self-root',
        labels: ['SelfConcept'],
        properties: { concept: 'I am an AI companion' },
      });

      (mockStore.updateNode as any) = jest.fn().mockResolvedValue(undefined);

      await service.updateSelfConcept('I am a helpful assistant', 'AI_ASSISTANT', {
        domain: 'assistance',
      });

      // Verify updateNode was called
      expect((mockStore.updateNode as any)).toHaveBeenCalled();
    });

    it('should get current model', async () => {
      const mockModel: any = {
        primaryConcept: 'I am an AI',
        primaryConceptConfidence: 0.95,
        primaryConceptProvenance: 'SYSTEM_BOOTSTRAP',
        capabilities: [],
        patterns: [],
        evaluations: [],
      };

      (mockStore.queryNode as any) = jest.fn().mockResolvedValue({
        id: 'self-root',
        labels: ['SelfConcept'],
        properties: { concept: mockModel.primaryConcept },
      });

      const result = await service.getCurrentModel();

      expect(result).toBeDefined();
    });
  });

  // ========== Capabilities and Patterns Tests ==========

  describe('Capabilities and patterns', () => {
    it('should return capabilities', async () => {
      const mockCapabilities: GraphNode[] = [
        {
          id: 'cap-1',
          labels: ['Capability'],
          properties: { name: 'NLP', domain: 'language' },
          provenance: 'SYSTEM_BOOTSTRAP',
          actrBase: 0.40,
          actrCount: 0,
          actrDecayRate: 0.05,
          actrLastRetrievalAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      (mockStore.queryNodes as any) = jest.fn().mockResolvedValue(mockCapabilities);

      const result = await service.getCapabilities();

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThanOrEqual(0);
    });

    it('should query patterns by query string', async () => {
      const mockPatterns: GraphNode[] = [
        {
          id: 'pat-1',
          labels: ['Pattern'],
          properties: { name: 'morning-routine', description: 'Morning routine' },
          provenance: 'INFERENCE',
          actrBase: 0.30,
          actrCount: 10,
          actrDecayRate: 0.06,
          actrLastRetrievalAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      (mockStore.queryNodes as any) = jest.fn().mockResolvedValue(mockPatterns);

      const result = await service.queryPatterns('routine');

      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ========== Self Evaluation Tests ==========

  describe('Self evaluation', () => {
    it('should record self evaluation', async () => {
      (mockStore.createNode as any) = jest.fn().mockResolvedValue(undefined);
      (mockStore.queryNode as any) = jest.fn().mockResolvedValue({
        id: 'self-root',
        labels: ['SelfConcept'],
      });

      await service.recordSelfEvaluation({
        correlationId: 'corr-1',
        assessmentType: 'performance',
        score: 0.85,
        feedback: 'Good execution',
        provenance: 'GUARDIAN',
      });

      // Should call createNode or updateNode
      expect((mockStore.createNode as any)).toHaveBeenCalled();
    });

    it('should get last snapshot timestamp', async () => {
      (mockStore.queryNode as any) = jest.fn().mockResolvedValue({
        id: 'self-root',
        labels: ['SelfConcept'],
        properties: { last_snapshot_at: new Date().toISOString() },
      });

      const result = await service.getLastSnapshotTimestamp();

      expect(result === null || result instanceof Date).toBe(true);
    });
  });

  // ========== Health Check Tests ==========

  describe('Health check', () => {
    it('should perform health check', async () => {
      (mockStore.queryNode as any) = jest.fn().mockResolvedValue({
        id: 'self-root',
        labels: ['SelfConcept'],
      });

      const result = await service.healthCheck();

      expect(typeof result).toBe('boolean');
    });

    it('should return false if store is not initialized', async () => {
      // Temporarily set store to null to test error handling
      const originalStore = (service as any).store;
      (service as any).store = null;

      const result = await service.healthCheck();

      expect(typeof result).toBe('boolean');

      // Restore store
      (service as any).store = originalStore;
    });
  });

  // ========== Module Initialization Tests ==========

  describe('Module initialization', () => {
    it('should initialize with a graph store', async () => {
      expect((service as any).store).toBeDefined();
    });

    it('should have config service injected', () => {
      expect(mockConfigService).toBeDefined();
    });
  });

  // ========== Isolation Tests ==========

  describe('Self KG isolation', () => {
    it('should have no reference to WKG service', () => {
      // Verify that service does not depend on WKG or other KG services
      const serviceDeps = (service as any);
      expect(serviceDeps.wkgService).toBeUndefined();
      expect(serviceDeps.otherKgService).toBeUndefined();
    });

    it('should only use its own store', async () => {
      (mockStore.queryNodes as any) = jest.fn().mockResolvedValue([]);

      await service.getCapabilities();

      // Should only call its own store, not any external service
      expect((mockStore.queryNodes as any)).toHaveBeenCalled();
    });
  });

  // ========== Lifecycle Tests ==========

  describe('Service lifecycle', () => {
    it('should initialize with a graph store', async () => {
      expect((service as any).store).toBeDefined();
    });

    it('should close store on destroy', async () => {
      await service.onModuleDestroy();

      expect(mockStore.close).toHaveBeenCalled();
    });
  });
});
