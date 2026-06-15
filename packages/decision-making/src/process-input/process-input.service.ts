/**
 * ProcessInput Service — SensoryFrame -> FSM Bridge
 *
 * CANON §Subsystem 1 (Decision Making): The ProcessInput service routes
 * sensory frames through the CATEGORIZING and RETRIEVING states. It:
 * 1. Takes a SensoryFrame from the multimodal fusion pipeline
 * 2. Categorizes the input based on active modalities and raw content
 * 3. Generates a context fingerprint from the fused embedding
 * 4. Queries episodic memory for similar contexts
 * 5. Retrieves action candidates from the WKG
 * 6. Caps candidates at 5 (Cowan's working memory limit)
 *
 * Adapted from sylphie-old: Input type changed from CategorizedInput (text +
 * entities) to SensoryFrame (multimodal fused embedding + raw modality data).
 * Context fingerprints use the fused embedding hash instead of Jaccard on text
 * tokens. Entity extraction examines whichever modalities are active.
 */

import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { createHash } from 'crypto';
import type {
  SensoryFrame,
  VideoDetection,
  ActionCandidate,
  DriveSnapshot,
  DriveName,
  SceneSnapshot,
} from '@sylphie/shared';
import { DRIVE_INDEX_ORDER, EMBEDDING_VERSION, verboseFor } from '@sylphie/shared';

const vlog = verboseFor('Cortex');
import type { IEpisodicMemoryService, IActionRetrieverService } from '../interfaces/decision-making.interfaces';
import { EPISODIC_MEMORY_SERVICE, ACTION_RETRIEVER_SERVICE } from '../decision-making.tokens';
import { ModalityRegistryService } from '../inputs/registry/modality-registry.service';

// ---------------------------------------------------------------------------
// Input Category Types
// ---------------------------------------------------------------------------

/**
 * Supported input categories. Drives downstream arbitration path and encoding depth.
 */
export type InputCategory =
  | 'TEXT_INPUT'
  | 'VOICE_INPUT'
  | 'VISUAL_INPUT'
  | 'MULTIMODAL_INPUT'
  | 'GUARDIAN_FEEDBACK'
  | 'DRIVE_SENSOR_TRIGGER'
  | 'SYSTEM_TRIGGER'
  | 'UNKNOWN';

// ---------------------------------------------------------------------------
// ProcessInputResult
// ---------------------------------------------------------------------------

/**
 * Result of processing a SensoryFrame through CATEGORIZING and RETRIEVING states.
 */
