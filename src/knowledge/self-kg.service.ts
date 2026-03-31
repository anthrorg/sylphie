/**
 * SelfKgService — implementation of ISelfKgService using Grafeo.
 *
 * CANON §Self KG isolation: This service is completely isolated from the WKG
 * and from all OtherKg instances. No cross-graph references, no shared edges.
 * The service has no access to WKG or Other KG instances.
 *
 * Provided under the SELF_KG_SERVICE token by KnowledgeModule.
 */

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { GrafeoStore } from './graph-store/grafeo-store';
import type { IGraphStore, GraphNode, NodeFilter } from './graph-store';
import type { ProvenanceSource } from '../shared/types/provenance.types';
import { resolveBaseConfidence } from '../shared/types/provenance.types';
import { computeConfidence, CONFIDENCE_THRESHOLDS, type ACTRParams } from '../shared/types/confidence.types';
import type { AppConfig } from '../shared/config/app.config';
import type {
  ISelfKgService,
  SelfModel,
  SelfCapability,
  SelfPattern,
  SelfEvaluation,
} from './interfaces/knowledge.interfaces';

@Injectable()
export class SelfKgService implements ISelfKgService, OnModuleInit, OnModuleDestroy {
  private store: IGraphStore | null = null;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const config = this.configService.get<AppConfig>('app');
    if (!config?.grafeo) {
      throw new Error('Grafeo configuration not found');
    }

    const selfKgPath = config.grafeo.selfKgPath;
    const dataDir = path.dirname(selfKgPath);

