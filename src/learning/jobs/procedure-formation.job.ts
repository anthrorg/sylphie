/**
 * ProcedureFormationJob — synthesizes procedures from learned knowledge.
 *
 * Implements ILearningJob. Clusters RESPONSE_TO edges by word overlap (Jaccard
 * similarity) and uses the LLM to propose ActionProcedure abstractions. Each
 * proposed procedure is validated against its cluster and committed with
 * LLM_GENERATED provenance at 0.35.
 *
 * CANON §Subsystem 3: Each consolidation cycle executes multiple jobs.
 * This job identifies recurring response patterns that could become
 * Type 1 procedures for the Decision Making subsystem.
 *
 * CANON §Type 2 Cost Requirement: All LLM calls carry explicit cost tracking
 * via ILlmService. Job reports latency and token usage for drive pressure.
 *
 * CANON §Guardian Asymmetry (Standard 5): ActionProcedure nodes created from
 * LLM reasoning carry LLM_GENERATED provenance at 0.35 base confidence.
 * Confidence increases only through successful use and guardian confirmation.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';

import type { ILearningJob, JobResult } from '../interfaces/learning.interfaces';
import type { IWkgService } from '../../knowledge/interfaces/knowledge.interfaces';
import type { ILlmService, LlmRequest } from '../../shared/types/llm.types';
import type { IEventService } from '../../events/interfaces/events.interfaces';
import { WKG_SERVICE } from '../../knowledge/knowledge.tokens';
import { LLM_SERVICE } from '../../shared/types/llm.types';
import { EVENTS_SERVICE } from '../../events/events.tokens';
import type { KnowledgeEdge } from '../../shared/types/knowledge.types';

/**
 * Configuration for procedure formation.
 */
interface ProcedureFormationConfig {
  /** Minimum Jaccard similarity threshold for clustering. Default 0.4. */
  readonly clusterThreshold: number;

  /** Validation threshold: proposed procedure must explain >= N% of edges. Default 0.70. */
  readonly validationThreshold: number;

  /** Minimum number of RESPONSE_TO edges to attempt clustering. Default 5. */
  readonly minEdgesForClustering: number;

  /** Maximum edges to process per run (prevent runaway). Default 100. */
  readonly maxEdgesToProcess: number;
}

/**
 * A cluster of similar RESPONSE_TO edges grouped by word overlap.
 */
interface ResponseCluster {
  /** Edges in this cluster. */
  readonly edges: readonly KnowledgeEdge[];

  /** Source node IDs (for linking procedures later). */
  readonly sourceNodeIds: readonly string[];

  /** Representative phrases (source and target of edges). */
  readonly sourcePhrase: string;
  readonly targetPhrase: string;

  /** Similarity score of edges in the cluster. */
  readonly clusterSimilarity: number;
}

/**
 * A proposed ActionProcedure with validation results.
 */
interface ProposedProcedure {
  /** LLM-generated abstraction (the procedure name/pattern). */
  readonly abstraction: string;

  /** Number of cluster edges this procedure explains. */
  readonly explanationCount: number;

  /** Total edges in the cluster. */
  readonly clusterSize: number;

  /** Whether validation passed (explanationCount / clusterSize >= validationThreshold). */
  readonly isValid: boolean;

  /** The cluster this procedure was derived from. */
  readonly cluster: ResponseCluster;
}

@Injectable()
export class ProcedureFormationJob implements ILearningJob {
  private readonly logger = new Logger(ProcedureFormationJob.name);

