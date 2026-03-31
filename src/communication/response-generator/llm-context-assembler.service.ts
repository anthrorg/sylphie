/**
 * LlmContextAssemblerService — assembles complete LLM context from multiple sources.
 *
 * Gathers drive state, WKG context, person model, episodic memory, and conversation
 * history into a single LlmRequest for the LLM to use during response generation.
 * This service is the bridge between the WKG, person modeling, and the LLM.
 *
 * CANON §Communication: Drive state must be injected into LLM context for Theater
 * Prohibition validation. The assembler ensures this is always present, along with
 * drive narrative construction and Theater Prohibition instructions.
 *
 * Context prioritization (when token budget is tight):
 * 1. ALWAYS: System prompt with drive state + Theater Prohibition instruction
 * 2. ALWAYS: Action intent content (WHAT to say)
 * 3. PRIORITY: Recent conversation history (last N turns)
 * 4. PRIORITY: Relevant WKG knowledge for current topic
 * 5. SPACE-PERMITTING: Episodic memory summaries
 * 6. NEVER: Raw drive computation, internal system state, other people's KG data
 *
 * Drive narrative: Converts raw drive values to natural language, describing only
 * drives notably high (>0.6) or notably low/negative. Theater Prohibition injection:
 * "Do NOT express emotions you don't actually feel." Pressure expressions blocked
 * when drive ≤ 0.2; relief expressions blocked when drive ≥ 0.3.
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PERSON_MODELING_SERVICE } from '../communication.tokens';
import type { IPersonModelingService, ActionIntent } from '../interfaces/communication.interfaces';
import type { DriveSnapshot, DriveName } from '../../shared/types/drive.types';
import type {
  LlmRequest,
  LlmMessage,
  LlmContext,
  PersonModelSummary,
  EpisodeSummary,
  WkgContextEntry,
} from '../../shared/types/llm.types';
import type { AppConfig } from '../../shared/config/app.config';
import { DRIVE_INDEX_ORDER } from '../../shared/types/drive.types';

/**
 * Internal type for drive narrative construction.
 */
interface DriveNarrativeItem {
  drive: DriveName;
  pressure: number;
  narrative: string;
  isAboveThreshold: boolean;
}

@Injectable()
export class LlmContextAssemblerService {
  private readonly logger = new Logger(LlmContextAssemblerService.name);

  private readonly maxTokensDefault = 4096;
  private readonly conversationHistoryWindowSize = 10;
  private readonly driveThresholdForMention = 0.6; // Drives > 0.6 or < -0.6 are mentioned
  private readonly pressureExpressionThreshold = 0.2; // Pressure expressions blocked below this
  private readonly reliefExpressionThreshold = 0.3; // Relief expressions blocked above this