    // Create data directory if needed
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Check if graph file exists and open or create accordingly
    const graphFile = `${selfKgPath}.db`;
    if (fs.existsSync(graphFile)) {
      this.store = GrafeoStore.openPersistent(selfKgPath);
    } else {
      this.store = GrafeoStore.createPersistent(selfKgPath);
      // Seed a minimal self-model root node
      await this.seedInitialModel();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.store) {
      await this.store.close();
    }
  }

  private async seedInitialModel(): Promise<void> {
    if (!this.store) {
      throw new Error('Graph store not initialized');
    }

    // Create the root "Self" node with SYSTEM_BOOTSTRAP provenance
    const rootId = 'self-root';
    const now = new Date();

    await this.store.createNode({
      id: rootId,
      labels: ['SelfConcept'],
      properties: {
        name: 'Self',
        concept: 'I am an AI companion',
        last_snapshot_at: now.toISOString(),
      },
      provenance: 'SYSTEM_BOOTSTRAP',
      actrBase: resolveBaseConfidence('SYSTEM_BOOTSTRAP'),
      actrCount: 0,
      actrDecayRate: 0.5,
    });
  }

  private getStore(): IGraphStore {
    if (!this.store) {
      throw new Error('Graph store not initialized');
    }
    return this.store;
  }

  async getCurrentModel(): Promise<SelfModel> {
    const store = this.getStore();

    // Query for the primary SelfConcept node
    const conceptNodes = await store.queryNodes({
      labels: ['SelfConcept'],
      limit: 1,
    });

    let primaryConcept = 'I am an AI companion';
    let primaryConceptConfidence = 0.5;
    let primaryConceptProvenance: ProvenanceSource = 'SYSTEM_BOOTSTRAP';

    if (conceptNodes.length > 0) {
      const node = conceptNodes[0];
      primaryConcept = (node.properties['concept'] as string) ?? primaryConcept;
      primaryConceptProvenance = (node.provenance as ProvenanceSource) ?? primaryConceptProvenance;
      const confidence = computeConfidence({
        base: node.actrBase,
        count: node.actrCount,
        decayRate: node.actrDecayRate,
        lastRetrievalAt: node.actrLastRetrievalAt,
      });
      primaryConceptConfidence = confidence;
    }

    // Query for all Capability nodes
    const capabilityNodes = await store.queryNodes({
      labels: ['Capability'],
      minConfidence: CONFIDENCE_THRESHOLDS.retrieval,
    });

    const capabilities: SelfCapability[] = capabilityNodes.map((node) =>
      this.graphNodeToCapability(node),
    );

    // Query for all Pattern nodes
    const patternNodes = await store.queryNodes({
      labels: ['Pattern'],
      minConfidence: CONFIDENCE_THRESHOLDS.retrieval,
    });

    const patterns: SelfPattern[] = patternNodes.map((node) =>
      this.graphNodeToPattern(node),
    );

    // Get last evaluation timestamp
    let lastEvaluatedAt: Date | null = null;
    const evaluationNodes = await store.queryNodes({
      labels: ['SelfEvaluation'],
      limit: 1,
    });
    if (evaluationNodes.length > 0) {
      const evalNode = evaluationNodes[0];
      const evalAtValue = evalNode.properties['evaluated_at'];
      if (evalAtValue) {
        lastEvaluatedAt = new Date(evalAtValue as string | number);
      }
    }

    return {
      primaryConcept,
      primaryConceptConfidence,
      primaryConceptProvenance,
      capabilities,
      patterns,
      lastEvaluatedAt,
    };
  }

  async updateSelfConcept(
    concept: string,
    confidence: number,
    provenance: ProvenanceSource,
  ): Promise<void> {
    const store = this.getStore();

    // Find existing SelfConcept node
    const conceptNodes = await store.queryNodes({
      labels: ['SelfConcept'],
      limit: 1,
    });

    const baseConfidence = resolveBaseConfidence(provenance);
    const clampedConfidence = Math.min(confidence, CONFIDENCE_THRESHOLDS.ceiling);

    if (conceptNodes.length > 0) {
      // Update existing node
      const node = conceptNodes[0];
      await store.updateNode(node.id, {
        properties: {
          concept,
        },
        provenance,
        actrBase: baseConfidence,
      });
    } else {
      // Create new SelfConcept node
      await store.createNode({
        id: `self-concept-${Date.now()}`,
        labels: ['SelfConcept'],
        properties: {
          name: 'Self',
          concept,
        },
        provenance,
        actrBase: baseConfidence,
        actrCount: 0,
        actrDecayRate: 0.5,
      });
    }
  }

  async getCapabilities(): Promise<SelfCapability[]> {
    const store = this.getStore();

    const capabilityNodes = await store.queryNodes({
      labels: ['Capability'],
      minConfidence: CONFIDENCE_THRESHOLDS.retrieval,
    });

    return capabilityNodes.map((node) => this.graphNodeToCapability(node));
  }

  async getLastSnapshotTimestamp(): Promise<Date | null> {
    const store = this.getStore();

    const conceptNodes = await store.queryNodes({
      labels: ['SelfConcept'],
      limit: 1,
    });

    if (conceptNodes.length === 0) {
      return null;
    }

    const node = conceptNodes[0];
    const snapshotValue = node.properties['last_snapshot_at'];

    if (snapshotValue) {
      return new Date(snapshotValue as string | number);
    }

    return null;
  }

  async queryPatterns(query: string): Promise<SelfPattern[]> {
    const store = this.getStore();

    // Query Pattern nodes and filter by description match
    const patternNodes = await store.queryNodes({
      labels: ['Pattern'],
    });

    // Filter by substring match in description (case-insensitive)
    const queryLower = query.toLowerCase();
    const filtered = patternNodes.filter((node) => {
      const description = (node.properties['description'] as string) ?? '';
      return description.toLowerCase().includes(queryLower);
    });

    // Sort by confidence descending
    return filtered
      .map((node) => this.graphNodeToPattern(node))
      .sort((a, b) => b.confidence - a.confidence);
  }

  async recordSelfEvaluation(evaluation: SelfEvaluation): Promise<void> {
    const store = this.getStore();

    // Create Evaluation node
    const evaluationId = `eval-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const now = new Date();

    await store.createNode({
      id: evaluationId,
      labels: ['SelfEvaluation'],
      properties: {
        correlation_id: evaluation.correlationId,
        summary: evaluation.summary,
        valence: evaluation.valence,
        drive_effects: JSON.stringify(evaluation.driveEffects),
        flagged_for_review: false,
        evaluated_at: now.toISOString(),
      },
      provenance: 'LLM_GENERATED',
      actrBase: resolveBaseConfidence('LLM_GENERATED'),
      actrCount: 0,
      actrDecayRate: 0.5,
    });

    // Track consecutive negative evaluations
    if (evaluation.valence === 'negative') {
      const metadataNodes = await store.queryNodes({
        labels: ['MetaData'],
        limit: 1,
      });

      let metadataId: string;
      if (metadataNodes.length === 0) {
        // Create metadata node
        metadataId = `metadata-${Date.now()}`;
        await store.createNode({
          id: metadataId,
          labels: ['MetaData'],
          properties: {
            consecutive_negative_count: 1,
          },
          provenance: 'SYSTEM_BOOTSTRAP',
          actrBase: resolveBaseConfidence('SYSTEM_BOOTSTRAP'),
        });
      } else {
        metadataId = metadataNodes[0].id;
        const node = metadataNodes[0];
        const currentCount = (node.properties['consecutive_negative_count'] as number) ?? 0;
        const newCount = currentCount + 1;

        await store.updateNode(metadataId, {
          properties: {
            consecutive_negative_count: newCount,
          },
        });

        // Flag for review if >= 3 consecutive negatives
        if (newCount >= 3) {
          await store.updateNode(evaluationId, {
            properties: {
              flagged_for_review: true,
            },
          });
        }
      }
    } else {
      // Reset negative counter on non-negative evaluation
      const metadataNodes = await store.queryNodes({
        labels: ['MetaData'],
        limit: 1,
      });

      if (metadataNodes.length > 0) {
        await store.updateNode(metadataNodes[0].id, {
          properties: {
            consecutive_negative_count: 0,
          },
        });
      }
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      if (!this.store) {
        return false;
      }
      return await this.store.healthCheck();
    } catch {
      return false;
    }
  }

  private graphNodeToCapability(node: GraphNode): SelfCapability {
    const actrParams: ACTRParams = {
      base: node.actrBase,
      count: node.actrCount,
      decayRate: node.actrDecayRate,
      lastRetrievalAt: node.actrLastRetrievalAt,
    };

    const confidence = computeConfidence(actrParams);

    return {
      id: node.id,
      name: (node.properties['name'] as string) ?? 'unknown',
      confidence,
      provenance: (node.provenance as ProvenanceSource) ?? 'LLM_GENERATED',
      actrParams,
      createdAt: node.createdAt,
    };
  }

  private graphNodeToPattern(node: GraphNode): SelfPattern {
    const actrParams: ACTRParams = {
      base: node.actrBase,
      count: node.actrCount,
      decayRate: node.actrDecayRate,
      lastRetrievalAt: node.actrLastRetrievalAt,
    };

    const confidence = computeConfidence(actrParams);
    const observationCount = node.actrCount;

    return {
      id: node.id,
      description: (node.properties['description'] as string) ?? 'unknown',
      provenance: (node.provenance as ProvenanceSource) ?? 'BEHAVIORAL_INFERENCE',
      observationCount,
      confidence,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
    };
  }
}
