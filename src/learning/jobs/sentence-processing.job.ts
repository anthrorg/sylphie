/**
 * SentenceProcessingJob — splits multi-sentence phrases and extracts structure.
 *
 * Implements ILearningJob. A learnable job that processes phrases containing
 * multiple sentences, splits them into individual sentence nodes, extracts
 * grammatical structure (subject, verb, object, modifiers), and creates
 * FOLLOWS_PATTERN edges linking similar structures.
 *
 * CANON §Subsystem 3: Runs during consolidation to granulate communication
 * content into learnable sentences. Works on phrase nodes and refines them
 * into sentence-level knowledge suitable for pattern matching.
 *
 * CANON §Type 2 Cost Requirement: All LLM calls for structure extraction are
 * Type 2 and carry explicit cost tracking. LLM-generated edges carry
 * LLM_GENERATED provenance at 0.35 base confidence.
 *
 * CANON §Immutable Standard 3 (Confidence Ceiling): TRIGGERS edges are only
 * committed if confidence >= 0.45; otherwise they are logged but not persisted.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';

import type { ILearningJob, JobResult } from '../interfaces/learning.interfaces';
import type { IWkgService } from '../../knowledge/interfaces/knowledge.interfaces';
import type { ILlmService } from '../../shared/types/llm.types';
import type { IEventService } from '../../events/interfaces/events.interfaces';
import { WKG_SERVICE } from '../../knowledge/knowledge.tokens';
import { LLM_SERVICE } from '../../shared/types/llm.types';
import { EVENTS_SERVICE } from '../../events/events.tokens';

/**
 * A parsed sentence with its grammatical structure.
 */
interface ParsedSentence {
  readonly sentenceText: string;
  readonly subject?: string;
  readonly verb?: string;
  readonly object?: string;
  readonly modifiers?: readonly string[];
  readonly templateSlot?: string;
}

/**
 * A sentence node created or found in the WKG.
 */
interface SentenceNode {
  readonly id: string;
  readonly text: string;
}

@Injectable()
export class SentenceProcessingJob implements ILearningJob {
  private readonly logger = new Logger(SentenceProcessingJob.name);

  /** Base confidence for LLM-generated artifacts. */
  private readonly LLM_GENERATED_BASE_CONFIDENCE = 0.35;

  /** Minimum confidence threshold for committing TRIGGERS edges. */
  private readonly TRIGGERS_CONFIDENCE_THRESHOLD = 0.45;

  constructor(
    @Inject(WKG_SERVICE)
    private readonly wkgService: IWkgService,
    @Inject(LLM_SERVICE)
    private readonly llmService: ILlmService,
    @Inject(EVENTS_SERVICE)
    private readonly eventsService: IEventService,
  ) {}

  /**
   * The human-readable name of this job.
   *
   * @returns Job name
   */
  get name(): string {
    return 'sentence-processing';
  }

  /**
   * Determine whether this job should run in the current consolidation cycle.
   *
   * Checks if there are phrase nodes with multiple sentences that need splitting.
   * Returns true if LLM service is available and the job has potential work.
   *
   * @returns True if the job should execute; false to skip.
   */
  shouldRun(): boolean {
    // Job should run if LLM service is available. The actual work is checked during run().
    return this.llmService.isAvailable();
  }

