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
} from '@sylphie/shared';
import { DRIVE_INDEX_ORDER } from '@sylphie/shared';
import type { IEpisodicMemoryService, IActionRetrieverService } from '../interfaces/decision-making.interfaces';
import { EPISODIC_MEMORY_SERVICE, ACTION_RETRIEVER_SERVICE } from '../decision-making.tokens';

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
    this.logger.debug(`Categorized frame: ${inputCategory} (modalities: ${frame.active_modalities.join(', ')})`);

    // Step 2: Extract entities from raw modality data
    const entities = this.extractEntities(frame);

    // Step 3: Generate a one-line input summary for episodic memory
    const inputSummary = this.summarizeFrame(frame, inputCategory, entities);

    // Step 4: Compute dominant drive
    const dominantDrive = computeDominantDrive(driveSnapshot);

    // Step 5: Generate context fingerprint from fused embedding
    const contextFingerprint = this.generateFingerprint(frame, inputCategory, dominantDrive);

    // Step 6: Query episodic memory for similar contexts
    if (this.episodicMemory) {
      const similarEpisodes = this.episodicMemory.queryByContext(
        contextFingerprint,
        DEFAULT_RECENT_EPISODES_FOR_CONTEXT,
      );
      this.logger.debug(`Found ${similarEpisodes.length} similar prior episodes`);
    }

    // Step 7: Retrieve action candidates from the WKG
    let candidates: ActionCandidate[] = [];
    if (this.actionRetriever) {
      try {
        candidates = await this.actionRetriever.retrieve(contextFingerprint, driveSnapshot);
        this.logger.debug(`Retrieved ${candidates.length} action candidates`);
      } catch (err) {
        this.logger.error(`Failed to retrieve action candidates: ${err}`);
        candidates = [];
      }
    }

    // Step 8: Rank (Type 1 first, then Type 2) and cap at Cowan's limit
    const ranked = rankCandidates(candidates);
    const capped = ranked.slice(0, INNER_MONOLOGUE_CAPACITY);

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
   * Categorize a SensoryFrame based on its active modalities.
   */
  private categorizeFrame(frame: SensoryFrame): InputCategory {
    const modalities = new Set(frame.active_modalities);

    // Check for guardian feedback in raw text data
    const rawText = frame.raw['text'] as { content?: string; guardianFeedback?: string } | undefined;
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
    const rawText = frame.raw['text'] as { content?: string } | undefined;
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
    const rawText = frame.raw['text'] as { content?: string } | undefined;

    if (rawText?.content) {
      // Truncate to ~100 chars
      const content = rawText.content.length > 100
        ? rawText.content.substring(0, 97) + '...'
        : rawText.content;
      return `[${category}] ${content}`;
    }

    if (entities.length > 0) {
      return `[${category}] entities: ${entities.slice(0, 5).join(', ')}`;
    }

    return `[${category}] ${frame.active_modalities.join('+')} frame at ${frame.timestamp}`;
  }

  /**
   * Generate a deterministic context fingerprint.
   *
   * Uses SHA-256 of the fused embedding's first 64 values + category + dominant drive.
   * This produces consistent fingerprints for similar sensory contexts.
   */
  private generateFingerprint(
    frame: SensoryFrame,
    category: InputCategory,
    dominantDrive: DriveName,
  ): string {
    // Use first 64 values of fused embedding for fingerprint (sufficient for uniqueness)
    const embeddingSlice = frame.fused_embedding.slice(0, 64);
    // Quantize to 2 decimal places to allow near-identical frames to match
    const quantized = embeddingSlice.map((v) => Math.round(v * 100) / 100);

    const fingerprintString = `${category}::${quantized.join(',')}::${dominantDrive}`;
    return createHash('sha256').update(fingerprintString).digest('hex');
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
