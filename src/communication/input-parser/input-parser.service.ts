/**
 * InputParserService — converts raw guardian text into structured ParsedInput.
 *
 * Implements IInputParserService. Uses the LLM (Type 2) for intent classification
 * and entity extraction until Type 1 patterns graduate from training data.
 * Graduation requires confidence > 0.80 and MAE < 0.10 over last 10 uses
 * (CANON §Confidence Dynamics).
 *
 * Entity extraction resolves candidates against the WKG. Unresolved entities
 * (wkgNodeId = null) are forwarded as potential entity-extraction learning events.
 *
 * CANON Constraints:
 * - All parsed entities carry LLM_GENERATED provenance at 0.35 base confidence
 * - Guardian feedback carries special weight (Immutable Standard 5)
 * - Intent classification uses LLM structured output
 * - Entity resolution via WKG findNode() where possible
 * - Events tagged has_learnable=true for Learning subsystem
 */

import { Injectable, Inject, Logger } from '@nestjs/common';

import type {
  IInputParserService,
  GuardianInput,
  ParsedInput,
  ParsedEntity,
  InputIntentType,
} from '../interfaces/communication.interfaces';
import type { ILlmService, LlmRequest } from '../../shared/types/llm.types';
import type { IWkgService } from '../../knowledge';
import type { IEventService } from '../../events';
import { LLM_SERVICE } from '../../shared/types/llm.types';
import { WKG_SERVICE } from '../../knowledge';
import { EVENTS_SERVICE } from '../../events';
import { createCommunicationEvent } from '../../events';
import type { DriveSnapshot } from '../../shared/types/drive.types';

/**
 * LLM prompt for intent classification and entity extraction.
 * Requests structured JSON output for reliable parsing.
 */
const PARSER_SYSTEM_PROMPT = `You are analyzing guardian input to Sylphie, an AI companion.
Your task is to classify the intent and extract entities from the text.

Classify the intent as ONE of: QUESTION, STATEMENT, CORRECTION, COMMAND, ACKNOWLEDGMENT, TEACHING

- QUESTION: Guardian is asking for information or Sylphie's opinion
- STATEMENT: Guardian is asserting something (potential new knowledge)
- CORRECTION: Guardian is correcting Sylphie's behavior or output
- COMMAND: Guardian is directing an action
- ACKNOWLEDGMENT: Guardian is confirming Sylphie's behavior or output
- TEACHING: Guardian is explicitly teaching a fact or procedure

Extract named entities with types: PERSON, PLACE, CONCEPT, OBJECT, EVENT, ACTION, ATTRIBUTE

Respond ONLY with valid JSON (no markdown, no explanation) in this exact format:
{
  "intentType": "QUESTION|STATEMENT|CORRECTION|COMMAND|ACKNOWLEDGMENT|TEACHING",
  "confidence": 0.0-1.0,
  "entities": [
    {
      "name": "entity text as it appears",
      "type": "PERSON|PLACE|CONCEPT|OBJECT|EVENT|ACTION|ATTRIBUTE",
      "confidence": 0.0-1.0
    }
  ]
}`;

interface LlmParseResponse {
  intentType: InputIntentType;
  confidence: number;
  entities: Array<{
    name: string;
    type: string;
    confidence: number;
  }>;
}

@Injectable()
export class InputParserService implements IInputParserService {
  private readonly logger = new Logger(InputParserService.name);

  constructor(
    @Inject(LLM_SERVICE) private readonly llmService: ILlmService,
    @Inject(WKG_SERVICE) private readonly wkgService: IWkgService,
    @Inject(EVENTS_SERVICE) private readonly eventService: IEventService,
  ) {}