  /** Default configuration for procedure formation. */
  private readonly config: ProcedureFormationConfig = {
    clusterThreshold: 0.4,
    validationThreshold: 0.70,
    minEdgesForClustering: 5,
    maxEdgesToProcess: 100,
  };

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
    return 'procedure-formation';
  }

  /**
   * Determine whether this job should run in the current consolidation cycle.
   *
   * Checks if sufficient RESPONSE_TO edges exist in the WKG to justify
   * clustering and procedure formation. Returns false if LLM is unavailable.
   *
   * @returns True if the job should execute; false to skip.
   */
  shouldRun(): boolean {
    // Skip if LLM is not available (e.g., during Lesion Test).
    if (!this.llmService.isAvailable()) {
      this.logger.debug('LLM unavailable; skipping procedure formation');
      return false;
    }

    // For now, always run if LLM is available.
    // In a more sophisticated implementation, we would check actual edge count
    // via queryEdges with relationship filter.
    return true;
  }

  /**
   * Execute the job: cluster RESPONSE_TO edges and propose procedures.
   *
   * 1. Collect RESPONSE_TO edges from the WKG
   * 2. Compute word overlap (Jaccard similarity) between edge pairs
   * 3. Cluster at similarity threshold (default 0.4)
   * 4. For each cluster: use LLM to propose an ActionProcedure abstraction
   * 5. Validate: proposed procedure must explain >= 70% of cluster edges
   * 6. Commit valid proposals to WKG with LLM_GENERATED provenance at 0.35
   * 7. Link via DERIVED_FROM edges to source RESPONSE_TO edges
   *
   * @returns Result of job execution with artifact count, issues, and latency.
   */
  async run(): Promise<JobResult> {
    const startTime = Date.now();
    const issues: string[] = [];
    let artifactCount = 0;

    try {
      this.logger.log('Starting procedure formation job');

      // Step 1: Collect RESPONSE_TO edges
      const edges = await this.wkgService.queryEdges({
        relationship: 'RESPONSE_TO',
        limit: this.config.maxEdgesToProcess,
      });

      if (edges.length < this.config.minEdgesForClustering) {
        this.logger.log(
          `Only ${edges.length} RESPONSE_TO edges found; need at least ${this.config.minEdgesForClustering}`,
        );
        return {
          jobName: this.name,
          success: true,
          artifactCount: 0,
          issues: [],
          latencyMs: Date.now() - startTime,
        };
      }

      this.logger.log(
        `Collected ${edges.length} RESPONSE_TO edges for clustering`,
      );

      // Step 2 & 3: Cluster edges by word overlap
      const clusters = this.clusterByWordOverlap(edges);

      this.logger.log(
        `Formed ${clusters.length} clusters from ${edges.length} edges`,
      );

      // Step 4: Propose procedures for each cluster
      const proposals = await this.proposeProcedures(clusters);

      this.logger.log(
        `Proposed ${proposals.length} procedures from ${clusters.length} clusters`,
      );

      // Step 5-7: Validate and commit valid proposals
      for (const proposal of proposals) {
        if (!proposal.isValid) {
          issues.push(
            `Procedure "${proposal.abstraction}" failed validation: ` +
              `${proposal.explanationCount}/${proposal.clusterSize} edges explained ` +
              `(required >= ${Math.ceil(proposal.clusterSize * this.config.validationThreshold)})`,
          );
          continue;
        }

        try {
          const procedureId = await this.commitProcedure(proposal);
          artifactCount++;

          // Link procedure to source RESPONSE_TO edges via DERIVED_FROM
          await this.linkProcedureToCluster(
            procedureId,
            proposal.cluster,
          );

          this.logger.debug(
            `Created ActionProcedure "${proposal.abstraction}" (${procedureId}) ` +
              `explaining ${proposal.explanationCount}/${proposal.clusterSize} cluster edges`,
          );
        } catch (error) {
          const errorMsg =
            error instanceof Error ? error.message : String(error);
          issues.push(
            `Failed to commit procedure "${proposal.abstraction}": ${errorMsg}`,
          );
        }
      }

      this.logger.log(
        `Procedure formation job completed: ${artifactCount} procedures created`,
      );

      return {
        jobName: this.name,
        success: true,
        artifactCount,
        issues,
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Procedure formation job failed: ${errorMsg}`, error);

      return {
        jobName: this.name,
        success: false,
        artifactCount,
        issues: [...issues, `Job execution failed: ${errorMsg}`],
        latencyMs: Date.now() - startTime,
        error: errorMsg,
      };
    }
  }

  /**
   * Cluster RESPONSE_TO edges by word overlap (Jaccard similarity).
   *
   * Groups edges whose sourceId and targetId are sufficiently similar based
   * on the phrases they reference. Uses edge metadata (properties) to extract
   * text, or falls back to node IDs as strings for matching.
   * (similarity >= clusterThreshold). Uses a greedy single-pass clustering
   * algorithm for simplicity.
   *
   * @param edges - RESPONSE_TO edges to cluster
   * @returns Array of ResponseCluster objects
   */
  private clusterByWordOverlap(edges: readonly KnowledgeEdge[]): ResponseCluster[] {
    const clusters: ResponseCluster[] = [];
    const processed = new Set<string>();

    for (const edge of edges) {
      const edgeKey = edge.id;

      if (processed.has(edgeKey)) {
        continue;
      }

      // Start a new cluster with this edge
      const clusterEdges: KnowledgeEdge[] = [edge];
      const clusterSourceIds: string[] = [edge.sourceId];
      processed.add(edgeKey);

      const sourcePhrase = this.extractPhraseFromEdge(edge, 'source');
      const targetPhrase = this.extractPhraseFromEdge(edge, 'target');

      // Greedily add subsequent edges that are similar to this edge
      for (const candidate of edges) {
        if (processed.has(candidate.id)) {
          continue;
        }

        const candidateSource = this.extractPhraseFromEdge(
          candidate,
          'source',
        );
        const candidateTarget = this.extractPhraseFromEdge(
          candidate,
          'target',
        );

        const sourceSim = this.jaccardSimilarity(sourcePhrase, candidateSource);
        const targetSim = this.jaccardSimilarity(targetPhrase, candidateTarget);

        // Average similarity of both directions
        const avgSim = (sourceSim + targetSim) / 2;

        if (avgSim >= this.config.clusterThreshold) {
          clusterEdges.push(candidate);
          clusterSourceIds.push(candidate.sourceId);
          processed.add(candidate.id);
        }
      }

      // Compute average cluster similarity
      const similarities: number[] = [];
      for (let i = 0; i < clusterEdges.length; i++) {
        for (let j = i + 1; j < clusterEdges.length; j++) {
          const e1 = clusterEdges[i];
          const e2 = clusterEdges[j];
          const s1Sim = this.jaccardSimilarity(
            this.extractPhraseFromEdge(e1, 'source'),
            this.extractPhraseFromEdge(e2, 'source'),
          );
          const s2Sim = this.jaccardSimilarity(
            this.extractPhraseFromEdge(e1, 'target'),
            this.extractPhraseFromEdge(e2, 'target'),
          );
          similarities.push((s1Sim + s2Sim) / 2);
        }
      }

      const clusterSimilarity =
        similarities.length > 0
          ? similarities.reduce((a, b) => a + b, 0) / similarities.length
          : 1.0;

      clusters.push({
        edges: clusterEdges,
        sourceNodeIds: clusterSourceIds,
        sourcePhrase,
        targetPhrase,
        clusterSimilarity,
      });
    }

    return clusters;
  }

  /**
   * Compute Jaccard similarity between two word sets.
   *
   * Jaccard = |A ∩ B| / |A ∪ B|
   *
   * @param phrase1 - First phrase
   * @param phrase2 - Second phrase
   * @returns Similarity in [0.0, 1.0]
   */
  private jaccardSimilarity(phrase1: string, phrase2: string): number {
    const words1 = new Set(
      phrase1.toLowerCase().split(/\s+/).filter((w) => w.length > 0),
    );
    const words2 = new Set(
      phrase2.toLowerCase().split(/\s+/).filter((w) => w.length > 0),
    );

    const intersection = new Set(
      [...words1].filter((w) => words2.has(w)),
    );
    const union = new Set([...words1, ...words2]);

    if (union.size === 0) {
      return 1.0; // Both empty
    }

    return intersection.size / union.size;
  }

  /**
   * Extract phrase content from a KnowledgeEdge's metadata.
   *
   * RESPONSE_TO edges store phrase text in properties.sourceText and
   * properties.targetText. Falls back to node IDs as a last resort.
   *
   * @param edge - The edge to extract from
   * @param direction - 'source' or 'target'
   * @returns Normalized phrase string
   */
  private extractPhraseFromEdge(
    edge: KnowledgeEdge,
    direction: 'source' | 'target',
  ): string {
    const key =
      direction === 'source' ? 'sourceText' : 'targetText';
    const text =
      edge.properties && typeof edge.properties[key] === 'string'
        ? edge.properties[key]
        : direction === 'source'
          ? edge.sourceId
          : edge.targetId;

    return String(text).trim();
  }

  /**
   * Propose ActionProcedure abstractions for each cluster via LLM.
   *
   * For each cluster, the LLM is asked to propose a single abstraction that
   * captures the pattern. The proposal is then validated against the cluster.
   *
   * @param clusters - ResponseClusters to propose procedures for
   * @returns Array of ProposedProcedure objects
   */
  private async proposeProcedures(
    clusters: readonly ResponseCluster[],
  ): Promise<ProposedProcedure[]> {
    const proposals: ProposedProcedure[] = [];

    for (const cluster of clusters) {
      try {
        const abstraction = await this.proposeProcedureForCluster(cluster);

        // Validate: count how many edges in the cluster this procedure explains
        const explanationCount = this.validateProcedure(
          abstraction,
          cluster,
        );

        const isValid =
          explanationCount / cluster.edges.length >=
          this.config.validationThreshold;

        proposals.push({
          abstraction,
          explanationCount,
          clusterSize: cluster.edges.length,
          isValid,
          cluster,
        });
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Failed to propose procedure for cluster: ${errorMsg}`,
        );
      }
    }

    return proposals;
  }

  /**
   * Use LLM to propose a procedure abstraction for a cluster.
   *
   * @param cluster - The ResponseCluster to abstract
   * @returns LLM-generated procedure name/description
   */
  private async proposeProcedureForCluster(
    cluster: ResponseCluster,
  ): Promise<string> {
    const prompt = this.buildProposalPrompt(cluster);

    const request: LlmRequest = {
      messages: [{ role: 'user', content: prompt }],
      systemPrompt: this.buildProcedureSystemPrompt(),
      maxTokens: 150,
      temperature: 0.3, // Conservative: we want a focused abstraction
      metadata: {
        callerSubsystem: 'LEARNING',
        purpose: 'PROCEDURE_FORMATION',
        sessionId: 'learning-session', // TODO: inject session ID
      },
    };

    try {
      const response = await this.llmService.complete(request);
      // Extract the first sentence or line as the procedure name
      const lines = response.content.split('\n').filter((l) => l.trim());
      return lines[0] || 'UnnamedProcedure';
    } catch (error) {
      throw new Error(
        `LLM call failed during procedure proposal: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Build the user prompt for procedure proposal.
   *
   * @param cluster - The ResponseCluster to abstract
   * @returns Prompt string
   */
  private buildProposalPrompt(cluster: ResponseCluster): string {
    const edgeSamples = cluster.edges
      .slice(0, 3) // Show first 3 as examples
      .map(
        (e) =>
          `"${this.extractPhraseFromEdge(e, 'source')}" → "${this.extractPhraseFromEdge(e, 'target')}"`,
      )
      .join('\n');

    return (
      `Analyze these response patterns and propose a single high-level abstraction ` +
      `that captures what is happening:\n\n${edgeSamples}\n\n` +
      `Respond with ONLY a short procedure name (e.g., "provide-confirmation", "acknowledge-understanding"). ` +
      `Do not explain or add extra text.`
    );
  }

  /**
   * Build system prompt for procedure formation LLM calls.
   *
   * @returns System prompt
   */
  private buildProcedureSystemPrompt(): string {
    return (
      'You are a learning system analyzing conversational patterns. ' +
      'Your task is to identify high-level abstractions of recurring behaviors. ' +
      'Be concise and focus on capturing the essence of the pattern.'
    );
  }

  /**
   * Validate a proposed procedure against its cluster.
   *
   * Simple heuristic: count how many cluster edges contain words from the
   * procedure abstraction. A better implementation would use semantic similarity.
   *
   * @param abstraction - The proposed procedure
   * @param cluster - The ResponseCluster
   * @returns Number of edges the procedure explains
   */
  private validateProcedure(
    abstraction: string,
    cluster: ResponseCluster,
  ): number {
    const abstractionWords = new Set(
      abstraction.toLowerCase().split(/\s+/).filter((w) => w.length > 2),
    );

    let count = 0;

    for (const edge of cluster.edges) {
      const sourceWords = new Set(
        this.extractPhraseFromEdge(edge, 'source')
          .toLowerCase()
          .split(/\s+/),
      );
      const targetWords = new Set(
        this.extractPhraseFromEdge(edge, 'target')
          .toLowerCase()
          .split(/\s+/),
      );
      const allWords = new Set([...sourceWords, ...targetWords]);

      const overlap = [...abstractionWords].filter((w) => allWords.has(w));

      if (overlap.length > 0) {
        count++;
      }
    }

    return count;
  }

  /**
   * Commit a valid ActionProcedure to the WKG.
   *
   * Creates a node with labels ['ActionProcedure', 'ConversationalResponse'],
   * provenance LLM_GENERATED, and confidence 0.35 (CANON Standard 3).
   * Uses SCHEMA level because procedures are pattern abstractions, not instances.
   *
   * @param proposal - The ProposedProcedure to commit
   * @returns The created procedure node ID
   */
  private async commitProcedure(proposal: ProposedProcedure): Promise<string> {
    const result = await this.wkgService.upsertNode({
      labels: ['ActionProcedure', 'ConversationalResponse'],
      nodeLevel: 'SCHEMA', // CANON: procedures are generalizations, not instances
      provenance: 'LLM_GENERATED',
      initialConfidence: 0.35, // CANON Standard 3: Confidence Ceiling at 0.60
      properties: {
        name: proposal.abstraction,
        description: `Procedure abstraction from ${proposal.clusterSize} response patterns`,
        derivedFrom: `procedure-formation-job`,
        clusterSize: proposal.clusterSize,
        explanationCount: proposal.explanationCount,
        validationScore:
          proposal.explanationCount / proposal.clusterSize,
        createdAt: new Date().toISOString(),
      },
    });

    if (result.type === 'contradiction') {
      throw new Error(
        `Contradiction creating ActionProcedure "${proposal.abstraction}": ` +
          `conflicts with existing node`,
      );
    }

    return result.node.id;
  }

  /**
   * Link a procedure node to its source cluster via DERIVED_FROM edges.
   *
   * Creates edges from the procedure node to representative source nodes
   * in the cluster.
   *
   * @param procedureId - The ActionProcedure node ID
   * @param cluster - The ResponseCluster
   */
  private async linkProcedureToCluster(
    procedureId: string,
    cluster: ResponseCluster,
  ): Promise<void> {
    // Link procedure to first source node (cluster representative)
    const sourceNodeId = cluster.sourceNodeIds[0];
    if (sourceNodeId) {
      try {
        await this.wkgService.upsertEdge({
          sourceId: procedureId,
          targetId: sourceNodeId,
          relationship: 'DERIVED_FROM',
          provenance: 'LLM_GENERATED',
          initialConfidence: 0.35,
          properties: {
            clusterSize: cluster.edges.length,
            edgeCount: cluster.edges.length,
            linkedAt: new Date().toISOString(),
          },
        });
      } catch (error) {
        // Non-fatal: log but continue
        this.logger.warn(
          `Failed to link procedure to cluster source: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