export interface ProcessInputResult {
  readonly inputCategory: InputCategory;
  readonly contextFingerprint: string;
  readonly candidates: readonly ActionCandidate[];
  readonly inputSummary: string;
  readonly entities: readonly string[];
  readonly dominantDrive: DriveName;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Maximum candidates in working memory (Cowan's limit). */
const INNER_MONOLOGUE_CAPACITY = 5;

/** Number of recent episodes to query for context matching. */
const DEFAULT_RECENT_EPISODES_FOR_CONTEXT = 3;

// ---------------------------------------------------------------------------
// ProcessInputService Implementation
// ---------------------------------------------------------------------------

@Injectable()
export class ProcessInputService {
  private readonly logger = new Logger(ProcessInputService.name);

  constructor(
    @Optional()
    @Inject(EPISODIC_MEMORY_SERVICE)
    private readonly episodicMemory: IEpisodicMemoryService | null,

    @Optional()
    @Inject(ACTION_RETRIEVER_SERVICE)
    private readonly actionRetriever: IActionRetrieverService | null,

    // Used to obtain the live QUERY embedding of the raw input text for semantic
    // WKG context matching. Optional for graceful degradation in lesion configs.
    @Optional()
    private readonly modalityRegistry: ModalityRegistryService | null,
  ) {}

  /**
   * Process a SensoryFrame through CATEGORIZING and RETRIEVING states.
   *
   * @param frame - Fused sensory frame from the multimodal pipeline.
   * @param driveSnapshot - Current drive state.
   * @returns ProcessInputResult with category, fingerprint, and candidates.
   */
  async processInput(
    frame: SensoryFrame,
    driveSnapshot: DriveSnapshot,
  ): Promise<ProcessInputResult> {
    // Step 1: Categorize based on active modalities
    const inputCategory = this.categorizeFrame(frame);
    vlog('input categorized', { category: inputCategory, modalities: frame.active_modalities });
    this.logger.debug(`Categorized frame: ${inputCategory} (modalities: ${frame.active_modalities.join(', ')})`);

    // Step 2: Extract entities from raw modality data
    const entities = this.extractEntities(frame);
    vlog('entities extracted', { count: entities.length, entities: entities.slice(0, 10) });

    // Step 3: Generate a one-line input summary for episodic memory
    const inputSummary = this.summarizeFrame(frame, inputCategory, entities);

    // Step 4: Compute dominant drive
    const dominantDrive = computeDominantDrive(driveSnapshot);

    // Step 5: Generate context fingerprint from fused embedding
    const contextFingerprint = this.generateFingerprint(frame, inputCategory, dominantDrive);
    vlog('context fingerprint', { fingerprint: contextFingerprint.substring(0, 16), dominantDrive });

    // Step 6: Query episodic memory for similar contexts.
    // WS5 T2.1 — this caller passes the SHA contextFingerprint, so it targets
    // queryByFingerprint explicitly (the SHA-Jaccard path, threshold 0.70). The
    // free-text recall path (queryByContent) is a SEPARATE method used by the
    // episodic_search tool — splitting them prevents the per-cycle SHA lookup
    // from silently returning [] under the content threshold.
    if (this.episodicMemory) {
      const similarEpisodes = this.episodicMemory.queryByFingerprint(
        contextFingerprint,
        DEFAULT_RECENT_EPISODES_FOR_CONTEXT,
      );
      vlog('episodic memory query', { similarEpisodes: similarEpisodes.length });
      this.logger.debug(`Found ${similarEpisodes.length} similar prior episodes`);
    }

    // Step 6b: Obtain the live QUERY embedding for semantic WKG context matching.
    // The fused frame already carries a per-modality text embedding produced by
    // the encoder as a nomic QUERY (`search_query:`) — reuse it to avoid a
    // redundant Ollama round-trip inside the latency-sensitive decision cycle.
    // Fall back to a fresh encode() of the raw text only if no frame text
    // embedding is present. Null when neither is available → cosine fails closed.
    const queryEmbedding = await this.resolveQueryEmbedding(frame);
    vlog('query embedding resolved', {
      hasEmbedding: queryEmbedding !== null,
      dims: queryEmbedding?.length ?? 0,
    });

    // Step 7: Retrieve action candidates from the WKG
    let candidates: ActionCandidate[] = [];
    if (this.actionRetriever) {
      try {
        candidates = await this.actionRetriever.retrieve(
          contextFingerprint,
          driveSnapshot,
          queryEmbedding,
        );
        this.logger.debug(`Retrieved ${candidates.length} action candidates`);
      } catch (err) {
        this.logger.error(`Failed to retrieve action candidates: ${err}`);
        candidates = [];
      }
    }

    // Step 8: Rank (Type 1 first, then Type 2) and cap at Cowan's limit
    const ranked = rankCandidates(candidates);
    const capped = ranked.slice(0, INNER_MONOLOGUE_CAPACITY);

    vlog('processInput complete', {
      category: inputCategory,
      totalCandidates: candidates.length,
      cappedCandidates: capped.length,
      topConfidence: capped.length > 0 ? +capped[0].confidence.toFixed(3) : null,
      summary: inputSummary.substring(0, 80),
    });

    return {
      inputCategory,
      contextFingerprint,
      candidates: capped,
      inputSummary,
      entities,
      dominantDrive,
    };
  }

  /**
   * Normalize frame.raw['text'] to a consistent object form.
   *
   * tick-sampler.updateText() stores a plain string; guardian-feedback frames
   * may carry { content, guardianFeedback }. Both must be handled here so that
   * all downstream reads see a uniform shape without unsafe casts.
   */
  private readText(frame: SensoryFrame): { content?: string; guardianFeedback?: string } {
    const raw = frame.raw['text'];
    if (typeof raw === 'string') return { content: raw };
    return (raw as { content?: string; guardianFeedback?: string } | undefined) ?? {};
  }

  /**
   * Categorize a SensoryFrame based on its active modalities.
   */
  private categorizeFrame(frame: SensoryFrame): InputCategory {
    const modalities = new Set(frame.active_modalities);

    // Check for guardian feedback in raw text data
    const rawText = this.readText(frame);
    if (rawText?.guardianFeedback && rawText.guardianFeedback !== 'none') {
      return 'GUARDIAN_FEEDBACK';
    }

    // Drive-only frames are sensor triggers
    if (modalities.size === 1 && modalities.has('drives')) {
      return 'DRIVE_SENSOR_TRIGGER';
    }

    // Multimodal: more than one non-drive modality
    const nonDriveModalities = frame.active_modalities.filter((m) => m !== 'drives');
    if (nonDriveModalities.length > 1) {
      return 'MULTIMODAL_INPUT';
    }

    // Single modality classification
    if (modalities.has('text')) return 'TEXT_INPUT';
    if (modalities.has('audio')) return 'VOICE_INPUT';
    if (modalities.has('video')) return 'VISUAL_INPUT';

    return 'UNKNOWN';
  }

  /**
   * Extract entities from raw modality data.
   *
   * - Text: split on whitespace, extract capitalized words and noun-like tokens
   * - Video: extract YOLO detection class names
   * - Audio: no entities (raw audio chunks don't contain extractable entities)
   */
  private extractEntities(frame: SensoryFrame): string[] {
    const entities: string[] = [];

    // Extract from text modality
    const rawText = this.readText(frame);
    if (rawText?.content) {
      const words = rawText.content.split(/\s+/).filter((w) => w.length > 2);
      // Capitalized words as potential entities
      for (const word of words) {
        if (/^[A-Z]/.test(word)) {
          entities.push(word.replace(/[.,!?;:]$/, ''));
        }
      }
      // If no capitalized words, use significant content words
      if (entities.length === 0) {
        const stopwords = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our', 'out', 'has', 'have', 'that', 'this', 'with', 'from', 'they', 'been', 'said', 'each', 'which', 'their', 'will', 'what', 'there', 'about']);
        for (const word of words) {
          const lower = word.toLowerCase().replace(/[.,!?;:]$/, '');
          if (!stopwords.has(lower) && lower.length > 3) {
            entities.push(lower);
          }
        }
      }
    }

    // Extract from video modality (YOLO detections)
    const rawVideo = frame.raw['video'] as { detections?: VideoDetection[] } | undefined;
    if (rawVideo?.detections) {
      for (const det of rawVideo.detections) {
        if (det.confidence > 0.5) {
          entities.push(det.class);
        }
      }
    }

    // Extract from scene modality (tracked + identified objects from VWM)
    const rawScene = frame.raw['scene'] as SceneSnapshot | undefined;
    if (rawScene) {
      for (const obj of rawScene.objects) {
        if (obj.state !== 'confirmed') continue;
        entities.push(obj.label);
        if (obj.personId) entities.push(obj.personId);
      }
    }

    // Flag undiscovered objects for context fingerprint matching
    const undiscoveredCount = frame.raw['undiscovered_count'] as number | undefined;
    if (undiscoveredCount && undiscoveredCount > 0) {
      entities.push('unknown', 'unrecognized', 'object');
    }

    // Flag unknown persons for social context fingerprint matching
    const unknownPersonCount = frame.raw['unknown_person_count'] as number | undefined;
    if (unknownPersonCount && unknownPersonCount > 0) {
      entities.push('unknown', 'person', 'stranger', 'face', 'who');
    }

    // Deduplicate
    return [...new Set(entities)];
  }

  /**
   * Generate a one-line summary of the frame for episodic memory.
   */
  private summarizeFrame(
    frame: SensoryFrame,
    category: InputCategory,
    entities: readonly string[],
  ): string {
    const rawText = this.readText(frame);

    if (rawText?.content) {
      // Truncate to ~100 chars
      const content = rawText.content.length > 100
        ? rawText.content.substring(0, 97) + '...'
        : rawText.content;
      return `[${category}] ${content}`;
    }

    // WS5 T1.2: vision-dominant frames carry a VLM caption (scene_description).
    // Include it in the summary so the episode's text surface (and the T2
    // queryByContent recall path) actually contains what she saw, not just the
    // bare `[VISUAL_INPUT] entities: …` label. The caption's LLM_GENERATED
    // provenance is carried separately, machine-readably, in visualContext.caption
    // (built at the encode site) — this is the human-readable narration only.
    const sceneDescription = frame.raw['scene_description'] as string | undefined;
    if (sceneDescription && sceneDescription.trim()) {
      const cap = sceneDescription.length > 100
        ? sceneDescription.substring(0, 97) + '...'
        : sceneDescription;
      if (entities.length > 0) {
        return `[${category}] ${cap} (entities: ${entities.slice(0, 5).join(', ')})`;
      }
      return `[${category}] ${cap}`;
    }

    if (entities.length > 0) {
      return `[${category}] entities: ${entities.slice(0, 5).join(', ')}`;
    }

    return `[${category}] ${frame.active_modalities.join('+')} frame at ${frame.timestamp}`;
  }

  /**
   * Generate a deterministic context fingerprint.
   *
   * P1 #3 — widened from the first-64-dims slice to the FULL fused vector. With a
   * random fusion matrix the variance is NOT concentrated early, so the old
   * slice(0,64) let ~8% of dims decide identity: two visually-distinct same-COCO
   * scenes (mug-on-desk vs book-on-desk) collapsed to ONE fingerprint. Hashing
   * the full quantized vector restores discrimination — once the `visual_embedding`
   * modality (#0) is fused, those scenes now produce DIFFERENT fingerprints.
   *
   * P1 #0+#3 HARD REQUIREMENT 1 — EMBEDDING_VERSION leads the hash PREIMAGE so a
   * v(N) fingerprint can NEVER cross-version-collide with a v(N+1) fingerprint.
   * Bumping the version (e.g. adding a fused modality or widening the slice) makes
   * the migration a clean one-time recall MISS, not a silent corrupted HIT. v1
   * episodes simply stop matching `queryByFingerprint` and remain reachable via
   * the UNAFFECTED `queryByContent` free-text path; the 50-slot ring rolls them
   * over naturally — no deletion or migration of v1 episodes.
   *
   * 2dp quantization is preserved so near-identical frames still collapse to one
   * fingerprint (the intended exact-dedup behavior).
   */
  private generateFingerprint(
    frame: SensoryFrame,
    category: InputCategory,
    dominantDrive: DriveName,
  ): string {
    // Quantize the FULL fused vector to 2 decimal places (collapse near-identical
    // frames; discriminate genuinely-different ones across ALL dims, not just 64).
    const quantized = frame.fused_embedding.map((v) => Math.round(v * 100) / 100);

    // EMBEDDING_VERSION leads the preimage — cross-version collision-free (HR1).
    const fingerprintString = `${EMBEDDING_VERSION}::${category}::${quantized.join(',')}::${dominantDrive}`;
    return createHash('sha256').update(fingerprintString).digest('hex');
  }

  /**
   * Resolve the per-cycle nomic QUERY (`search_query:`) embedding used for
   * semantic WKG context matching.
   *
   * Priority:
   *   1. The frame's existing text modality embedding — the encoder already
   *      produced it as a `search_query:` embedding for this turn, so reusing it
   *      avoids a second Ollama call in the latency-sensitive decision cycle.
   *   2. A fresh `encode()` of the raw input text via the registered text encoder
   *      (also `search_query:`-prefixed) when no frame text embedding exists.
   *
   * Returns null when neither is available (e.g. a non-text frame with no text
   * encoder), which makes every WKG contextMatchScore fail closed to 0.0.
   */
  private async resolveQueryEmbedding(
    frame: SensoryFrame,
  ): Promise<number[] | null> {
    // 1. Reuse the frame's text modality embedding if it is present and non-zero.
    const frameTextEmbedding = frame.modality_embeddings?.['text'];
    if (
      Array.isArray(frameTextEmbedding) &&
      frameTextEmbedding.length > 0 &&
      frameTextEmbedding.some((v) => v !== 0)
    ) {
      return frameTextEmbedding;
    }

    // 2. Fall back to a fresh QUERY embed of the raw text via the text encoder.
    if (!this.modalityRegistry) {
      return null;
    }
    const rawText = this.readText(frame);
    const text = rawText?.content?.trim();
    if (!text || text.length === 0) {
      return null;
    }
    const textEncoder = this.modalityRegistry.get('text');
    if (!textEncoder) {
      return null;
    }
    try {
      const embedding = await textEncoder.encode(text);
      return embedding.some((v) => v !== 0) ? embedding : null;
    } catch (err) {
      this.logger.warn(
        `ProcessInput: query embed failed; WKG context match will fail closed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the highest-pressure drive from a DriveSnapshot.
 */
function computeDominantDrive(driveSnapshot: DriveSnapshot): DriveName {
  let maxDrive = DRIVE_INDEX_ORDER[0];
  let maxValue = driveSnapshot.pressureVector[maxDrive];

  for (const driveName of DRIVE_INDEX_ORDER) {
    const value = driveSnapshot.pressureVector[driveName];
    if (value > maxValue) {
      maxValue = value;
      maxDrive = driveName;
    }
  }

  return maxDrive;
}

/**
 * Rank candidates: Type 1 (with procedure nodes) first, then Type 2.
 * Within each group, sort by confidence descending.
 */
function rankCandidates(candidates: ActionCandidate[]): ActionCandidate[] {
  const type1 = candidates
    .filter((c) => c.procedureData !== null)
    .sort((a, b) => b.confidence - a.confidence);
  const type2 = candidates
    .filter((c) => c.procedureData === null)
    .sort((a, b) => b.confidence - a.confidence);
  return [...type1, ...type2];
}