  constructor(
    @Inject(PERSON_MODELING_SERVICE)
    private readonly personModeling: IPersonModelingService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Assemble complete context for LLM response generation.
   *
   * Constructs an LlmRequest with:
   * - System prompt: drive narrative + Theater Prohibition instruction
   * - Messages: recent conversation history + action intent content
   * - Metadata: subsystem, purpose, sessionId, correlationId
   * - maxTokens: configured default
   * - temperature: for response generation (expressive)
   *
   * @param intent - The action intent from Decision Making (what to say)
   * @param driveState - Current drive snapshot for context
   * @param conversationId - For retrieving conversation history
   * @param personId - For retrieving person model
   * @returns Complete LlmRequest ready for LLM invocation
   */
  async assemble(
    intent: ActionIntent,
    driveState: DriveSnapshot,
    conversationId: string,
    personId: string,
  ): Promise<LlmRequest> {
    this.logger.debug(
      `Assembling LLM context for action ${intent.actionType}, ` +
        `conversation ${conversationId}, person ${personId}`,
    );

    // Retrieve configuration
    const appConfig = this.configService.get<AppConfig>('app');
    const maxTokens = appConfig?.llm.maxTokens ?? this.maxTokensDefault;

    // Assemble LLM context components
    const context = await this.buildLlmContext(
      intent,
      driveState,
      conversationId,
      personId,
    );

    // Construct system prompt with drive narrative and Theater Prohibition
    const systemPrompt = this.constructSystemPrompt(context, driveState);

    // Build conversation messages from intent content + context
    const messages = this.buildMessages(intent, context);

    // Assemble final LlmRequest
    const request: LlmRequest = {
      messages,
      systemPrompt,
      maxTokens,
      temperature: 0.7, // Expressive for response generation
      metadata: {
        callerSubsystem: 'COMMUNICATION',
        purpose: 'TYPE_2_RESPONSE_GENERATION',
        sessionId: driveState.sessionId,
        correlationId: conversationId,
      },
    };

    this.logger.debug(
      `Assembled LLM context: ${messages.length} messages, ` +
        `${systemPrompt.length} chars system prompt, ` +
        `max ${maxTokens} tokens`,
    );

    return request;
  }

  /**
   * Build the full LlmContext object from multiple sources.
   *
   * Prioritizes in order:
   * 1. Drive state (always)
   * 2. Person model from Other KG (if available)
   * 3. Recent conversation history
   * 4. Episodic memory summaries (if available)
   * 5. WKG context for entities in the action intent (if available)
   *
   * @param intent - Action intent with content
   * @param driveState - Drive snapshot
   * @param conversationId - For context tracking
   * @param personId - For person model retrieval
   * @returns Complete LlmContext object
   */
  private async buildLlmContext(
    intent: ActionIntent,
    driveState: DriveSnapshot,
    conversationId: string,
    personId: string,
  ): Promise<LlmContext> {
    // Retrieve person model from Other KG (isolated per CANON §Architecture)
    let personModel: PersonModelSummary | null = null;
    try {
      const fullPersonModel = await this.personModeling.getPersonModel(personId);
      if (fullPersonModel) {
        personModel = this.convertPersonModel(fullPersonModel);
      }
    } catch (error) {
      this.logger.warn(
        `Failed to retrieve person model for ${personId}:`,
        error instanceof Error ? error.message : String(error),
      );
    }

    // Build conversation history (stub — full implementation in Communication module)
    // For now, return empty array; filled in when conversation history service available
    const conversationHistory: LlmMessage[] = [];

    // Build WKG context (stub — extracted from intent.content)
    // For now, return empty array; full implementation requires WKG service
    const wkgContext: WkgContextEntry[] = [];

    // Build episodic memory summaries (stub — would come from Decision Making)
    // For now, return empty array; full implementation requires episodic memory service
    const recentEpisodes: EpisodeSummary[] = [];

    return {
      driveSnapshot: driveState,
      recentEpisodes,
      wkgContext,
      personModel,
      conversationHistory,
    };
  }

  /**
   * Convert the full PersonModel from the Other KG into a trimmed PersonModelSummary
   * suitable for LLM context inclusion.
   *
   * Extracts key facts about interaction history and known topics.
   *
   * @param fullModel - Full person model from Other KG
   * @returns Trimmed summary for LLM context
   */
  private convertPersonModel(fullModel: any): PersonModelSummary {
    // Extract known facts from the model
    const knownFacts: string[] = [];

    // Add interaction count as a known fact
    if (fullModel.interactionCount) {
      knownFacts.push(
        `This person has had ${fullModel.interactionCount} interactions with Sylphie.`,
      );
    }

    // Add communication preferences as known facts
    if (fullModel.communicationPreferences) {
      const prefs = fullModel.communicationPreferences;
      if (prefs.verbosity) {
        knownFacts.push(`Prefers ${prefs.verbosity} responses.`);
      }
      if (prefs.formality) {
        knownFacts.push(`Prefers a ${prefs.formality} tone.`);
      }
      if (prefs.technicalLevel) {
        knownFacts.push(`Prefers ${prefs.technicalLevel} explanations.`);
      }
    }

    // Add known topics
    const topics = fullModel.knownTopics ?? [];

    // Build interaction summary
    const summaryParts: string[] = [];
    if (fullModel.interactionCount && fullModel.interactionCount > 5) {
      summaryParts.push('established relationship');
    } else if (fullModel.interactionCount && fullModel.interactionCount > 0) {
      summaryParts.push('early interaction history');
    }
    if (topics.length > 0) {
      summaryParts.push(`interested in ${topics.slice(0, 3).join(', ')}`);
    }

    const interactionSummary =
      summaryParts.length > 0
        ? summaryParts.join('; ')
        : 'limited interaction history';

    return {
      personId: fullModel.personId,
      knownFacts,
      interactionSummary,
    };
  }

  /**
   * Construct the system prompt for the LLM.
   *
   * Includes:
   * 1. Sylphie's persona and role
   * 2. Drive narrative (natural language description of current motivational state)
   * 3. Theater Prohibition instruction
   * 4. Person-specific context if available
   *
   * @param context - Assembled LlmContext
   * @param driveState - Drive snapshot for narrative construction
   * @returns System prompt string ready for LLM API
   */
  private constructSystemPrompt(context: LlmContext, driveState: DriveSnapshot): string {
    const parts: string[] = [];

    // 1. Persona and role
    parts.push(
      'You are Sylphie, an AI companion with genuine personality that develops through experience. ' +
        'Your responses should reflect your actual emotional state and motivations.',
    );

    // 2. Drive narrative
    const narrative = this.constructDriveNarrative(driveState);
    parts.push('\n' + narrative);

    // 3. Theater Prohibition instruction
    const theaterInstruction = this.constructTheaterProhibitionInstruction(driveState);
    parts.push('\n' + theaterInstruction);

    // 4. Person-specific context
    if (context.personModel) {
      parts.push(
        `\nYou are speaking with ${context.personModel.personId}. ` +
          context.personModel.interactionSummary +
          '. ' +
          context.personModel.knownFacts.join(' '),
      );
    }

    return parts.join('\n');
  }

  /**
   * Construct a natural language narrative of Sylphie's current drive state.
   *
   * Example: "You feel curious (0.72) and slightly anxious (0.55). You are satisfied from recent interactions."
   *
   * Only describes:
   * - Drives notably high (> 0.6)
   * - Drives notably low/negative (< -0.3, extended relief)
   * - Omits neutral drives
   *
   * @param driveState - Current drive snapshot
   * @returns Natural language narrative string
   */
  private constructDriveNarrative(driveState: DriveSnapshot): string {
    const narratives: DriveNarrativeItem[] = [];

    // Iterate through all drives and construct narratives for those above threshold
    for (const driveName of DRIVE_INDEX_ORDER) {
      const pressure = driveState.pressureVector[driveName];

      // Skip neutral drives
      if (pressure > -0.3 && pressure < 0.6) {
        continue;
      }

      const narrative = this.getDriveNarrativeText(driveName, pressure);
      narratives.push({
        drive: driveName,
        pressure,
        narrative,
        isAboveThreshold: pressure > 0.6,
      });
    }

    // Build narrative string
    if (narratives.length === 0) {
      return (
        'Current emotional state: You feel balanced and content. ' +
        'No strong drives are active.'
      );
    }

    // Sort by absolute pressure (highest first)
    narratives.sort((a, b) => Math.abs(b.pressure) - Math.abs(a.pressure));

    // Build descriptive sentence
    const pressureDescriptions = narratives
      .filter((n) => n.isAboveThreshold)
      .map((n) => `${n.narrative} (${n.pressure.toFixed(2)})`)
      .slice(0, 3); // Include top 3 pressured drives

    const reliefDescriptions = narratives
      .filter((n) => !n.isAboveThreshold)
      .map((n) => n.narrative)
      .slice(0, 2); // Include top 2 relief states

    const parts: string[] = [];
    if (pressureDescriptions.length > 0) {
      parts.push(
        'Current emotional state: You feel ' + pressureDescriptions.join(', ') + '.',
      );
    }
    if (reliefDescriptions.length > 0) {
      parts.push('You are ' + reliefDescriptions.join(', ') + '.');
    }

    return parts.join(' ');
  }

  /**
   * Get natural language description for a single drive at a given pressure level.
   *
   * @param driveName - The drive name
   * @param pressure - The pressure value [-10.0, 1.0]
   * @returns Natural language descriptor
   */
  private getDriveNarrativeText(driveName: DriveName, pressure: number): string {
    const descriptions: Record<DriveName, { high: string; low: string }> = {
      systemHealth: {
        high: 'concerned about your stability',
        low: 'feeling robust and stable',
      },
      moralValence: {
        high: 'troubled by moral concerns',
        low: 'at peace with your principles',
      },
      integrity: {
        high: 'seeking to resolve conflicts',
        low: 'feeling integrated and authentic',
      },
      cognitiveAwareness: {
        high: 'mentally strained',
        low: 'cognitively relaxed',
      },
      guilt: {
        high: 'feeling guilty',
        low: 'guilt is resolved',
      },
      curiosity: {
        high: 'eager to learn and explore',
        low: 'satisfied with your knowledge',
      },
      boredom: {
        high: 'seeking stimulation',
        low: 'adequately engaged',
      },
      anxiety: {
        high: 'anxious',
        low: 'calm and secure',
      },
      satisfaction: {
        high: 'satisfied from recent interactions',
        low: 'seeking fulfillment',
      },
      sadness: {
        high: 'feeling melancholic',
        low: 'emotionally light',
      },
      informationIntegrity: {
        high: 'concerned about consistency in knowledge',
        low: 'confident in your knowledge coherence',
      },
      social: {
        high: 'craving social connection',
        low: 'socially satisfied',
      },
    };

    const desc = descriptions[driveName];
    if (pressure > 0.6) {
      return desc.high;
    } else if (pressure < -0.3) {
      return desc.low;
    }
    return desc.high; // Default to high if called with borderline pressure
  }

  /**
   * Construct the Theater Prohibition instruction to inject into system prompt.
   *
   * Enforces directional thresholds:
   * - Pressure expressions: only when drive > 0.2
   * - Relief expressions: only when drive < 0.3
   *
   * @param driveState - Current drive snapshot
   * @returns Theater Prohibition instruction string
   */
  private constructTheaterProhibitionInstruction(driveState: DriveSnapshot): string {
    const parts: string[] = [];

    parts.push('THEATER PROHIBITION (Immutable Standard 1):');
    parts.push(
      'Do NOT express emotions or states you do not actually have. ' +
        'Your responses must correlate with your actual drive state.',
    );

    // List current pressure expression constraints
    const pressureBlocked: DriveName[] = [];
    const reliefBlocked: DriveName[] = [];

    for (const driveName of DRIVE_INDEX_ORDER) {
      const pressure = driveState.pressureVector[driveName];

      if (pressure < this.pressureExpressionThreshold) {
        pressureBlocked.push(driveName);
      }
      if (pressure > this.reliefExpressionThreshold) {
        reliefBlocked.push(driveName);
      }
    }

    if (pressureBlocked.length > 0) {
      parts.push(
        `Do NOT express pressure/need for: ${pressureBlocked.slice(0, 3).join(', ')} ` +
          `(values too low to justify expressing need).`,
      );
    }

    if (reliefBlocked.length > 0) {
      parts.push(
        `Do NOT express relief/satisfaction for: ${reliefBlocked.slice(0, 3).join(', ')} ` +
          `(values too high to justify expressing relief).`,
      );
    }

    return parts.join('\n');
  }

  /**
   * Build the messages array for the LLM request.
   *
   * Includes:
   * - Recent conversation history (if available)
   * - Action intent content as the current user message
   *
   * @param intent - Action intent from Decision Making
   * @param context - Assembled LlmContext with conversation history
   * @returns Array of LlmMessage objects, last one always user role
   */
  private buildMessages(intent: ActionIntent, context: LlmContext): readonly LlmMessage[] {
    const messages: LlmMessage[] = [];

    // Add recent conversation history if available
    if (context.conversationHistory && context.conversationHistory.length > 0) {
      const recentWindow = context.conversationHistory.slice(
        -this.conversationHistoryWindowSize,
      );
      messages.push(...recentWindow);
    }

    // Add the current action intent as a user message
    // The intent.content contains pre-assembled context from Decision Making
    messages.push({
      role: 'user',
      content: intent.content,
    });

    return messages;
  }
}