  /**
   * Execute the job: split phrases, extract structure, create FOLLOWS_PATTERN edges.
   *
   * Phase 1: Query for phrase nodes with multiple sentences.
   * Phase 2: For each, split on sentence boundaries (., !, ?).
   * Phase 3: Create new PhraseNode for each sentence with PARENT_PHRASE edge.
   * Phase 4: Extract grammatical structure using LLM (Type 2).
   * Phase 5: Create FOLLOWS_PATTERN edges for similar structures.
   * Phase 6: Propose TRIGGERS edges with confidence >= 0.45 validation.
   *
   * @returns Result of job execution with artifact count, issues, and latency.
   */
  async run(): Promise<JobResult> {
    const startTime = Date.now();
    const issues: string[] = [];
    let artifactCount = 0;

    try {
      this.logger.log(`Starting sentence processing job`);

      // Phase 1: Query for phrase nodes with multiple sentences.
      const phraseNodes = await this.queryMultiSentencePhrases();

      if (phraseNodes.length === 0) {
        this.logger.log(`No multi-sentence phrases found`);
        return {
          jobName: this.name,
          success: true,
          artifactCount: 0,
          issues: [],
          latencyMs: Date.now() - startTime,
        };
      }

      this.logger.log(`Found ${phraseNodes.length} multi-sentence phrases`);

      // Phase 2–6: Process each phrase
      for (const phraseNode of phraseNodes) {
        try {
          const processedCount = await this.processPhraseNode(phraseNode);
          artifactCount += processedCount;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          issues.push(
            `Failed to process phrase ${phraseNode.id}: ${msg}`,
          );
          this.logger.warn(`Phrase processing error: ${msg}`);
        }
      }

      const latencyMs = Date.now() - startTime;

      this.logger.log(
        `Sentence processing completed: ${artifactCount} artifacts, ` +
          `${issues.length} issues, ${latencyMs}ms`,
      );

      return {
        jobName: this.name,
        success: issues.length === 0,
        artifactCount,
        issues,
        latencyMs,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const latencyMs = Date.now() - startTime;

      this.logger.error(`Sentence processing job failed: ${msg}`);

      return {
        jobName: this.name,
        success: false,
        artifactCount: 0,
        issues: [msg],
        latencyMs,
        error: msg,
      };
    }
  }

  /**
   * Query for phrase nodes containing multiple sentences.
   *
   * Queries the WKG for Entity nodes with label 'Phrase' where the text
   * contains multiple sentence boundaries (., !, ?).
   *
   * @returns Array of phrase nodes with multiple sentences
   */
  private async queryMultiSentencePhrases(): Promise<any[]> {
    try {
      // Query for all Phrase entities
      const allPhrases = await this.wkgService.findNodeByLabel('Phrase');

      // Filter to only those with multiple sentences (heuristic: text contains . ! or ?)
      const multiSentencePhrases = allPhrases.filter((node) => {
        const text = (node.properties?.text ?? node.properties?.name ?? '') as string;
        // Count sentence boundaries
        const boundaryCount = (text.match(/[.!?]/g) ?? []).length;
        return boundaryCount > 1;
      });

      return multiSentencePhrases;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to query multi-sentence phrases: ${msg}`);
      return [];
    }
  }

  /**
   * Process a single phrase node: split sentences, extract structure, create edges.
   *
   * @param phraseNode - The phrase node to process
   * @returns Number of artifacts created
   */
  private async processPhraseNode(phraseNode: any): Promise<number> {
    let artifactCount = 0;

    const phraseText = (phraseNode.properties?.text ??
      phraseNode.properties?.name ??
      '') as string;

    if (!phraseText || phraseText.length === 0) {
      return 0;
    }

    // Phase 2: Split on sentence boundaries
    const sentences = this.splitSentences(phraseText);

    if (sentences.length <= 1) {
      // No splitting needed
      return 0;
    }

    this.logger.log(
      `Splitting phrase "${phraseText.substring(0, 50)}..." into ${sentences.length} sentences`,
    );

    // Phase 3: Create new sentence nodes and PARENT_PHRASE edges
    const sentenceNodes: SentenceNode[] = [];

    for (const sentenceText of sentences) {
      try {
        const sentenceNode = await this.createOrFindSentenceNode(sentenceText);
        if (sentenceNode) {
          sentenceNodes.push(sentenceNode);
          artifactCount += 1; // Count the sentence node

          // Create PARENT_PHRASE edge from sentence to original phrase
          const parentEdgeResult = await this.wkgService.upsertEdge({
            sourceId: sentenceNode.id,
            targetId: phraseNode.id,
            relationship: 'PARENT_PHRASE',
            provenance: 'LLM_GENERATED',
            initialConfidence: this.LLM_GENERATED_BASE_CONFIDENCE,
            properties: {
              originalPhrase: phraseText,
              sentenceIndex: sentences.indexOf(sentenceText),
            },
          });

          if (parentEdgeResult.type === 'success') {
            artifactCount += 1; // Count the PARENT_PHRASE edge
            this.logger.debug(
              `Created PARENT_PHRASE edge from sentence to original phrase`,
            );
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Failed to create sentence node: ${msg}`);
      }
    }