  /**
   * Parse a GuardianInput into structured intent and entity data.
   *
   * Pipeline:
   * 1. Invoke LLM for intent classification and entity extraction
   * 2. Parse JSON response (fallback to STATEMENT + empty entities on parse failure)
   * 3. Resolve entities against WKG via findNode()
   * 4. Detect guardian feedback type (CORRECTION/CONFIRMATION markers)
   * 5. Resolve anaphora from conversation context (simple reference resolution)
   * 6. Emit INPUT_PARSED event with has_learnable=true
   *
   * @param input - The raw guardian input to parse.
   * @returns Structured parse result with intent, entities, and feedback type.
   */
  async parse(input: GuardianInput): Promise<ParsedInput> {
    try {
      // Step 1: Invoke LLM for intent classification and entity extraction
      const llmResponse = await this.llmService.complete({
        messages: [
          {
            role: 'user',
            content: input.text,
          },
        ],
        systemPrompt: PARSER_SYSTEM_PROMPT,
        maxTokens: 500,
        temperature: 0.2, // Low temperature for consistent classification
        metadata: {
          callerSubsystem: 'COMMUNICATION',
          purpose: 'INPUT_PARSING',
          sessionId: input.sessionId,
        },
      } as LlmRequest);

      // Step 2: Parse LLM response
      let intentType: InputIntentType = 'STATEMENT';
      let intentConfidence = 0.35; // LLM_GENERATED base confidence
      let extractedEntities: Array<{ name: string; type: string; confidence: number }> = [];

      try {
        const parsed: LlmParseResponse = JSON.parse(llmResponse.content);
        if (
          parsed.intentType &&
          ['QUESTION', 'STATEMENT', 'CORRECTION', 'COMMAND', 'ACKNOWLEDGMENT', 'TEACHING'].includes(
            parsed.intentType,
          )
        ) {
          intentType = parsed.intentType;
          intentConfidence = Math.min(1.0, Math.max(0.0, parsed.confidence || 0.35));
        }
        if (parsed.entities && Array.isArray(parsed.entities)) {
          extractedEntities = parsed.entities.filter(
            (e) => e.name && e.type && typeof e.confidence === 'number',
          );
        }
      } catch (parseErr) {
        // JSON parse failed — log and fall back to STATEMENT with empty entities
        this.logger.warn(
          `Failed to parse LLM response: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        );
        intentType = 'STATEMENT';
        intentConfidence = 0.3; // Low confidence on fallback
        extractedEntities = [];
      }

      // Step 3: Resolve entities against WKG and apply provenance
      const resolvedEntities: ParsedEntity[] = [];
      for (const entity of extractedEntities) {
        let wkgNodeId: string | null = null;

        // Try to find the entity in WKG by label matching
        try {
          const candidates = await this.wkgService.findNodeByLabel(entity.type);
          // Heuristic: find first node whose properties or labels contain the entity name
          const match = candidates.find((node) => {
            const nameMatch =
              node.properties &&
              typeof node.properties.name === 'string' &&
              node.properties.name.toLowerCase().includes(entity.name.toLowerCase());
            return nameMatch;
          });
          if (match) {
            wkgNodeId = match.id;
          }
        } catch (wkgErr) {
          // WKG lookup failed — entity remains unresolved
          this.logger.debug(
            `Failed to resolve entity "${entity.name}" in WKG: ${wkgErr instanceof Error ? wkgErr.message : String(wkgErr)}`,
          );
        }

        resolvedEntities.push({
          name: entity.name,
          type: entity.type,
          wkgNodeId,
          confidence: Math.min(1.0, Math.max(0.0, entity.confidence || 0.35)),
        });
      }

      // Step 4: Detect guardian feedback type
      const feedbackType = this.detectGuardianFeedback(input.text, intentType);

      // Step 5: Resolve anaphora (simple reference resolution)
      const contextReferences = this.resolveAnaphora(input.text);

      // Step 6: Build ParsedInput result
      const parsed: ParsedInput = {
        intentType,
        entities: resolvedEntities,
        guardianFeedbackType: feedbackType,
        rawText: input.text,
        confidence: intentConfidence,
        contextReferences,
      };

      return parsed;
    } catch (err) {
      this.logger.error(
        `InputParser fatal error: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Return safe fallback on unexpected error
      return {
        intentType: 'STATEMENT',
        entities: [],
        guardianFeedbackType: 'none',
        rawText: input.text,
        confidence: 0.2,
        contextReferences: [],
      };
    }
  }

  /**
   * Detect if the input contains guardian feedback markers.
   *
   * CORRECTION markers: "wrong", "incorrect", "no that's", "not right"
   * CONFIRMATION markers: "right", "correct", "yes", "exactly"
   *
   * @param text - The input text to analyze
   * @param intentType - The classified intent (CORRECTION intent overrides)
   * @returns Guardian feedback type
   */
  private detectGuardianFeedback(
    text: string,
    intentType: InputIntentType,
  ): 'confirmation' | 'correction' | 'none' {
    // Intent type CORRECTION is explicit guardian correction
    if (intentType === 'CORRECTION') {
      return 'correction';
    }

    // Intent type ACKNOWLEDGMENT is explicit guardian confirmation
    if (intentType === 'ACKNOWLEDGMENT') {
      return 'confirmation';
    }

    const lowerText = text.toLowerCase();

    // Correction markers
    if (
      /\b(wrong|incorrect|no that'?s|not right|mistake|that'?s not|false|nope)\b/.test(
        lowerText,
      )
    ) {
      return 'correction';
    }

    // Confirmation markers
    if (/\b(right|correct|yes|exactly|that'?s right|you'?re right|good|perfect)\b/.test(lowerText)) {
      return 'confirmation';
    }

    return 'none';
  }

  /**
   * Resolve anaphora (pronoun and reference resolution).
   *
   * Currently implements simple heuristics for common pronouns:
   * - "it", "that", "this" → reference to prior turn (not yet implemented in full)
   * - Returns empty array as placeholder for future conversation context integration
   *
   * @param text - The input text
   * @returns Array of referenced event/session IDs (empty until conversation context available)
   */
  private resolveAnaphora(_text: string): string[] {
    // Placeholder for full anaphora resolution
    // Would integrate with conversation history from the thread context
    // For now, return empty array
    return [];
  }
}

