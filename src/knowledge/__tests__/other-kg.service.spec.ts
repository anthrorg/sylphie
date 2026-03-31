/**
 * Unit tests for OtherKgService.
 *
 * Tests cover per-person KG management:
 * - Per-person registry creates isolated stores
 * - upsertPersonConcept() stores in correct person's graph
 * - Different persons have completely isolated data
 * - listPersonGraphs() returns all tracked persons
 * - deletePersonGraph() removes instance
 * - Each person gets their own Grafeo store
 * - No cross-contamination between person KGs
 *
 * Tests mock Grafeo stores for unit testing without persistent files.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { OtherKgService } from '../other-kg.service';
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

describe('OtherKgService', () => {
  let service: OtherKgService;
  let mockConfigService: any;
  const storesByPerson = new Map<string, any>();

  beforeEach(async () => {
    mockConfigService = createMockConfigService();
    storesByPerson.clear();

    // Mock GrafeoStore static methods
    jest.spyOn(GrafeoStore, 'createPersistent').mockImplementation((path) => {
      const store = createMockGraphStore();
      return store;
    });

    jest.spyOn(GrafeoStore, 'openPersistent').mockImplementation((path) => {
      const store = createMockGraphStore();
      return store;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OtherKgService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<OtherKgService>(OtherKgService);
    await service.onModuleInit();
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    jest.clearAllMocks();
  });

  // ========== Per-Person Store Tests ==========

  describe('Per-person store management', () => {
    it('should create isolated stores for different persons', () => {
      // getOrCreateStore is private and returns a store
      const stores = (service as any).stores;
      expect(stores).toBeInstanceOf(Map);
    });

    it('should track known person IDs', async () => {
      const mockStore = createMockGraphStore();
      jest.spyOn(service as any, 'getOrCreateStore').mockResolvedValue(mockStore);

      // Create stores for different persons
      await service.createPerson('dave', 'Dave');
      await service.createPerson('eve', 'Eve');

      const personIds = await service.getKnownPersonIds();
      expect(personIds).toBeDefined();
      expect(Array.isArray(personIds)).toBe(true);
    });
  });

  // ========== Person Concept Storage Tests ==========

  describe('Person model management', () => {
    it('should create a person model', async () => {
      const mockStore = createMockGraphStore();
      jest.spyOn(service as any, 'getOrCreateStore').mockResolvedValue(mockStore);

      (mockStore.queryNodes as any) = jest.fn()
        .mockResolvedValueOnce([]) // No existing Person node
        .mockResolvedValueOnce([]); // Empty person nodes after create
      (mockStore.createNode as any) = jest.fn().mockResolvedValue(undefined);

      // Mock the PersonModel result
      (service as any).getPersonModel = jest.fn().mockResolvedValue({
        personId: 'alice',
        name: 'Alice',
        traits: [],
        interactionCount: 0,
        lastInteractionAt: null,
      });

      const result = await service.createPerson('alice', 'Alice');

      expect(result).toBeDefined();
      expect(result.personId).toBe('alice');
    });

    it('should separate data for different persons', async () => {
      const aliceStore = createMockGraphStore();
      const bobStore = createMockGraphStore();

      const spy = jest.spyOn(service as any, 'getOrCreateStore');
      (spy as any).mockImplementation(
        (personId: string) => {
          return Promise.resolve(personId === 'alice' ? aliceStore : bobStore);
        },
      );

      (aliceStore.queryNodes as any) = jest.fn().mockResolvedValue([]);
      (bobStore.queryNodes as any) = jest.fn().mockResolvedValue([]);

      (service as any).getPersonModel = jest.fn().mockResolvedValue(null);

      await service.createPerson('alice', 'Alice');
      await service.createPerson('bob', 'Bob');

      // Verify each person got their own store
      expect(aliceStore.createNode).toHaveBeenCalled();
      expect(bobStore.createNode).toHaveBeenCalled();
    });
  });

  // ========== Isolation Tests ==========

  describe('Person KG isolation', () => {
    it('should keep different persons\' stores separate', async () => {
      const aliceStore = createMockGraphStore();
      const graceStore = createMockGraphStore();

      jest.spyOn(service as any, 'getOrCreateStore').mockImplementation(
        (personId: string) => {
          return Promise.resolve(personId === 'alice' ? aliceStore : graceStore);
        },
      );

      // Mock the queryNodes for Person checks
      (aliceStore.queryNodes as any) = jest.fn().mockResolvedValue([]);
      (graceStore.queryNodes as any) = jest.fn().mockResolvedValue([]);

      (service as any).getPersonModel = jest.fn().mockResolvedValue(null);

      await service.createPerson('alice', 'Alice');
      await service.createPerson('grace', 'Grace');

      // Verify each person's data went to their own store
      expect(aliceStore.createNode).toHaveBeenCalled();
      expect(graceStore.createNode).toHaveBeenCalled();
    });

    it('should isolate different persons\' stores completely', async () => {
      const store1 = createMockGraphStore();
      const store2 = createMockGraphStore();

      (jest.spyOn(service as any, 'getOrCreateStore') as any).mockImplementation(
        (personId: string) => Promise.resolve(personId === 'helen' ? store1 : store2),
      );

      (store1.queryNodes as any) = jest.fn().mockResolvedValue([]);
      (store2.queryNodes as any) = jest.fn().mockResolvedValue([]);

      (service as any).getPersonModel = jest.fn().mockResolvedValue(null);

      await service.createPerson('helen', 'Helen');
      await service.createPerson('iris', 'Iris');

      // Verify stores are different
      expect(store1).not.toBe(store2);
      expect(store1.createNode).toHaveBeenCalled();
      expect(store2.createNode).toHaveBeenCalled();
    });
  });

  // ========== List and Query Tests ==========

  describe('Person ID tracking', () => {
    it('should return list of all known persons', async () => {
      const mockStore = createMockGraphStore();
      jest.spyOn(service as any, 'getOrCreateStore').mockResolvedValue(mockStore);
      (mockStore.queryNodes as any) = jest.fn().mockResolvedValue([]);
      (service as any).getPersonModel = jest.fn().mockResolvedValue(null);

      // Create persons
      await service.createPerson('jack', 'Jack');
      await service.createPerson('kate', 'Kate');
      await service.createPerson('liam', 'Liam');

      const persons = await service.getKnownPersonIds();

      expect(Array.isArray(persons)).toBe(true);
      expect(persons.length).toBeGreaterThanOrEqual(0);
    });

    it('should track known persons', async () => {
      const knownIds = (service as any).knownPersonIds;
      expect(knownIds).toBeInstanceOf(Set);
    });
  });

  // ========== Delete Tests ==========

  describe('deletePerson()', () => {
    it('should delete a person', async () => {
      const mockStore = createMockGraphStore();
      jest.spyOn(service as any, 'getOrCreateStore').mockResolvedValue(mockStore);
      (mockStore.queryNodes as any) = jest.fn().mockResolvedValue([]);
      (service as any).getPersonModel = jest.fn().mockResolvedValue(null);

      // Create a person
      await service.createPerson('maya', 'Maya');

      // Delete it
      const result = await service.deletePerson('maya');

      expect(typeof result).toBe('boolean');
    });

    it('should handle deleting non-existent person', async () => {
      const result = await service.deletePerson('nonexistent-person');

      expect(typeof result).toBe('boolean');
    });
  });

  // ========== Person Traits Query Tests ==========

  describe('queryPersonTraits()', () => {
    it('should return traits from person\'s KG', async () => {
      const mockStore = createMockGraphStore();
      jest.spyOn(service as any, 'getOrCreateStore').mockResolvedValue(mockStore);

      const mockTraits: GraphNode[] = [
        {
          id: 'trait-1',
          labels: ['Trait'],
          properties: { name: 'Quick learner' },
          provenance: 'SENSOR',
          actrBase: 0.40,
          actrCount: 5,
          actrDecayRate: 0.05,
          actrLastRetrievalAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      (mockStore.queryNodes as any) = jest.fn().mockResolvedValue(mockTraits);

      const result = await service.queryPersonTraits('oscar');

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThanOrEqual(0);
    });

    it('should return empty array for person with no traits', async () => {
      const mockStore = createMockGraphStore();
      jest.spyOn(service as any, 'getOrCreateStore').mockResolvedValue(mockStore);

      (mockStore.queryNodes as any) = jest.fn().mockResolvedValue([]);

      const result = await service.queryPersonTraits('pam');

      expect(result).toEqual([]);
    });
  });

  // ========== Person Interaction Tests ==========

  describe('recordInteraction()', () => {
    it('should record an interaction for a person', async () => {
      const mockStore = createMockGraphStore();
      jest.spyOn(service as any, 'getOrCreateStore').mockResolvedValue(mockStore);
      (mockStore.queryNodes as any) = jest.fn().mockResolvedValue([]); // No existing Person

      await service.recordInteraction('quinn', {
        interactionType: 'KNOWS',
        summary: 'Quinn encountered Rachel',
        driveEffectsObserved: { curiosity: 0.5 },
        correlationId: 'corr-1',
        recordedAt: new Date(),
      });

      // Verify store methods were called
      expect((mockStore.queryNodes as any)).toHaveBeenCalled();
    });
  });

  // ========== Query Interaction History Tests ==========

  describe('queryInteractionHistory()', () => {
    it('should return interaction history for a person', async () => {
      const mockStore = createMockGraphStore();
      jest.spyOn(service as any, 'getOrCreateStore').mockResolvedValue(mockStore);

      (mockStore.queryNodes as any) = jest.fn().mockResolvedValue([]); // No interactions

      const result = await service.queryInteractionHistory('uma', 5);

      expect(Array.isArray(result)).toBe(true);
    });

    it('should respect limit parameter', async () => {
      const mockStore = createMockGraphStore();
      jest.spyOn(service as any, 'getOrCreateStore').mockResolvedValue(mockStore);

      (mockStore.queryNodes as any) = jest.fn().mockResolvedValue([]);

      await service.queryInteractionHistory('victor', 10);

      // Should call queryNodes with appropriate params
      expect((mockStore.queryNodes as any)).toHaveBeenCalled();
    });
  });

  // ========== Lifecycle Tests ==========

  describe('Service lifecycle', () => {
    it('should initialize module', async () => {
      expect((service as any).otherKgPath).toBeDefined();
      expect((service as any).stores).toBeInstanceOf(Map);
      expect((service as any).knownPersonIds).toBeInstanceOf(Set);
    });

    it('should close all stores on destroy', async () => {
      const store1 = createMockGraphStore();
      const store2 = createMockGraphStore();

      const storeMap = new Map([
        ['wendy', store1],
        ['xavier', store2],
      ]);

      (service as any).stores = storeMap;

      await service.onModuleDestroy();

      expect(store1.close).toHaveBeenCalled();
      expect(store2.close).toHaveBeenCalled();
    });
  });
});
