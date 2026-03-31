/**
 * ProcessInput Orchestrator Service — Categorizing & Predicting (E5-T002)
 *
 * CANON §Subsystem 1 (Decision Making): The ProcessInput orchestrator routes
 * inputs through the CATEGORIZING and PREDICTING states. It:
 * 1. Takes a CategorizedInput from Communication
 * 2. Categorizes the input into one of 8+ input types
 * 3. Triggers prediction context matching via episodic memory
 * 4. Populates the Inner Monologue buffer with up to 5 candidates (Cowan's limit)
 * 5. Ranks candidates by Type 1 availability and confidence
 *
 * Context fingerprints are generated deterministically from input entities,
 * input type, and dominant drive using SHA-256 hashing.
 *
 * CANON §Confidence Dynamics: Type 1 candidates (procedureData != null) are
 * ranked first by confidence. Type 2 candidates follow. The cap of 5 respects
 * Cowan's working memory limit.
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { randomUUID } from 'crypto';
import {
  CategorizedInput,
  IEpisodicMemoryService,
  IActionRetrieverService,
} from '../interfaces/decision-making.interfaces';
import type { ActionCandidate } from '../../shared/types/action.types';
import type { DriveSnapshot, DriveName, DRIVE_INDEX_ORDER } from '../../shared/types/drive.types';
import { EPISODIC_MEMORY_SERVICE, ACTION_RETRIEVER_SERVICE } from '../decision-making.tokens';

// ---------------------------------------------------------------------------
// Input Category Types
// ---------------------------------------------------------------------------

/**
 * Supported input categories for ProcessInput categorizer.
 * These drive the downstream arbitration path and encoding depth.
 */
export type InputCategory =
  | 'FACTUAL_QUERY'
  | 'ACTION_REQUEST'
  | 'SOCIAL_EXCHANGE'
  | 'GUARDIAN_FEEDBACK'
  | 'LEARNING_OPPORTUNITY'
  | 'EMOTIONAL_EXPRESSION'
  | 'SYSTEM_TRIGGER'
  | 'DRIVE_SENSOR_TRIGGER'
  | 'UNKNOWN';

// ---------------------------------------------------------------------------
// ProcessInputResult
// ---------------------------------------------------------------------------

/**
 * The result of processing an input through CATEGORIZING and PREDICTING states.
 *
 * Contains the categorized input type, a deterministic context fingerprint,
 * up to 5 action candidates ranked by confidence, and prediction context
 * including entities, recent episode count, and dominant drive.
 */
