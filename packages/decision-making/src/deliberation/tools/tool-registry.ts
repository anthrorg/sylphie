/**
 * Tool Registry — MCP-style tools available to the LLM during deliberation.
 *
 * Each tool has a definition (name, description, parameters) and a handler
 * function that executes the tool and returns results. Tools give the LLM
 * access to Sylphie's internal systems during Type 2 reasoning:
 *
 *   wkg_query          — Query the World Knowledge Graph (PRIMARY tool)
 *   episodic_search    — Search recent episodic memory
 *   person_query       — Look up person model facts
 *   drive_state        — Check current motivational state
 *   google_search      — External consensus verification (NOT truth)
 *
 * Provenance rules:
 *   WKG facts:           high trust (SENSOR/GUARDIAN provenance)
 *   Episodic memory:     medium trust (SENSOR provenance)
 *   Google search:       low trust (INFERENCE — consensus signal only)
 *   LLM-generated:       lowest trust (LLM_GENERATED)
 */

import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DriveName,
  type DriveSnapshot,
} from '@sylphie/shared';
import {
  DRIVE_STATE_READER,
  type IDriveStateReader,
} from '@sylphie/drive-engine';
import { WkgContextService } from '../../wkg/wkg-context.service';
import type { IEpisodicMemoryService } from '../../interfaces/decision-making.interfaces';
import { EPISODIC_MEMORY_SERVICE } from '../../decision-making.tokens';
import type { ToolDefinition, ToolExecutor } from '../../llm/ollama-llm.service';

// ---------------------------------------------------------------------------
// High-fidelity domains for search filtering
// ---------------------------------------------------------------------------

/**
 * Trusted domains that produce reliable information for fact-checking.
 * Search results from these domains get higher provenance weight.
 * Used as a default filter when the LLM doesn't specify domains.
 */
const HIGH_FIDELITY_DOMAINS = [
  'wikipedia.org',
  'britannica.com',
  'nature.com',
  'science.org',
  'plato.stanford.edu',    // Stanford Encyclopedia of Philosophy
  'ncbi.nlm.nih.gov',     // PubMed
  'arxiv.org',
  'scholar.google.com',
  'bbc.com',
  'reuters.com',
  'apnews.com',
  'nasa.gov',
  'cdc.gov',
  'who.int',
  'nist.gov',
];

// ---------------------------------------------------------------------------
// Tool Definitions (schema for the LLM)
// ---------------------------------------------------------------------------

export const DELIBERATION_TOOLS: ToolDefinition[] = [
  {
    name: 'wkg_query',
    description:
      'Query Sylphie\'s World Knowledge Graph for entities, facts, and relationships. ' +
      'This is my primary knowledge source — what I actually know from experience and learning.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Entity name or topic to look up',
        },
        entity_id: {
          type: 'string',
          description: 'Specific node ID to get facts about (optional)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'episodic_search',
    description:
      'Search my recent episodic memory for similar situations I\'ve experienced. ' +
      'Returns episodes that match the given context.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Description of the situation to search for',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'person_query',
    description:
      'Look up what I know about a specific person. ' +
      'Returns known facts, interaction history, and preferences.',
    parameters: {
      type: 'object',
      properties: {
        person_id: {
          type: 'string',
          description: 'Person identifier (e.g., "guardian", "Jim")',
        },
      },
      required: ['person_id'],
    },
  },
  {
    name: 'drive_state',
    description:
      'Check my current internal motivational state. ' +
      'Returns all 12 drive pressures showing what I\'m feeling right now.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'web_search',
    description:
      'Search the web for consensus on a factual claim using multiple search engines. ' +
      'Results are filtered to high-fidelity sources (Wikipedia, Nature, Britannica, PubMed, etc.). ' +
      'WARNING: This is NOT ground truth — it\'s what the world thinks, which may be wrong. ' +
      'Use only to calibrate my own reasoning, not as a primary source of knowledge.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query to verify against public knowledge',
        },
      },
      required: ['query'],
    },
  },
];

// ---------------------------------------------------------------------------
// ToolRegistryService
// ---------------------------------------------------------------------------

@Injectable()
export class ToolRegistryService {
  private readonly logger = new Logger(ToolRegistryService.name);

  /** SearXNG instance URL for web searches. */
  private searxngUrl: string;