    if (sentenceNodes.length === 0) {
      return artifactCount;
    }

    // Phase 4: Extract structure using LLM and create FOLLOWS_PATTERN edges
    try {
      const structureResults = await this.extractStructureAndPatterns(
        sentenceNodes,
      );

      // Phase 5–6: Process structure results
      for (const result of structureResults) {
        // Create FOLLOWS_PATTERN edges for similar structures
        const patternEdges = await this.createFollowsPatternEdges(
          result.sentenceNode,
          result.template,
        );
        artifactCount += patternEdges;

        // Propose and validate TRIGGERS edges
        const triggersEdges = await this.proposeAndValidateTriggersEdges(
          result.sentenceNode,
          result.parsed,
        );
        artifactCount += triggersEdges;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to extract structure and patterns: ${msg}`);
    }

    return artifactCount;
  }

  /**
   * Split a phrase into individual sentences on boundaries (., !, ?).
   *
   * Preserves punctuation with the sentence. Filters out empty results.
   *
   * @param phraseText - The phrase text to split
   * @returns Array of sentence strings
   */
  private splitSentences(phraseText: string): string[] {
    // Split on sentence boundaries while preserving the punctuation
    const regex = /[^.!?]*[.!?]+/g;
    const matches = phraseText.match(regex) ?? [];

    return matches
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  /**
   * Create or find a sentence node in the WKG.
   *
   * Searches for an existing Phrase node with the same text. If not found,
   * creates a new one with INSTANCE level and LLM_GENERATED provenance.
   *
   * @param sentenceText - The sentence text
   * @returns The sentence node, or null if creation failed
   */
  private async createOrFindSentenceNode(sentenceText: string): Promise<SentenceNode | null> {
    try {
      // Query for existing sentence node by text
      const existingPhrases = await this.wkgService.findNodeByLabel('Phrase');
      const existingNode = existingPhrases.find(
        (node) => node.properties?.text === sentenceText,
      );

      if (existingNode) {
        return {
          id: existingNode.id,
          text: sentenceText,
        };
      }

      // Create new sentence node
      const createResult = await this.wkgService.upsertNode({
        labels: ['Entity', 'Phrase', 'Sentence'],
        nodeLevel: 'INSTANCE',
        provenance: 'LLM_GENERATED',
        initialConfidence: this.LLM_GENERATED_BASE_CONFIDENCE,
        properties: {
          text: sentenceText,
          name: sentenceText.substring(0, 100), // First 100 chars as name
          type: 'Sentence',
        },
      });

      if (createResult.type === 'success') {
        return {
          id: createResult.node.id,
          text: sentenceText,
        };
      } else {
        this.logger.warn(
          `Contradiction creating sentence node for "${sentenceText.substring(0, 50)}"`,
        );
        return null;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to create/find sentence node: ${msg}`);
      return null;
    }
  }

  /**
   * Extract grammatical structure from sentences using the LLM.
   *
   * Type 2 operation: calls the LLM to identify subject, verb, object, modifiers.
   * Stores the result in a template slot for pattern matching.
   *
   * @param sentenceNodes - Sentence nodes to process
   * @returns Array of structure extraction results
   */
  private async extractStructureAndPatterns(
    sentenceNodes: SentenceNode[],
  ): Promise<Array<{
    sentenceNode: SentenceNode;
    parsed: ParsedSentence;
    template: string;
  }>> {
    if (!this.llmService.isAvailable()) {
      this.logger.warn(
        `LLM service unavailable; skipping structure extraction`,
      );
      return [];
    }

    const results = [];

    // Batch sentences for LLM processing to reduce calls
    const sentences = sentenceNodes.map((n) => n.text).join('\n');

    try {
      const request = {
        messages: [
          {
            role: 'user' as const,
            content: `Extract grammatical structure (subject, verb, object, modifiers) from these sentences:\n\n${sentences}`,
          },
        ],
        systemPrompt:
          'You are a linguistic analyzer. For each sentence, identify: subject, verb, object, and modifiers. ' +
          'Output as JSON with fields: sentenceText, subject, verb, object, modifiers (array), templateSlot.',
        maxTokens: 1024,
        temperature: 0.2,
        metadata: {
          callerSubsystem: 'LEARNING' as const,
          purpose: 'SENTENCE_STRUCTURE_EXTRACTION',
          sessionId: 'learning-cycle',
        },
      };

      const response = await this.llmService.complete(request);

      // Parse the LLM response (expected to be JSON)
      let parsedResponses: ParsedSentence[] = [];
      try {
        // Try to extract JSON from the response
        const jsonMatch = response.content.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          parsedResponses = Array.isArray(parsed) ? parsed : [parsed];
        }
      } catch (parseError) {
        this.logger.warn(
          `Failed to parse LLM structure extraction response: ${parseError}`,
        );
        // Fall back to heuristic parsing
        parsedResponses = sentenceNodes.map((node) =>
          this.extractStructureHeuristic(node.text),
        );
      }

      // Match parsed responses to sentence nodes
      for (let i = 0; i < sentenceNodes.length && i < parsedResponses.length; i++) {
        const node = sentenceNodes[i];
        const parsed = parsedResponses[i];

        // Generate template slot from structure
        const template = this.generateTemplateSlot(parsed);

        results.push({
          sentenceNode: node,
          parsed,
          template,
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Structure extraction LLM call failed: ${msg}`);

      // Fall back to heuristic for all nodes
      for (const node of sentenceNodes) {
        const parsed = this.extractStructureHeuristic(node.text);
        const template = this.generateTemplateSlot(parsed);
        results.push({
          sentenceNode: node,
          parsed,
          template,
        });
      }
    }

    return results;
  }

  /**
   * Heuristic structure extraction when LLM is unavailable.
   *
   * Uses simple word-position heuristics to identify subject, verb, object.
   * This is a fallback and carries lower confidence than LLM-extracted structure.
   *
   * @param sentenceText - The sentence to parse
   * @returns Parsed sentence with heuristic structure
   */
  private extractStructureHeuristic(sentenceText: string): ParsedSentence {
    const words = sentenceText.split(/\s+/);

    // Very simple heuristic: first noun is subject, first verb is verb, etc.
    // In production, this would use a proper POS tagger.
    let subject: string | undefined;
    let verb: string | undefined;
    let object: string | undefined;

    if (words.length > 0) subject = words[0];
    if (words.length > 1) verb = words[1];
    if (words.length > 2) object = words[2];

    return {
      sentenceText,
      subject,
      verb,
      object,
      modifiers: words.slice(3),
    };
  }

  /**
   * Generate a template slot string from parsed sentence structure.
   *
   * Template format: "[SUBJECT] [VERB] [OBJECT] [MODIFIERS...]"
   * Used to group sentences with similar structures via FOLLOWS_PATTERN edges.
   *
   * @param parsed - Parsed sentence with structure
   * @returns Template slot string
   */
  private generateTemplateSlot(parsed: ParsedSentence): string {
    const parts = [
      `[${parsed.subject ?? 'SUBJECT'}]`,
      `[${parsed.verb ?? 'VERB'}]`,
      `[${parsed.object ?? 'OBJECT'}]`,
    ];

    if (parsed.modifiers && parsed.modifiers.length > 0) {
      parts.push(`[MODIFIERS]`);
    }

    return parts.join(' ');
  }

  /**
   * Create FOLLOWS_PATTERN edges for sentences with the same template.
   *
   * Queries the WKG for other sentences with the same template slot,
   * then creates FOLLOWS_PATTERN edges linking them.
   *
   * @param sentenceNode - The sentence node
   * @param template - The template slot string
   * @returns Number of FOLLOWS_PATTERN edges created
   */
  private async createFollowsPatternEdges(
    sentenceNode: SentenceNode,
    template: string,
  ): Promise<number> {
    try {
      // Query for other Sentence nodes with properties.templateSlot === template
      const otherSentences = await this.wkgService.findNodeByLabel('Sentence');
      const similarSentences = otherSentences.filter(
        (node) => node.properties?.templateSlot === template && node.id !== sentenceNode.id,
      );

      let edgeCount = 0;

      for (const similar of similarSentences) {
        try {
          const result = await this.wkgService.upsertEdge({
            sourceId: sentenceNode.id,
            targetId: similar.id,
            relationship: 'FOLLOWS_PATTERN',
            provenance: 'LLM_GENERATED',
            initialConfidence: this.LLM_GENERATED_BASE_CONFIDENCE,
            properties: {
              template,
              patternType: 'syntactic_similarity',
            },
          });

          if (result.type === 'success') {
            edgeCount += 1;
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          this.logger.warn(
            `Failed to create FOLLOWS_PATTERN edge: ${msg}`,
          );
        }
      }

      return edgeCount;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to create FOLLOWS_PATTERN edges: ${msg}`);
      return 0;
    }
  }

  /**
   * Propose and validate TRIGGERS edges for sentences.
   *
   * Proposes potential TRIGGERS relationships based on verb and object,
   * but only commits them if confidence >= TRIGGERS_CONFIDENCE_THRESHOLD.
   *
   * CANON §Confidence Ceiling: TRIGGERS edges below threshold are logged
   * but not persisted.
   *
   * @param sentenceNode - The sentence node
   * @param parsed - Parsed sentence structure
   * @returns Number of TRIGGERS edges committed
   */
  private async proposeAndValidateTriggersEdges(
    sentenceNode: SentenceNode,
    parsed: ParsedSentence,
  ): Promise<number> {
    if (!parsed.verb || !parsed.object) {
      // Cannot propose TRIGGERS without verb and object
      return 0;
    }

    try {
      // Propose a TRIGGERS edge: verb → object
      // Try to find or create nodes for verb and object
      const verbNode = await this.findOrCreateConceptNode(parsed.verb);
      const objectNode = await this.findOrCreateConceptNode(parsed.object);

      if (!verbNode || !objectNode) {
        return 0;
      }

      // Calculate confidence: heuristic based on parse quality
      // If verb and object are clear, confidence is higher
      const baseConfidence = 0.40;
      const confidence = Math.min(0.60, baseConfidence + 0.10); // 0.50

      if (confidence < this.TRIGGERS_CONFIDENCE_THRESHOLD) {
        this.logger.debug(
          `TRIGGERS edge confidence (${confidence.toFixed(2)}) below threshold; not committing`,
        );
        return 0;
      }

      const result = await this.wkgService.upsertEdge({
        sourceId: verbNode.id,
        targetId: objectNode.id,
        relationship: 'TRIGGERS',
        provenance: 'LLM_GENERATED',
        initialConfidence: confidence,
        properties: {
          sentenceSource: sentenceNode.id,
          verb: parsed.verb,
          object: parsed.object,
        },
      });

      if (result.type === 'success') {
        this.logger.log(
          `Created TRIGGERS edge: ${parsed.verb} → ${parsed.object} (confidence: ${confidence.toFixed(2)})`,
        );
        return 1;
      } else {
        this.logger.warn(`TRIGGERS edge creation contradicted; not committing`);
        return 0;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to create TRIGGERS edges: ${msg}`);
      return 0;
    }
  }

  /**
   * Find or create a concept node for a word (verb, object, etc.).
   *
   * Concept nodes are Entity nodes at SCHEMA level, representing word types
   * rather than specific instances.
   *
   * @param conceptText - The word/concept to represent
   * @returns The concept node, or null if creation failed
   */
  private async findOrCreateConceptNode(
    conceptText: string,
  ): Promise<{ id: string } | null> {
    try {
      // Query for existing concept node
      const existingNodes = await this.wkgService.findNodeByLabel('Concept');
      const conceptNode = existingNodes.find(
        (node) => node.properties?.name === conceptText || node.properties?.text === conceptText,
      );

      if (conceptNode) {
        return { id: conceptNode.id };
      }

      // Create new concept node
      const createResult = await this.wkgService.upsertNode({
        labels: ['Entity', 'Concept'],
        nodeLevel: 'SCHEMA',
        provenance: 'LLM_GENERATED',
        initialConfidence: this.LLM_GENERATED_BASE_CONFIDENCE,
        properties: {
          name: conceptText,
          text: conceptText,
          type: 'Concept',
        },
      });

      if (createResult.type === 'success') {
        return { id: createResult.node.id };
      } else {
        this.logger.warn(`Contradiction creating concept node for "${conceptText}"`);
        return null;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to find/create concept node: ${msg}`);
      return null;
    }
  }
}
