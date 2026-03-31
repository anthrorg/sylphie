/**
 * OtherKgService — Full implementation of IOtherKgService.
 *
 * Routes each personId to its dedicated Grafeo instance (KG(Other_<personId>)).
 * Manages per-person KG instances with lazy creation and proper lifecycle cleanup.
 *
 * CANON §Other KG isolation: Each person has a completely isolated Grafeo
 * graph instance. No KG(Other) data appears in the WKG or KG(Self).
 * Every method accepts personId as its first parameter — this is structural
 * enforcement of that isolation requirement.
 *
 * Provided under the OTHER_KG_SERVICE token by KnowledgeModule.
 */

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';
import * as fs from 'fs';
import { GrafeoStore } from './graph-store/grafeo-store';
import type {
  IOtherKgService,
  PersonModel,
  PersonModelUpdate,
  PersonTrait,
  PersonInteraction,
} from './interfaces/knowledge.interfaces';
import type { AppConfig } from '../shared/config/app.config';
import { computeConfidence } from '../shared/types/confidence.types';
import type { ACTRParams } from '../shared/types/confidence.types';

@Injectable()
export class OtherKgService implements IOtherKgService, OnModuleInit, OnModuleDestroy {
  private readonly stores: Map<string, GrafeoStore> = new Map();
  private readonly knownPersonIds: Set<string> = new Set();
  private otherKgPath: string = '';
  private maxNodesPerKg: number = 10000;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const appConfig = this.config.get<AppConfig>('app');
    this.otherKgPath = appConfig?.grafeo.otherKgPath ?? './data/other-kgs';
    this.maxNodesPerKg = appConfig?.grafeo.maxNodesPerKg ?? 10000;

    // Create data directory if it doesn't exist
    if (!fs.existsSync(this.otherKgPath)) {
      fs.mkdirSync(this.otherKgPath, { recursive: true });
    }