  constructor(
    private readonly wkgContext: WkgContextService,

    @Optional()
    @Inject(EPISODIC_MEMORY_SERVICE)
    private readonly episodicMemory: IEpisodicMemoryService | null,

    @Inject(DRIVE_STATE_READER)
    private readonly driveStateReader: IDriveStateReader,

    private readonly config: ConfigService,
  ) {
    this.searxngUrl = this.config.get<string>('ollama.searxngUrl', 'http://localhost:8888');
  }

  /** Get all tool definitions for passing to the LLM. */
  getToolDefinitions(): ToolDefinition[] {
    return DELIBERATION_TOOLS;
  }

  /**
   * Create a ToolExecutor function that dispatches tool calls to handlers.
   *
   * The returned function is passed to `OllamaLlmService.completeWithTools()`
   * and called each time the LLM invokes a tool.
   */
  createExecutor(): ToolExecutor {
    return async (toolName: string, args: Record<string, unknown>): Promise<unknown> => {
      this.logger.debug(`Executing tool: ${toolName}(${JSON.stringify(args)})`);

      switch (toolName) {
        case 'wkg_query':
          return this.executeWkgQuery(args);

        case 'episodic_search':
          return this.executeEpisodicSearch(args);

        case 'person_query':
          return this.executePersonQuery(args);

        case 'drive_state':
          return this.executeDriveState();

        case 'web_search':
        case 'google_search': // backward compat
          return this.executeGoogleSearch(args);

        default:
          return { error: `Unknown tool: ${toolName}` };
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Tool Handlers
  // ---------------------------------------------------------------------------

  private async executeWkgQuery(args: Record<string, unknown>): Promise<unknown> {
    const query = (args['query'] as string) ?? '';
    const entityId = args['entity_id'] as string | undefined;

    if (entityId) {
      const facts = await this.wkgContext.getEntityFacts(entityId);
      return {
        source: 'WKG',
        provenance: 'high_trust',
        entity_id: entityId,
        facts: facts.map((f) => `${f.subject} ${f.predicate} ${f.object} (confidence: ${f.confidence.toFixed(2)})`),
        count: facts.length,
      };
    }

    const entities = await this.wkgContext.queryEntities(query);
    return {
      source: 'WKG',
      provenance: 'high_trust',
      query,
      entities: entities.map((e) => ({
        id: e.nodeId,
        label: e.label,
        type: e.nodeType,
        confidence: e.confidence,
      })),
      count: entities.length,
      note: entities.length === 0
        ? 'No matching knowledge found. This is a novel topic for me.'
        : undefined,
    };
  }

  private async executeEpisodicSearch(args: Record<string, unknown>): Promise<unknown> {
    const query = (args['query'] as string) ?? '';

    if (!this.episodicMemory) {
      return { source: 'episodic_memory', episodes: [], note: 'Episodic memory unavailable' };
    }

    const episodes = this.episodicMemory.queryByContext(query, 5);
    return {
      source: 'episodic_memory',
      provenance: 'medium_trust',
      query,
      episodes: episodes.map((ep) => ({
        summary: ep.inputSummary,
        action: ep.actionTaken,
        ageWeight: ep.ageWeight.toFixed(2),
        timestamp: ep.timestamp.toISOString(),
      })),
      count: episodes.length,
      note: episodes.length === 0
        ? 'No similar experiences found. This situation is new to me.'
        : undefined,
    };
  }

  private async executePersonQuery(args: Record<string, unknown>): Promise<unknown> {
    const personId = (args['person_id'] as string) ?? 'guardian';

    // Query WKG for Person nodes
    const entities = await this.wkgContext.queryEntities(personId);
    const personEntities = entities.filter((e) =>
      e.nodeType === 'Person' || e.label.toLowerCase().includes(personId.toLowerCase()),
    );

    if (personEntities.length > 0) {
      const facts = await this.wkgContext.getEntityFacts(personEntities[0].nodeId);
      return {
        source: 'person_model',
        provenance: 'high_trust',
        person_id: personId,
        known_facts: facts.map((f) => `${f.predicate}: ${f.object}`),
        confidence: personEntities[0].confidence,
      };
    }

    return {
      source: 'person_model',
      person_id: personId,
      known_facts: [],
      note: `I don't have specific knowledge about "${personId}" yet.`,
    };
  }

  private executeDriveState(): unknown {
    const snapshot: DriveSnapshot = this.driveStateReader.getCurrentState();
    const drives: Record<string, string> = {};

    for (const drive of Object.values(DriveName)) {
      const value = snapshot.pressureVector[drive];
      drives[drive] = value.toFixed(3);
    }

    return {
      source: 'drive_engine',
      provenance: 'direct_observation',
      drives,
      total_pressure: snapshot.totalPressure.toFixed(3),
      interpretation: interpretDriveState(snapshot),
    };
  }

  /**
   * Execute a web search via the self-hosted SearXNG instance.
   *
   * Results are filtered to high-fidelity domains by default. The LLM
   * can override by including site: operators in the query.
   *
   * Provenance: LOW TRUST. Search results are consensus signals, not
   * ground truth. The system must weigh these against WKG knowledge.
   */
  private async executeGoogleSearch(args: Record<string, unknown>): Promise<unknown> {
    const rawQuery = (args['query'] as string) ?? '';
    if (!rawQuery) {
      return { source: 'web_search', results: [], note: 'Empty query' };
    }

    // If the query doesn't already contain site: operators, add a filter
    // for high-fidelity domains to reduce noise.
    const hasSiteFilter = /site:\S+/.test(rawQuery);
    const query = hasSiteFilter
      ? rawQuery
      : rawQuery;  // SearXNG doesn't support domain filtering in the same way — we filter results instead

    try {
      const url = `${this.searxngUrl}/search?q=${encodeURIComponent(query)}&format=json&language=en&categories=general,science,it&pageno=1`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        this.logger.warn(`SearXNG returned ${response.status}: ${response.statusText}`);
        return {
          source: 'web_search',
          provenance: 'low_trust_consensus_signal',
          query: rawQuery,
          results: [],
          note: `Search service returned HTTP ${response.status}. Rely on internal knowledge.`,
        };
      }

      const data = await response.json() as {
        results?: Array<{
          title?: string;
          url?: string;
          content?: string;
          engine?: string;
          score?: number;
        }>;
      };

      const allResults = data.results ?? [];

      // Filter to high-fidelity domains if no explicit site: was used
      const filtered = hasSiteFilter
        ? allResults
        : allResults.filter((r) => {
            if (!r.url) return false;
            try {
              const hostname = new URL(r.url).hostname;
              return HIGH_FIDELITY_DOMAINS.some((d) => hostname.endsWith(d));
            } catch {
              return false;
            }
          });

      // If filtering removed everything, fall back to top results from any domain
      const finalResults = filtered.length > 0 ? filtered : allResults.slice(0, 5);

      this.logger.debug(
        `SearXNG: "${rawQuery}" → ${allResults.length} total, ${filtered.length} high-fidelity, returning ${finalResults.length}`,
      );

      return {
        source: 'web_search',
        provenance: 'low_trust_consensus_signal',
        query: rawQuery,
        results: finalResults.slice(0, 8).map((r) => ({
          title: r.title ?? '',
          url: r.url ?? '',
          snippet: r.content ?? '',
          engine: r.engine ?? 'unknown',
          fromTrustedDomain: HIGH_FIDELITY_DOMAINS.some((d) =>
            r.url ? new URL(r.url).hostname.endsWith(d) : false,
          ),
        })),
        resultCount: finalResults.length,
        warning: 'These are consensus signals, NOT ground truth. Weigh against WKG knowledge.',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`SearXNG search failed: ${msg}`);

      return {
        source: 'web_search',
        provenance: 'low_trust_consensus_signal',
        query: rawQuery,
        results: [],
        note: `Search unavailable: ${msg}. Rely on internal knowledge.`,
        warning: 'Search results are consensus signals, NOT ground truth.',
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function interpretDriveState(snapshot: DriveSnapshot): string {
  const pv = snapshot.pressureVector;
  const parts: string[] = [];

  if (pv[DriveName.Anxiety] > 0.5) parts.push('anxious');
  if (pv[DriveName.Curiosity] > 0.5) parts.push('curious');
  if (pv[DriveName.Boredom] > 0.5) parts.push('bored');
  if (pv[DriveName.Social] > 0.5) parts.push('socially motivated');
  if (pv[DriveName.Guilt] > 0.3) parts.push('feeling some guilt');
  if (pv[DriveName.Satisfaction] > 0.5) parts.push('satisfied');
  if (pv[DriveName.Sadness] > 0.3) parts.push('a bit sad');

  if (parts.length === 0) return 'calm and neutral';
  return parts.join(', ');
}
