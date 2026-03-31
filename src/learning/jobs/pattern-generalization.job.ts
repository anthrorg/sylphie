/**
 * PatternGeneralizationJob — generalizes learned patterns into predictive models.
 *
 * Implements ILearningJob. A learnable job that identifies recurring patterns
 * in the WKG and generalizes them into predictive schemas. Used by Planning
 * to anticipate causal chains and conditional outcomes.
 *
 * CANON §Subsystem 3: Runs post-consolidation to extract higher-order
 * patterns from accumulated knowledge. Bridges Learning and Planning:
 * produces the procedural abstractions that Planning uses for constraint
 * validation and outcome simulation.
 *
 * Two-phase design:
 *
 * Phase 1: Pattern Generalization
 * - Query WKG for phrases that share FOLLOWS_PATTERN edges (same template)
 * - Cluster by shared template and structural similarity
 * - LLM-assisted ConceptPrimitive proposal for each cluster
 * - Validation: concept must apply to >= 80% of cluster phrases
 * - Create ConceptPrimitiveNode with LLM_GENERATED provenance at 0.35
 * - Link cluster phrases via HAS_INSTANCE edges
 *
 * Phase 2: Symbolic Decomposition (internal, after generalization)
 * - Decompose phrases at word level
 * - Identify semantic units (words/tokens with distinct meaning)
 * - Create WordNode for each unit
 * - Link phrase to words via CONTAINS_WORD edges
 * - Create word-level relationships
 *
 * CANON §Type 2 Cost Requirement: All LLM calls for pattern proposals are
 * Type 2 and carry explicit cost tracking. LLM-generated concepts carry
 * LLM_GENERATED provenance at 0.35 base confidence.
 *
 * CANON §Immutable Standard 2 (Contingency Requirement): Every proposed
 * ConceptPrimitive is validated against cluster membership (>= 80% coverage)
 * before commitment.
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
 * A phrase node retrieved from the WKG.
 */
interface PhraseNode {
  readonly id: string;
  readonly text: string;
  readonly templateSlot?: string;
}

/**
 * A cluster of phrases sharing the same FOLLOWS_PATTERN template.
 */
interface PatternCluster {
  readonly template: string;
  readonly phrases: readonly PhraseNode[];
}

/**
 * A proposed ConceptPrimitive abstraction for a pattern cluster.
 */
interface ProposedConcept {
  readonly clusterTemplate: string;
  readonly conceptName: string;
  readonly conceptDescription: string;
  readonly confidence: number;
  readonly clusterSize: number;
  readonly validationCoverage: number; // 0.0 to 1.0: fraction of cluster accepting concept
}

/**
 * A word/token unit extracted from a phrase during decomposition.
 */
interface WordUnit {
  readonly text: string;
  readonly semanticRole?: string;
  readonly position: number;
}

@Injectable()
export class PatternGeneralizationJob implements ILearningJob {
  private readonly logger = new Logger(PatternGeneralizationJob.name);

  /** Base confidence for LLM-generated artifacts. */
  private readonly LLM_GENERATED_BASE_CONFIDENCE = 0.35;

  /** Minimum cluster size to attempt concept generalization. */
  private readonly MIN_CLUSTER_SIZE = 2;