    // Discover existing person directories
    try {
      const entries = fs.readdirSync(this.otherKgPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          this.knownPersonIds.add(entry.name);
        }
      }
    } catch (error) {
      console.warn(`Failed to discover existing person KGs: ${String(error)}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    // Close all open GrafeoStore instances
    for (const [, store] of this.stores) {
      try {
        await store.close();
      } catch (error) {
        console.warn(`Failed to close store: ${String(error)}`);
      }
    }
    this.stores.clear();
  }

  /**
   * Get or create a GrafeoStore instance for a person.
   * Lazy creation: only opens/creates the store on first access.
   */
  private async getOrCreateStore(personId: string): Promise<GrafeoStore> {
    let store = this.stores.get(personId);
    if (store) {
      return store;
    }

    const personDir = path.join(this.otherKgPath, personId);
    const graphFile = path.join(personDir, 'graph.grafeo');

    // Create directory if needed
    if (!fs.existsSync(personDir)) {
      fs.mkdirSync(personDir, { recursive: true });
    }

    // Open existing or create new
    if (fs.existsSync(graphFile)) {
      store = GrafeoStore.openPersistent(graphFile);
    } else {
      store = GrafeoStore.createPersistent(graphFile);
    }

    this.stores.set(personId, store);
    this.knownPersonIds.add(personId);
    return store;
  }

  /**
   * Convert a GraphNode to a PersonTrait.
   */
  private graphNodeToTrait(node: any): PersonTrait {
    const actrParams: ACTRParams = {
      base: node.actrBase ?? 0.35,
      count: node.actrCount ?? 0,
      decayRate: node.actrDecayRate ?? 0.5,
      lastRetrievalAt: node.actrLastRetrievalAt,
    };

    return {
      id: node.id,
      name: node.properties['name'] as string,
      confidence: computeConfidence(actrParams),
      provenance: node.provenance,
      actrParams,
      createdAt: node.createdAt,
    };
  }

  /**
   * Convert a GraphNode to a PersonInteraction.
   */
  private graphNodeToInteraction(node: any): PersonInteraction {
    return {
      id: node.id,
      interactionType: node.properties['interaction_type'] as string,
      summary: node.properties['summary'] as string,
      driveEffectsObserved: (node.properties['drive_effects_observed'] ?? {}) as Record<string, number>,
      correlationId: node.properties['correlation_id'] as string,
      recordedAt: new Date(node.properties['recorded_at'] ?? node.createdAt),
    };
  }

  async getPersonModel(personId: string): Promise<PersonModel | null> {
    const store = await this.getOrCreateStore(personId);

    // Query for the Person node (root)
    const personNodes = await store.queryNodes({
      labels: ['Person'],
      limit: 1,
    });

    if (personNodes.length === 0) {
      return null;
    }

    const personNode = personNodes[0];

    // Query all Trait nodes
    const traitNodes = await store.queryNodes({
      labels: ['Trait'],
      minConfidence: 0.5,
    });

    const traits = traitNodes.map((node) => this.graphNodeToTrait(node));

    return {
      personId,
      name: personNode.properties['name'] as string,
      traits,
      interactionCount: (personNode.properties['interaction_count'] ?? 0) as number,
      lastInteractionAt: personNode.properties['last_interaction_at']
        ? new Date(personNode.properties['last_interaction_at'] as string | number)
        : null,
      createdAt: personNode.createdAt,
    };
  }

  async createPerson(personId: string, name: string): Promise<PersonModel> {
    const store = await this.getOrCreateStore(personId);

    // Check if Person node already exists
    const existing = await store.queryNodes({ labels: ['Person'], limit: 1 });
    if (existing.length > 0) {
      // Return existing model
      return this.getPersonModel(personId) as Promise<PersonModel>;
    }

    // Create root Person node
    const personNodeId = `person_${personId}`;
    const now = new Date().toISOString();

    await store.createNode({
      id: personNodeId,
      labels: ['Person'],
      provenance: 'SYSTEM_BOOTSTRAP',
      actrBase: 0.5,
      actrCount: 0,
      actrDecayRate: 0.5,
      properties: {
        name,
        interaction_count: 0,
        last_interaction_at: null,
        created_at: now,
        updated_at: now,
      },
    });

    return this.getPersonModel(personId) as Promise<PersonModel>;
  }

  async updatePersonModel(personId: string, update: PersonModelUpdate): Promise<void> {
    const store = await this.getOrCreateStore(personId);

    // Find the Person node
    const personNodes = await store.queryNodes({ labels: ['Person'], limit: 1 });
    if (personNodes.length === 0) {
      throw new Error(`Person not found: ${personId}`);
    }

    const personNode = personNodes[0];

    // Update name if provided
    if (update.name !== undefined) {
      await store.updateNode(personNode.id, {
        properties: { name: update.name },
      });
    }

    // Upsert traits
    if (update.traitsToUpsert && update.traitsToUpsert.length > 0) {
      for (const trait of update.traitsToUpsert) {
        // Check if trait already exists by name
        const existingTraits = await store.queryNodes({
          labels: ['Trait'],
          properties: { name: trait.name },
          limit: 1,
        });

        if (existingTraits.length > 0) {
          // Update existing
          const existingTrait = existingTraits[0];
          await store.updateNode(existingTrait.id, {
            properties: {
              confidence: trait.confidence,
              provenance: trait.provenance,
            },
          });
        } else {
          // Create new
          const traitId = `trait_${personId}_${trait.name.replace(/\W+/g, '_')}`;
          await store.createNode({
            id: traitId,
            labels: ['Trait'],
            provenance: trait.provenance,
            actrBase: trait.confidence,
            actrCount: 0,
            actrDecayRate: 0.5,
            properties: {
              name: trait.name,
            },
          });

          // Create HAS_TRAIT edge
          const edgeId = `edge_${personNode.id}_${traitId}`;
          await store.createEdge({
            id: edgeId,
            sourceId: personNode.id,
            targetId: traitId,
            relationship: 'HAS_TRAIT',
            provenance: trait.provenance,
          });
        }
      }
    }

    // Remove traits
    if (update.traitIdsToRemove && update.traitIdsToRemove.length > 0) {
      for (const traitId of update.traitIdsToRemove) {
        // Find and delete the trait node and its edges
        const edges = await store.queryEdges({
          sourceId: personNode.id,
          targetId: traitId,
          relationship: 'HAS_TRAIT',
        });

        for (const edge of edges) {
          await store.deleteEdge(edge.id);
        }

        await store.deleteNode(traitId);
      }
    }
  }

  async queryPersonTraits(personId: string): Promise<PersonTrait[]> {
    const store = await this.getOrCreateStore(personId);

    // Query trait nodes with confidence >= 0.5
    const traitNodes = await store.queryNodes({
      labels: ['Trait'],
      minConfidence: 0.5,
    });

    return traitNodes.map((node) => this.graphNodeToTrait(node));
  }

  async queryInteractionHistory(personId: string, limit: number = 20): Promise<PersonInteraction[]> {
    const store = await this.getOrCreateStore(personId);

    // Query all interaction nodes, sorted by recorded_at descending
    const interactionNodes = await store.queryNodes({
      labels: ['Interaction'],
      limit,
    });

    // Sort by recorded_at descending (most recent first)
    const sorted = interactionNodes.sort((a, b) => {
      const aTimeValue = (a.properties['recorded_at'] as string | number | undefined) ?? a.createdAt;
      const bTimeValue = (b.properties['recorded_at'] as string | number | undefined) ?? b.createdAt;
      const aTime = new Date(aTimeValue).getTime();
      const bTime = new Date(bTimeValue).getTime();
      return bTime - aTime;
    });

    return sorted.slice(0, limit).map((node) => this.graphNodeToInteraction(node));
  }

  async recordInteraction(
    personId: string,
    interaction: Omit<PersonInteraction, 'id'>,
  ): Promise<void> {
    const store = await this.getOrCreateStore(personId);

    // Find Person node
    const personNodes = await store.queryNodes({ labels: ['Person'], limit: 1 });
    if (personNodes.length === 0) {
      throw new Error(`Person not found: ${personId}`);
    }

    const personNode = personNodes[0];
    const now = new Date().toISOString();
    const interactionId = `interaction_${personId}_${Date.now()}`;

    // Create Interaction node
    await store.createNode({
      id: interactionId,
      labels: ['Interaction'],
      provenance: 'SENSOR',
      actrBase: 0.4,
      actrCount: 0,
      actrDecayRate: 0.5,
      properties: {
        interaction_type: interaction.interactionType,
        summary: interaction.summary,
        drive_effects_observed: interaction.driveEffectsObserved,
        correlation_id: interaction.correlationId,
        recorded_at: interaction.recordedAt.toISOString(),
      },
    });

    // Create RECORDS edge from Person to Interaction
    const edgeId = `edge_${personNode.id}_${interactionId}`;
    await store.createEdge({
      id: edgeId,
      sourceId: personNode.id,
      targetId: interactionId,
      relationship: 'RECORDS',
      provenance: 'SENSOR',
    });

    // Update Person node: increment interaction_count and update last_interaction_at
    const updatedCount = ((personNode.properties['interaction_count'] as number) ?? 0) + 1;
    await store.updateNode(personNode.id, {
      properties: {
        interaction_count: updatedCount,
        last_interaction_at: interaction.recordedAt.toISOString(),
      },
    });
  }

  async getKnownPersonIds(): Promise<string[]> {
    return Array.from(this.knownPersonIds);
  }

  async deletePerson(personId: string): Promise<boolean> {
    // Close the store if it's open
    const store = this.stores.get(personId);
    if (store) {
      await store.close();
      this.stores.delete(personId);
    }

    // Delete the person's directory
    const personDir = path.join(this.otherKgPath, personId);
    if (!fs.existsSync(personDir)) {
      return false;
    }

    try {
      fs.rmSync(personDir, { recursive: true, force: true });
      this.knownPersonIds.delete(personId);
      return true;
    } catch (error) {
      throw new Error(`Failed to delete person directory: ${String(error)}`);
    }
  }

  async healthCheck(personId?: string): Promise<boolean> {
    if (!personId) {
      // Check general service health (directory is accessible)
      return fs.existsSync(this.otherKgPath);
    }

    try {
      const store = await this.getOrCreateStore(personId);
      return await store.healthCheck();
    } catch {
      return false;
    }
  }
}
