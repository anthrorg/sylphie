/**
 * WorkingMemoryService — Activation-driven context buffer.
 *
 * Replaces the flat-concatenation approach in DeliberationService with a
 * fixed-capacity, activation-scored buffer. Items from different sources
 * (WKG facts, episodes, drives, scene, procedures) compete for slots
 * based on a composite activation score.
 *
 * The activation model combines:
 *   1. Relevance — Jaccard similarity to current input + entity overlap
 *   2. Confidence — Source confidence (WKG, episode ageWeight)
 *   3. Recency — Temporal decay matching episodic memory's ACT-R formula
 *   4. Drive modulation — High-pressure drives boost associated content
 *   5. Spreading activation — BFS through WKG relationships boosts
 *      connected entities across sources
 *
 * Cross-source interaction: an episode mentioning "Alice" gets boosted
 * when Alice-related WKG facts are relevant, and vice versa.
 *
 * CANON §Subsystem 1 (Decision Making): Working memory is the "spotlight"
 * that selects which knowledge enters deliberation. It does not store or
 * modify knowledge — it only selects and activates.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  type SensoryFrame,
  type DriveSnapshot,
  type Episode,
  type WorkingMemoryItem,
  type WorkingMemorySnapshot,
  type WorkingMemorySourceType,
  DriveName,
  verboseFor,
} from '@sylphie/shared';
import type { WkgContext, WkgEntity, WkgFact } from '../wkg/wkg-context.service';
import type { IWorkingMemoryService } from '../interfaces/decision-making.interfaces';
import {
  tokenize,
  extractEntityNames,
  estimateTokens,
  computeRelevanceScore,
  computeRecencyScore,
  computeDriveModulation,
  computeActivation,
  spreadActivation,
  buildAdjacencyMap,
  jaccardSimilarity,
  DEFAULT_WEIGHTS,
  DEFAULT_SPREADING_PARAMS,
  MAX_SLOT_COUNT,
  DEFAULT_TOKEN_BUDGET,
} from './activation';

const vlog = verboseFor('WorkingMemory');

// ---------------------------------------------------------------------------
// Minimum source guarantees (prevent starvation)
// ---------------------------------------------------------------------------

const MIN_SOURCE_SLOTS: Partial<Record<WorkingMemorySourceType, number>> = {
  WKG_FACT: 2,
  EPISODE: 1,
  DRIVE: 1,
  SCENE: 1,
};

// ---------------------------------------------------------------------------
// Source type priority for deterministic tiebreaking
// ---------------------------------------------------------------------------

const SOURCE_PRIORITY: Record<WorkingMemorySourceType, number> = {
  WKG_FACT: 6,
  WKG_ENTITY: 5,
  PROCEDURE: 4,
  EPISODE: 3,
  DRIVE: 2,
  SCENE: 1,
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class WorkingMemoryService implements IWorkingMemoryService {
  private readonly logger = new Logger(WorkingMemoryService.name);
  private lastSnapshot: WorkingMemorySnapshot | null = null;

  /**
   * Assemble a working memory snapshot for the current decision cycle.
   */
  assemble(
    frame: SensoryFrame,
    wkgContext: WkgContext,
    driveSnapshot: DriveSnapshot,
    episodes: readonly Episode[],
    tokenBudget: number = DEFAULT_TOKEN_BUDGET,
  ): WorkingMemorySnapshot {
    const now = new Date();
    const rawText = (frame.raw['text'] as string | undefined) ?? '';
    const sceneDescription = (frame.raw['scene_description'] as string | undefined) ?? '';
    const speakerName = (frame.raw['speaker_name'] as string | undefined) ?? '';

    // Tokenize frame input for relevance scoring
    const frameTokens = tokenize(rawText);
    const frameEntityNames = extractEntityNames(rawText).map((e) => e.toLowerCase());
    const frameEntitySet = new Set(frameEntityNames);

    // Build entity ID -> label mapping for adjacency map
    const entityIdToLabel = new Map<string, string>();
    for (const entity of wkgContext.entities) {
      entityIdToLabel.set(entity.nodeId, entity.label);
    }

    // Build adjacency map from WKG relationships
    const adjacencyMap = buildAdjacencyMap(wkgContext.relationships, entityIdToLabel);

    // Run spreading activation from input entities
    const activationMap = spreadActivation(frameEntityNames, adjacencyMap, DEFAULT_SPREADING_PARAMS);

    // Collect all candidate items from all sources
    const candidates: WorkingMemoryItem[] = [];

    // --- WKG Facts ---
    for (const fact of wkgContext.facts) {
      const text = `${fact.subject} ${fact.predicate} ${fact.object} [confidence: ${fact.confidence.toFixed(2)}]`;
      const entityLabels = [fact.subject.toLowerCase(), fact.object.toLowerCase()];
      const associatedDrives = this.inferDrivesFromRelationships(
        entityLabels,
        wkgContext,
        speakerName,
      );

      candidates.push(
        this.scoreItem({
          id: `fact:${fact.subject}:${fact.predicate}:${fact.object}`,
          sourceType: 'WKG_FACT',
          text,
          entityLabels,
          associatedDrives,
          sourceConfidence: fact.confidence,
          sourceTimestamp: now, // WKG facts are "always current"
          frameTokens,
          frameEntitySet,
          activationMap,
          driveSnapshot,
          now,
        }),
      );
    }

    // --- WKG Entities (as standalone items when they have notable properties) ---
    for (const entity of wkgContext.entities) {
      if (entity.nodeType === 'ActionProcedure') continue; // handled separately
      const provSource =
        entity.provenance === 'GUARDIAN'
          ? 'taught by guardian'
          : entity.provenance === 'SENSOR'
            ? 'observed directly'
            : entity.provenance === 'LLM_GENERATED'
              ? 'inferred (unvalidated)'
              : 'inferred';
      const text = `${entity.label} (${entity.nodeType}, confidence: ${entity.confidence.toFixed(2)}, source: ${provSource})`;
      const entityLabels = [entity.label.toLowerCase()];
      const associatedDrives = this.inferDrivesFromRelationships(
        entityLabels,
        wkgContext,
        speakerName,
      );

      candidates.push(
        this.scoreItem({
          id: `entity:${entity.nodeId}`,
          sourceType: 'WKG_ENTITY',
          text,
          entityLabels,
          associatedDrives,
          sourceConfidence: entity.confidence,
          sourceTimestamp: now,
          frameTokens,
          frameEntitySet,
          activationMap,
          driveSnapshot,
          now,
        }),
      );
    }

    // --- Procedures ---
    for (const proc of wkgContext.procedures) {
      const text = `${proc.label} (confidence: ${proc.confidence.toFixed(2)})`;
      const entityLabels = [proc.label.toLowerCase()];
      const associatedDrives = this.inferDrivesFromRelationships(
        entityLabels,
        wkgContext,
        speakerName,
      );

      candidates.push(
        this.scoreItem({
          id: `proc:${proc.nodeId}`,
          sourceType: 'PROCEDURE',
          text,
          entityLabels,
          associatedDrives,
          sourceConfidence: proc.confidence,
          sourceTimestamp: now,
          frameTokens,
          frameEntitySet,
          activationMap,
          driveSnapshot,
          now,
        }),
      );
    }

    // --- Episodes ---
    for (const episode of episodes) {
      if (!episode.inputSummary || episode.inputSummary.length === 0) continue;

      const minutesAgo = Math.round((now.getTime() - episode.timestamp.getTime()) / 60_000);
      const timeLabel =
        minutesAgo < 1 ? 'just now' : minutesAgo < 60 ? `${minutesAgo} min ago` : `${Math.round(minutesAgo / 60)} hr ago`;
      const text = `${episode.inputSummary} (${timeLabel})`;
      const entityLabels = extractEntityNames(episode.inputSummary).map((e) => e.toLowerCase());

      // Drives associated with this episode: those with pressure > 0.3 at episode time
      const associatedDrives: string[] = [];
      const epDrives = episode.driveSnapshot.pressureVector;
      for (const [name, value] of Object.entries(epDrives)) {
        if ((value as number) > 0.3) associatedDrives.push(name);
      }

      // For episodes, use contextFingerprint Jaccard instead of text Jaccard
      const episodeTokens = tokenize(episode.contextFingerprint || episode.inputSummary);
      const entityOverlap = entityLabels.some((l) => frameEntitySet.has(l));
      const relevance = Math.min(
        1.0,
        jaccardSimilarity(episodeTokens, frameTokens) + (entityOverlap ? 0.30 : 0),
      );

      const recency = computeRecencyScore(episode.timestamp, now);
      const driveModScore = computeDriveModulation(associatedDrives, driveSnapshot.pressureVector);
      const spreadBoost = this.getSpreadingBoost(entityLabels, activationMap);

      const activation = computeActivation(
        relevance,
        episode.ageWeight,
        recency,
        driveModScore,
        spreadBoost,
      );

      candidates.push({
        id: `episode:${episode.id}`,
        sourceType: 'EPISODE',
        text,
        activation,
        estimatedTokens: estimateTokens(text),
        entityLabels,
        associatedDrives,
        sourceConfidence: episode.ageWeight,
        sourceTimestamp: episode.timestamp,
        spreadingBoost: spreadBoost,
      });
    }

    // --- Drive state (single composite item for active drives) ---
    const activeDrives = Object.entries(driveSnapshot.pressureVector)
      .filter(([, v]) => (v as number) > 0.2)
      .map(([name, v]) => `${name}: ${(v as number).toFixed(2)}`);

    if (activeDrives.length > 0) {
      const driveText = activeDrives.join(', ');
      const driveNames = Object.entries(driveSnapshot.pressureVector)
        .filter(([, v]) => (v as number) > 0.2)
        .map(([name]) => name);

      candidates.push({
        id: 'drives:active',
        sourceType: 'DRIVE',
        text: driveText,
        activation: 1.0, // Drives are always maximally relevant (current state)
        estimatedTokens: estimateTokens(driveText),
        entityLabels: [],
        associatedDrives: driveNames,
        sourceConfidence: 1.0,
        sourceTimestamp: now,
        spreadingBoost: 0,
      });
    } else {
      candidates.push({
        id: 'drives:calm',
        sourceType: 'DRIVE',
        text: 'calm (all drives low)',
        activation: 0.50, // Still included via minimum guarantee, moderate activation
        estimatedTokens: estimateTokens('calm (all drives low)'),
        entityLabels: [],
        associatedDrives: [],
        sourceConfidence: 1.0,
        sourceTimestamp: now,
        spreadingBoost: 0,
      });
    }

    // --- Scene description ---
    if (sceneDescription.length > 0) {
      const sceneEntityLabels = extractEntityNames(sceneDescription).map((e) => e.toLowerCase());
      candidates.push(
        this.scoreItem({
          id: 'scene:current',
          sourceType: 'SCENE',
          text: sceneDescription,
          entityLabels: sceneEntityLabels,
          associatedDrives: [],
          sourceConfidence: 1.0,
          sourceTimestamp: now,
          frameTokens,
          frameEntitySet,
          activationMap,
          driveSnapshot,
          now,
        }),
      );
    }

    // --- Select items with capacity enforcement ---
    const selected = this.selectItems(candidates, tokenBudget);

    // --- Format the snapshot ---
    const snapshot = this.buildSnapshot(selected, candidates.length - selected.length, tokenBudget, now, activationMap);

    this.lastSnapshot = snapshot;

    vlog('working memory assembled', {
      totalCandidates: candidates.length,
      selectedItems: selected.length,
      evicted: candidates.length - selected.length,
      totalTokens: snapshot.totalEstimatedTokens,
      tokenBudget,
      activatedEntities: snapshot.activatedEntities.length,
      sourceCounts: snapshot.sourceCounts,
    });

    return snapshot;
  }

  getLastSnapshot(): WorkingMemorySnapshot | null {
    return this.lastSnapshot;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Score a single candidate item using the composite activation function.
   */
  private scoreItem(params: {
    id: string;
    sourceType: WorkingMemorySourceType;
    text: string;
    entityLabels: string[];
    associatedDrives: string[];
    sourceConfidence: number;
    sourceTimestamp: Date;
    frameTokens: Set<string>;
    frameEntitySet: Set<string>;
    activationMap: Map<string, number>;
    driveSnapshot: DriveSnapshot;
    now: Date;
  }): WorkingMemoryItem {
    const itemTokens = tokenize(params.text);
    const entityOverlap = params.entityLabels.some((l) => params.frameEntitySet.has(l));
    const relevance = computeRelevanceScore(itemTokens, params.frameTokens, entityOverlap);
    const recency = computeRecencyScore(params.sourceTimestamp, params.now);
    const driveMod = computeDriveModulation(params.associatedDrives, params.driveSnapshot.pressureVector);
    const spreadBoost = this.getSpreadingBoost(params.entityLabels, params.activationMap);

    const activation = computeActivation(relevance, params.sourceConfidence, recency, driveMod, spreadBoost);

    return {
      id: params.id,
      sourceType: params.sourceType,
      text: params.text,
      activation,
      estimatedTokens: estimateTokens(params.text),
      entityLabels: params.entityLabels,
      associatedDrives: params.associatedDrives,
      sourceConfidence: params.sourceConfidence,
      sourceTimestamp: params.sourceTimestamp,
      spreadingBoost: spreadBoost,
    };
  }

  /**
   * Get the maximum spreading activation boost for an item's entity labels.
   */
  private getSpreadingBoost(entityLabels: readonly string[], activationMap: Map<string, number>): number {
    let maxBoost = 0;
    for (const label of entityLabels) {
      const boost = activationMap.get(label) ?? 0;
      if (boost > maxBoost) maxBoost = boost;
    }
    return maxBoost;
  }

  /**
   * Infer drive associations from WKG relationships.
   *
   * If any relationship of type RELIEVES connects to a known drive name,
   * that drive is associated. Speaker name presence associates 'social'.
   */
  private inferDrivesFromRelationships(
    entityLabels: readonly string[],
    wkgContext: WkgContext,
    speakerName: string,
  ): string[] {
    const drives: Set<string> = new Set();
    const driveNames = new Set(Object.values(DriveName) as string[]);
    const entityLabelSet = new Set(entityLabels);

    // Check RELIEVES relationships
    for (const rel of wkgContext.relationships) {
      if (rel.type !== 'RELIEVES') continue;

      const sourceLabel = wkgContext.entities.find((e) => e.nodeId === rel.sourceId)?.label.toLowerCase();
      const targetLabel = wkgContext.entities.find((e) => e.nodeId === rel.targetId)?.label.toLowerCase();

      if (sourceLabel && entityLabelSet.has(sourceLabel) && targetLabel && driveNames.has(targetLabel)) {
        drives.add(targetLabel);
      }
      if (targetLabel && entityLabelSet.has(targetLabel) && sourceLabel && driveNames.has(sourceLabel)) {
        drives.add(sourceLabel);
      }
    }

    // Speaker name -> social drive association
    if (speakerName && entityLabels.some((l) => l === speakerName.toLowerCase())) {
      drives.add(DriveName.Social);
    }

    return [...drives];
  }

  /**
   * Select items with capacity and token budget enforcement.
   *
   * 1. Fill minimum source guarantees (highest activation within each source).
   * 2. Fill remaining slots by global activation ranking.
   * 3. Enforce token budget by removing lowest-activation items.
   */
  private selectItems(
    candidates: WorkingMemoryItem[],
    tokenBudget: number,
  ): WorkingMemoryItem[] {
    // Group candidates by source type
    const bySource = new Map<WorkingMemorySourceType, WorkingMemoryItem[]>();
    for (const item of candidates) {
      const group = bySource.get(item.sourceType) ?? [];
      group.push(item);
      bySource.set(item.sourceType, group);
    }

    // Sort each group by activation descending
    for (const group of bySource.values()) {
      group.sort((a, b) => b.activation - a.activation || SOURCE_PRIORITY[b.sourceType] - SOURCE_PRIORITY[a.sourceType]);
    }

    const selected = new Set<string>(); // item IDs
    const result: WorkingMemoryItem[] = [];

    // Step 1: Fill minimum source guarantees
    for (const [sourceType, minSlots] of Object.entries(MIN_SOURCE_SLOTS) as Array<[WorkingMemorySourceType, number]>) {
      const group = bySource.get(sourceType) ?? [];
      let filled = 0;
      for (const item of group) {
        if (filled >= minSlots) break;
        if (!selected.has(item.id)) {
          selected.add(item.id);
          result.push(item);
          filled++;
        }
      }
    }

    // Step 2: Collect remaining candidates, sort by activation globally
    const remaining = candidates
      .filter((item) => !selected.has(item.id))
      .sort((a, b) => b.activation - a.activation || SOURCE_PRIORITY[b.sourceType] - SOURCE_PRIORITY[a.sourceType]);

    for (const item of remaining) {
      if (result.length >= MAX_SLOT_COUNT) break;
      result.push(item);
    }

    // Step 3: Enforce token budget — remove lowest-activation items from the end
    // Sort result by activation descending first
    result.sort((a, b) => b.activation - a.activation || SOURCE_PRIORITY[b.sourceType] - SOURCE_PRIORITY[a.sourceType]);

    let totalTokens = result.reduce((sum, item) => sum + item.estimatedTokens, 0);
    while (totalTokens > tokenBudget && result.length > 0) {
      const removed = result.pop()!;
      totalTokens -= removed.estimatedTokens;
    }

    return result;
  }

  /**
   * Build the final WorkingMemorySnapshot from selected items.
   */
  private buildSnapshot(
    items: WorkingMemoryItem[],
    evictedCount: number,
    tokenBudget: number,
    assembledAt: Date,
    activationMap: Map<string, number>,
  ): WorkingMemorySnapshot {
    const sourceCounts: Record<WorkingMemorySourceType, number> = {
      WKG_FACT: 0,
      WKG_ENTITY: 0,
      EPISODE: 0,
      DRIVE: 0,
      SCENE: 0,
      PROCEDURE: 0,
    };

    for (const item of items) {
      sourceCounts[item.sourceType]++;
    }

    const totalEstimatedTokens = items.reduce((sum, item) => sum + item.estimatedTokens, 0);
    const activatedEntities = [...activationMap.keys()];
    const formattedSummary = this.formatSummary(items);

    return {
      items,
      formattedSummary,
      sourceCounts,
      totalEstimatedTokens,
      tokenBudget,
      evictedCount,
      assembledAt,
      activatedEntities,
    };
  }

  /**
   * Format items into a structured summary for LLM system prompt injection.
   *
   * Each line is prefixed with a source tag so the LLM can distinguish
   * knowledge sources. Items are ordered by activation score.
   */
  private formatSummary(items: WorkingMemoryItem[]): string {
    if (items.length === 0) {
      return 'You have NO knowledge about this topic. You must say you don\'t know, or clearly hedge any guess.';
    }

    const lines: string[] = [];
    lines.push('=== YOUR COMPLETE KNOWLEDGE ON THIS TOPIC (nothing beyond this) ===');

    for (const item of items) {
      const tag = this.sourceTag(item.sourceType);
      lines.push(`${tag} ${item.text}`);
    }

    lines.push('=== END OF KNOWLEDGE — anything beyond this is NOT yours to claim ===');

    return lines.join('\n');
  }

  private sourceTag(sourceType: WorkingMemorySourceType): string {
    switch (sourceType) {
      case 'WKG_FACT':
        return '[FACT]';
      case 'WKG_ENTITY':
        return '[ENTITY]';
      case 'EPISODE':
        return '[RECENT]';
      case 'DRIVE':
        return '[FEELING]';
      case 'SCENE':
        return '[SCENE]';
      case 'PROCEDURE':
        return '[PROCEDURE]';
    }
  }
}