export interface ProcessInputResult {
  readonly inputCategory: InputCategory;
  readonly contextFingerprint: string;
  readonly candidates: readonly ActionCandidate[];
  readonly predictionContext: {
    readonly entities: readonly string[];
    readonly recentEpisodeCount: number;
    readonly dominantDrive: DriveName;
  };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Maximum number of candidates in Inner Monologue (Cowan's working memory limit). */
const INNER_MONOLOGUE_CAPACITY = 5;

/** Default number of recent episodes to query for context matching. */
const DEFAULT_RECENT_EPISODES_FOR_CONTEXT = 3;

// ---------------------------------------------------------------------------
// InputCategorizer Helper
// ---------------------------------------------------------------------------

/**
 * Categorizes an input into one of the known input types using pattern matching.
 *
 * Examines the inputType field and content patterns to classify the input.
 * Returns UNKNOWN if no clear category matches.
 *
 * CANON §Type 2 cost: Categorization is a synchronous, low-cost operation.
 *
 * @param input - The categorized input from Communication
 * @returns The matched InputCategory
 */
function categorizeInput(input: CategorizedInput): InputCategory {
  // Check inputType field for direct classification
  const inputTypeStr = input.inputType.toUpperCase();

  // Guardian feedback: explicit feedback type
  if (input.guardianFeedbackType !== 'none') {
    return 'GUARDIAN_FEEDBACK';
  }

  // System/Drive triggers: prefixed input types
  if (inputTypeStr.includes('SYSTEM_TRIGGER')) {
    return 'SYSTEM_TRIGGER';
  }
  if (inputTypeStr.includes('DRIVE_SENSOR') || inputTypeStr.includes('DRIVE_TRIGGER')) {
    return 'DRIVE_SENSOR_TRIGGER';
  }

  // Pattern-match on content
  const contentLower = input.content.toLowerCase();

  // Emotional expression: "I feel", "I'm", "I am", "feeling"
  if (
    /\b(feel|feeling|i'm|i am|i feel)\b/.test(contentLower) &&
    (contentLower.includes('sad') ||
      contentLower.includes('happy') ||
      contentLower.includes('anxious') ||
      contentLower.includes('guilty') ||
      contentLower.includes('frustrated'))
  ) {
    return 'EMOTIONAL_EXPRESSION';
  }

  // Learning opportunity: "teach", "show", "learn", "tell me about", "explain"
  if (
    /\b(teach|show|explain|tell me about|tell me|learn|learned)\b/.test(contentLower) &&
    contentLower.length > 5
  ) {
    return 'LEARNING_OPPORTUNITY';
  }

  // Factual query: "what", "how", "why", "when", "where", "who", "is there"
  if (/^(what|how|why|when|where|who|is|are|do|does|can)\b/.test(contentLower)) {
    return 'FACTUAL_QUERY';
  }

  // Action request: "can you", "do you", "would you", "could you", "please"
  if (
    /\b(can you|do you|would you|could you|please|try|attempt|help me)\b/.test(
      contentLower,
    )
  ) {
    return 'ACTION_REQUEST';
  }

  // Social exchange: greetings, small talk, yes/no responses
  if (
    /\b(hi|hello|bye|goodbye|ok|yes|no|thanks|thank you|sure|okay|great)\b/.test(
      contentLower,
    ) &&
    contentLower.length < 50
  ) {
    return 'SOCIAL_EXCHANGE';
  }

  // Default fallback
  return 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// Context Fingerprint Generation
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic context fingerprint from entities, input type, and dominant drive.
 *
 * Uses SHA-256 hashing of a normalized string constructed from the components.
 * Two identical inputs with the same dominant drive will always produce the same
 * fingerprint, enabling context-based retrieval matching.
 *
 * @param entities - Array of entity strings from the input
 * @param inputType - The categorized input type
 * @param dominantDrive - The highest-pressure drive name
 * @returns A hex-encoded SHA-256 hash
 */
function generateContextFingerprint(
  entities: readonly string[],
  inputCategory: InputCategory,
  dominantDrive: DriveName,
): string {
  // Normalize entities: sort and deduplicate
  const normalizedEntities = Array.from(new Set(entities.map((e) => e.toLowerCase().trim())))
    .sort()
    .join(' ');

  // Construct fingerprint string
  const fingerprintString = `${inputCategory}::${normalizedEntities}::${dominantDrive}`;

  // Hash with SHA-256
  return createHash('sha256').update(fingerprintString).digest('hex');
}

// ---------------------------------------------------------------------------
// Dominant Drive Computation
// ---------------------------------------------------------------------------

/**
 * Compute the highest-pressure (dominant) drive from a drive snapshot.
 *
 * Iterates through all drives and returns the name of the drive with the
 * highest positive value. If all drives are zero or negative, returns the
 * first drive (SystemHealth) as a fallback.
 *
 * CANON §Decision Making: The dominant drive is used for action motivation
 * attribution and for context fingerprint generation.
 *
 * @param driveSnapshot - The current drive state
 * @returns The DriveName with the highest pressure
 */
function computeDominantDrive(driveSnapshot: DriveSnapshot): DriveName {
  const { pressureVector } = driveSnapshot;
  let maxDriveName: DriveName = Object.keys(pressureVector)[0] as DriveName;
  let maxValue = pressureVector[maxDriveName];

  for (const driveName of Object.keys(pressureVector) as DriveName[]) {
    const value = pressureVector[driveName];
    if (value > maxValue) {
      maxValue = value;
      maxDriveName = driveName;
    }
  }

  return maxDriveName;
}

// ---------------------------------------------------------------------------
// ProcessInputService Implementation
// ---------------------------------------------------------------------------

@Injectable()
export class ProcessInputService {
  private readonly logger = new Logger(ProcessInputService.name);

  constructor(
    @Inject(EPISODIC_MEMORY_SERVICE)
    private readonly episodicMemoryService: IEpisodicMemoryService,
    @Inject(ACTION_RETRIEVER_SERVICE)
    private readonly actionRetrieverService: IActionRetrieverService,
  ) {}

  /**
   * Process a categorized input through CATEGORIZING and PREDICTING states.
   *
   * This is the main entry point for ProcessInput orchestration. It:
   * 1. Categorizes the input
   * 2. Computes the dominant drive
   * 3. Generates a context fingerprint
   * 4. Queries episodic memory for similar contexts
   * 5. Retrieves action candidates from the WKG
   * 6. Caps candidates at 5 (Cowan's limit)
   * 7. Returns the result with prediction context
   *
   * CANON §Subsystem 1: This method is called during the CATEGORIZING state
   * of the executor loop. It transitions to PREDICTING and returns preparation
   * for action retrieval and ranking.
   *
   * @param input - The CategorizedInput from Communication
   * @param driveSnapshot - The current drive state
   * @returns ProcessInputResult with categorized input, fingerprint, and candidates
   * @throws Error if action retrieval or episodic memory queries fail
   */
  async processInput(
    input: CategorizedInput,
    driveSnapshot: DriveSnapshot,
  ): Promise<ProcessInputResult> {
    // Step 1: Categorize the input
    const inputCategory = categorizeInput(input);
    this.logger.debug(`Categorized input: ${inputCategory}`);

    // Step 2: Compute dominant drive
    const dominantDrive = computeDominantDrive(driveSnapshot);
    this.logger.debug(`Dominant drive: ${dominantDrive}`);

    // Step 3: Generate context fingerprint
    const contextFingerprint = generateContextFingerprint(
      input.entities,
      inputCategory,
      dominantDrive,
    );
    this.logger.debug(`Generated context fingerprint: ${contextFingerprint}`);

    // Step 4: Query episodic memory for similar contexts
    // This provides background context for the action retriever
    const recentEpisodes = this.episodicMemoryService.queryByContext(
      contextFingerprint,
      DEFAULT_RECENT_EPISODES_FOR_CONTEXT,
    );
    this.logger.debug(`Found ${recentEpisodes.length} similar prior episodes`);

    // Step 5: Retrieve action candidates from the WKG
    // The retriever uses the context fingerprint to find similar procedures
    let candidates: ActionCandidate[] = [];
    try {
      candidates = await this.actionRetrieverService.retrieve(
        contextFingerprint,
        driveSnapshot,
      );
      this.logger.debug(`Retrieved ${candidates.length} action candidates from WKG`);
    } catch (err) {
      this.logger.error(`Failed to retrieve action candidates: ${err}`, err);
      // If retrieval fails, proceed with empty candidates.
      // The system will fall back to Type 2 LLM deliberation.
      candidates = [];
    }

    // Step 6: Rank candidates: Type 1 first (procedureData != null), then Type 2
    // Both ranked by confidence descending within their type
    const ranked = rankCandidates(candidates);

    // Step 7: Cap at Cowan's working memory limit (5 candidates)
    const cappedCandidates = ranked.slice(0, INNER_MONOLOGUE_CAPACITY);

    // Get count of recent episodes for context in result
    const recentEpisodeCount = this.episodicMemoryService.getEpisodeCount();

    // Build and return result
    const result: ProcessInputResult = {
      inputCategory,
      contextFingerprint,
      candidates: cappedCandidates,
      predictionContext: {
        entities: Array.from(input.entities),
        recentEpisodeCount,
        dominantDrive,
      },
    };

    return result;
  }
}

// ---------------------------------------------------------------------------
// Ranking Helper
// ---------------------------------------------------------------------------

/**
 * Rank candidates: Type 1 (with procedure nodes) first, then Type 2.
 * Within each group, sort by confidence descending.
 *
 * CANON §Confidence Dynamics: Type 1 candidates have procedureData and
 * stored confidence. Type 2 candidates have null procedureData.
 *
 * @param candidates - Unsorted action candidates
 * @returns Sorted candidates with Type 1 first, then Type 2
 */
function rankCandidates(candidates: ActionCandidate[]): ActionCandidate[] {
  const type1 = candidates.filter((c) => c.procedureData !== null).sort((a, b) => b.confidence - a.confidence);
  const type2 = candidates.filter((c) => c.procedureData === null).sort((a, b) => b.confidence - a.confidence);

  return [...type1, ...type2];
}