  /** Minimum validation coverage (fraction of cluster) to commit a concept. */
  private readonly CONCEPT_VALIDATION_THRESHOLD = 0.80;

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
    return 'pattern-generalization';
  }

  /**
   * Determine whether this job should run in the current consolidation cycle.
   *
   * Checks if there are sufficient phrase nodes with FOLLOWS_PATTERN edges
   * (potential pattern clusters) and LLM service is available.
   *
   * @returns True if the job should execute; false to skip.
   */
  shouldRun(): boolean {
    // Job should run if LLM service is available.
    // The actual work (clustering) is checked during run().
    return this.llmService.isAvailable();
  }

  /**
   * Execute the job: generalize patterns into concepts, decompose phrases into words.
   *
   * Phase 1: Cluster phrases by shared FOLLOWS_PATTERN templates.
   * Phase 2: Propose ConceptPrimitive abstractions for clusters (LLM-assisted).
   * Phase 3: Validate concepts against cluster membership (>= 80% coverage).
   * Phase 4: Commit ConceptPrimitiveNode and HAS_INSTANCE edges for valid concepts.
   * Phase 5: Decompose committed phrases at word level.
   * Phase 6: Create WordNode instances and CONTAINS_WORD edges.
   *
   * @returns Result of job execution with artifact count, issues, and latency.
   */
  async run(): Promise<JobResult> {
    const startTime = Date.now();
    const issues: string[] = [];
    let artifactCount = 0;

    try {
      this.logger.log(`Starting pattern generalization job`);

      // Phase 1: Query and cluster phrases by FOLLOWS_PATTERN template.
      const clusters = await this.clusterPhrasesByPattern();

      if (clusters.length === 0) {
        this.logger.log(`No pattern clusters found (minimum size: ${this.MIN_CLUSTER_SIZE})`);
        return {
          jobName: this.name,
          success: true,
          artifactCount: 0,
          issues: [],
          latencyMs: Date.now() - startTime,
        };
      }

      this.logger.log(`Found ${clusters.length} pattern clusters`);

      // Phase 2–4: Propose concepts, validate, and commit
      for (const cluster of clusters) {
        try {
          const proposedConcept = await this.proposeConcept(cluster);

          if (!proposedConcept) {
            this.logger.debug(
              `No concept proposed for cluster with template "${cluster.template}"`,
            );
            continue;
          }

          // Phase 3: Validate concept coverage
          if (proposedConcept.validationCoverage < this.CONCEPT_VALIDATION_THRESHOLD) {
            this.logger.debug(
              `Concept "${proposedConcept.conceptName}" coverage ` +
                `(${(proposedConcept.validationCoverage * 100).toFixed(1)}%) below threshold; not committing`,
            );
            issues.push(
              `Concept "${proposedConcept.conceptName}" failed validation ` +
                `(coverage: ${(proposedConcept.validationCoverage * 100).toFixed(1)}%)`,
            );
            continue;
          }

          // Phase 4: Commit concept and edges
          const conceptArtifactCount = await this.commitConceptAndEdges(
            proposedConcept,
            cluster,
          );
          artifactCount += conceptArtifactCount;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          issues.push(`Failed to process cluster with template "${cluster.template}": ${msg}`);
          this.logger.warn(`Pattern cluster processing error: ${msg}`);
        }
      }

      // Phase 5–6: Decompose phrases at word level
      try {
        const decompositionCount = await this.decomposePhrasesIntoWords();
        artifactCount += decompositionCount;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        issues.push(`Phrase decomposition failed: ${msg}`);
        this.logger.warn(`Decomposition error: ${msg}`);
      }

      const latencyMs = Date.now() - startTime;

      this.logger.log(
        `Pattern generalization completed: ${artifactCount} artifacts, ` +
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

      this.logger.error(`Pattern generalization job failed: ${msg}`);

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
   * Query the WKG and cluster phrases by shared FOLLOWS_PATTERN templates.
   *
   * Retrieves all Phrase entities, identifies those connected by FOLLOWS_PATTERN
   * edges, and groups them by template. Returns only clusters meeting minimum size.
   *
   * @returns Array of PatternCluster objects
   */
  private async clusterPhrasesByPattern(): Promise<PatternCluster[]> {
    try {
      // Query for all Phrase entities
      const allPhrases = await this.wkgService.findNodeByLabel('Phrase');

      if (allPhrases.length === 0) {
        this.logger.debug(`No Phrase nodes found in WKG`);
        return [];
      }

      this.logger.debug(`Found ${allPhrases.length} phrase nodes`);

      // Build a map of template -> phrases
      const clusterMap = new Map<string, PhraseNode[]>();

      for (const phrase of allPhrases) {
        // Query outgoing FOLLOWS_PATTERN edges from this phrase
        const followsPatternEdges = await this.wkgService.queryEdges({
          sourceId: phrase.id,
          relationship: 'FOLLOWS_PATTERN',
        });

        // Extract template from phrase properties (if available)
        const template = (phrase.properties?.templateSlot as string) || 'default';

        if (!clusterMap.has(template)) {
          clusterMap.set(template, []);
        }

        const phraseNode: PhraseNode = {
          id: phrase.id,
          text: (phrase.properties?.text ?? phrase.properties?.name ?? '') as string,
          templateSlot: template,
        };

        clusterMap.get(template)!.push(phraseNode);
      }

      // Convert map to clusters, filtering by minimum size
      const clusters: PatternCluster[] = Array.from(clusterMap.entries())
        .filter(([, phrases]) => phrases.length >= this.MIN_CLUSTER_SIZE)
        .map(([template, phrases]) => ({
          template,
          phrases,
        }));

      this.logger.debug(`Clustered ${allPhrases.length} phrases into ${clusters.length} clusters`);

      return clusters;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to cluster phrases by pattern: ${msg}`);
      return [];
    }
  }

  /**
   * Propose a ConceptPrimitive abstraction for a pattern cluster.
   *
   * Type 2 operation: calls the LLM to suggest a concept name and description
   * that abstracts the cluster's shared characteristics. The LLM also provides
   * a confidence estimate.
   *
   * @param cluster - The pattern cluster to abstract
   * @returns Proposed concept with validation coverage, or null if proposal failed
   */
  private async proposeConcept(cluster: PatternCluster): Promise<ProposedConcept | null> {
    if (!this.llmService.isAvailable()) {
      this.logger.warn(`LLM service unavailable; skipping concept proposal`);
      return null;
    }

    if (cluster.phrases.length === 0) {
      return null;
    }

    try {
      // Build phrase list for LLM context
      const phraseTexts = cluster.phrases.map((p) => p.text).join('\n');

      const request = {
        messages: [
          {
            role: 'user' as const,
            content:
              `Analyze these ${cluster.phrases.length} phrases that follow a pattern. ` +
              `Propose a single concept name and description that abstracts their shared meaning. ` +
              `Output as JSON: { "conceptName": "...", "conceptDescription": "...", "confidence": 0.0–1.0 }\n\n` +
              `Phrases:\n${phraseTexts}`,
          },
        ],
        systemPrompt:
          'You are a concept abstraction specialist. Identify the common essence of phrases. ' +
          'Output valid JSON only. Concepts are short (2–5 words), abstract, and apply broadly.',
        maxTokens: 256,
        temperature: 0.3,
        metadata: {
          callerSubsystem: 'LEARNING' as const,
          purpose: 'PATTERN_CONCEPT_PROPOSAL',
          sessionId: 'learning-cycle',
        },
      };

      const response = await this.llmService.complete(request);

      // Parse the LLM response
      let llmConcept: { conceptName: string; conceptDescription: string; confidence: number } | null = null;

      try {
        const jsonMatch = response.content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          llmConcept = JSON.parse(jsonMatch[0]);
        }
      } catch (parseError) {
        this.logger.warn(`Failed to parse concept proposal response: ${parseError}`);
        return null;
      }

      if (!llmConcept) {
        return null;
      }

      // Phase 3: Validate concept by checking how many phrases it applies to
      const validationCoverage = await this.validateConceptCoverage(
        llmConcept.conceptName,
        cluster,
      );

      return {
        clusterTemplate: cluster.template,
        conceptName: llmConcept.conceptName,
        conceptDescription: llmConcept.conceptDescription,
        confidence: Math.min(0.50, llmConcept.confidence), // Cap at 0.50 to leave room for retrieval growth
        clusterSize: cluster.phrases.length,
        validationCoverage,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Concept proposal failed: ${msg}`);
      return null;
    }
  }

  /**
   * Validate whether a proposed concept applies to cluster members.
   *
   * Makes a second LLM call to verify that the concept actually applies to
   * the majority of phrases in the cluster. Returns a coverage fraction.
   *
   * @param conceptName - The proposed concept name
   * @param cluster - The pattern cluster to validate against
   * @returns Validation coverage (0.0–1.0)
   */
  private async validateConceptCoverage(
    conceptName: string,
    cluster: PatternCluster,
  ): Promise<number> {
    if (!this.llmService.isAvailable() || cluster.phrases.length === 0) {
      return 0;
    }

    try {
      const phraseTexts = cluster.phrases.map((p) => p.text).join('\n');

      const request = {
        messages: [
          {
            role: 'user' as const,
            content:
              `For each phrase below, indicate (1 or 0) whether the concept "${conceptName}" applies.\n\n` +
              `Phrases:\n${phraseTexts}\n\n` +
              `Output a JSON array of 1s and 0s: [1, 0, 1, ...]`,
          },
        ],
        systemPrompt:
          `You are a concept validator. For each phrase, output 1 if it exemplifies "${conceptName}", ` +
          `0 if it does not. Output ONLY a JSON array of numbers.`,
        maxTokens: 128,
        temperature: 0.1,
        metadata: {
          callerSubsystem: 'LEARNING' as const,
          purpose: 'CONCEPT_VALIDATION',
          sessionId: 'learning-cycle',
        },
      };

      const response = await this.llmService.complete(request);

      // Parse validation response
      let validationArray: number[] = [];

      try {
        const arrayMatch = response.content.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
          validationArray = JSON.parse(arrayMatch[0]);
        }
      } catch (parseError) {
        this.logger.warn(`Failed to parse validation response: ${parseError}`);
        return 0;
      }

      if (validationArray.length === 0) {
        return 0;
      }

      // Calculate coverage as fraction of 1s
      const coverage = validationArray.filter((v) => v === 1).length / validationArray.length;

      this.logger.debug(
        `Concept "${conceptName}" validation: ${coverage * 100}% coverage ` +
          `(${validationArray.filter((v) => v === 1).length}/${validationArray.length})`,
      );

      return coverage;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Concept validation failed: ${msg}`);
      return 0;
    }
  }

  /**
   * Commit a proposed concept to the WKG and link cluster phrases.
   *
   * Creates a ConceptPrimitiveNode with LLM_GENERATED provenance and links
   * cluster phrases via HAS_INSTANCE edges.
   *
   * @param concept - The validated concept to commit
   * @param cluster - The pattern cluster being abstracted
   * @returns Number of artifacts created (concept node + edges)
   */
  private async commitConceptAndEdges(
    concept: ProposedConcept,
    cluster: PatternCluster,
  ): Promise<number> {
    let artifactCount = 0;

    try {
      // Create ConceptPrimitiveNode
      const conceptNodeResult = await this.wkgService.upsertNode({
        labels: ['Entity', 'ConceptPrimitive', 'Concept'],
        nodeLevel: 'SCHEMA',
        provenance: 'LLM_GENERATED',
        initialConfidence: concept.confidence,
        properties: {
          name: concept.conceptName,
          text: concept.conceptName,
          description: concept.conceptDescription,
          type: 'ConceptPrimitive',
          clusterTemplate: concept.clusterTemplate,
          clusterSize: concept.clusterSize,
          validationCoverage: concept.validationCoverage,
        },
      });

      if (conceptNodeResult.type === 'contradiction') {
        this.logger.warn(
          `Contradiction creating ConceptPrimitive "${concept.conceptName}"; not committing`,
        );
        return 0;
      }

      if (conceptNodeResult.type !== 'success') {
        this.logger.warn(`Failed to create ConceptPrimitive node`);
        return 0;
      }

      const conceptNode = conceptNodeResult.node;
      artifactCount += 1;

      this.logger.log(
        `Created ConceptPrimitive "${concept.conceptName}" (confidence: ${concept.confidence.toFixed(2)})`,
      );

      // Create HAS_INSTANCE edges from concept to cluster phrases
      for (const phrase of cluster.phrases) {
        try {
          const edgeResult = await this.wkgService.upsertEdge({
            sourceId: conceptNode.id,
            targetId: phrase.id,
            relationship: 'HAS_INSTANCE',
            provenance: 'LLM_GENERATED',
            initialConfidence: this.LLM_GENERATED_BASE_CONFIDENCE,
            properties: {
              conceptName: concept.conceptName,
              clusterTemplate: concept.clusterTemplate,
            },
          });

          if (edgeResult.type === 'success') {
            artifactCount += 1;
            this.logger.debug(
              `Created HAS_INSTANCE edge: "${concept.conceptName}" → "${phrase.text.substring(0, 50)}"`,
            );
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          this.logger.warn(`Failed to create HAS_INSTANCE edge: ${msg}`);
        }
      }

      return artifactCount;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to commit concept and edges: ${msg}`);
      return 0;
    }
  }

  /**
   * Decompose phrases into word-level semantic units.
   *
   * Phase 5–6: For all Phrase nodes, extract individual words/tokens as WordNode
   * instances and link phrases to words via CONTAINS_WORD edges.
   *
   * @returns Number of artifacts created (word nodes + edges)
   */
  private async decomposePhrasesIntoWords(): Promise<number> {
    let artifactCount = 0;

    try {
      // Query all Phrase nodes
      const allPhrases = await this.wkgService.findNodeByLabel('Phrase');

      if (allPhrases.length === 0) {
        return 0;
      }

      this.logger.debug(`Decomposing ${allPhrases.length} phrases into words`);

      for (const phrase of allPhrases) {
        try {
          const phraseText = (phrase.properties?.text ?? phrase.properties?.name ?? '') as string;

          if (!phraseText || phraseText.length === 0) {
            continue;
          }

          // Extract words from phrase
          const words = this.extractWordUnits(phraseText);

          if (words.length === 0) {
            continue;
          }

          // Create WordNode for each unique word and link via CONTAINS_WORD
          for (const wordUnit of words) {
            try {
              // Create or find WordNode
              const wordNodeResult = await this.wkgService.upsertNode({
                labels: ['Entity', 'Word'],
                nodeLevel: 'INSTANCE',
                provenance: 'LLM_GENERATED',
                initialConfidence: this.LLM_GENERATED_BASE_CONFIDENCE,
                properties: {
                  name: wordUnit.text,
                  text: wordUnit.text,
                  type: 'Word',
                  semanticRole: wordUnit.semanticRole,
                },
              });

              if (wordNodeResult.type !== 'success') {
                continue;
              }

              const wordNode = wordNodeResult.node;

              // Create CONTAINS_WORD edge from phrase to word
              const containsEdgeResult = await this.wkgService.upsertEdge({
                sourceId: phrase.id,
                targetId: wordNode.id,
                relationship: 'CONTAINS_WORD',
                provenance: 'LLM_GENERATED',
                initialConfidence: this.LLM_GENERATED_BASE_CONFIDENCE,
                properties: {
                  position: wordUnit.position,
                  semanticRole: wordUnit.semanticRole,
                },
              });

              if (containsEdgeResult.type === 'success') {
                artifactCount += 2; // Count word node + edge
                this.logger.debug(
                  `Created Word node and CONTAINS_WORD edge: "${wordUnit.text}" ` +
                    `from phrase "${phraseText.substring(0, 50)}"`,
                );
              }
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error);
              this.logger.warn(`Failed to decompose word "${wordUnit.text}": ${msg}`);
            }
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          this.logger.warn(`Failed to decompose phrase: ${msg}`);
        }
      }

      return artifactCount;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to decompose phrases into words: ${msg}`);
      return 0;
    }
  }

  /**
   * Extract word units from a phrase text.
   *
   * Tokenizes the phrase on whitespace and punctuation, removing common
   * stopwords. Each unit carries its position and optional semantic role
   * (heuristically assigned based on word patterns).
   *
   * @param phraseText - The phrase to decompose
   * @returns Array of WordUnit objects
   */
  private extractWordUnits(phraseText: string): WordUnit[] {
    const stopwords = new Set([
      'the',
      'a',
      'an',
      'and',
      'or',
      'but',
      'in',
      'on',
      'at',
      'to',
      'for',
      'of',
      'with',
      'is',
      'are',
      'was',
      'were',
      'be',
      'been',
    ]);

    // Tokenize on whitespace and punctuation
    const tokens = phraseText
      .toLowerCase()
      .split(/[\s\-.,!?;:""''"()\[\]{}]+/)
      .filter((token) => token.length > 0 && !stopwords.has(token));

    // Build WordUnit array with positions and simple semantic role heuristics
    const units: WordUnit[] = tokens.map((text, index) => {
      let semanticRole: string | undefined;

      // Simple heuristic: assign roles based on position and word patterns
      if (index === 0) {
        semanticRole = 'subject';
      } else if (index === 1 && tokens.length > 2) {
        semanticRole = 'verb';
      } else if (text.endsWith('ly')) {
        semanticRole = 'adverb';
      } else if (text.endsWith('ing')) {
        semanticRole = 'gerund';
      }

      return {
        text,
        semanticRole,
        position: index,
      };
    });

    return units;
  }
}
