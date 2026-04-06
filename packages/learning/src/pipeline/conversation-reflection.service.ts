/**
 * ConversationReflectionService — Holistic conversation analysis for the
 * Learning subsystem.
 *
 * CANON §Subsystem 3 (Learning): While the maintenance cycle processes
 * individual events in isolation, reflection operates on completed
 * conversations as narrative units to extract insights that no single
 * event could reveal.
 *
 * Trigger: A separate timer in LearningService fires every 5 minutes.
 * The service finds sessions with no new events for SESSION_QUIET_THRESHOLD_MS,
 * retrieves all events for that session, sends the full conversation to the
 * LLM, and persists extracted insights as Insight nodes in the WKG.
 *
 * Insight types:
 *   DELAYED_REALIZATION  — connections between temporally distant statements
 *   MISSED_CONNECTION    — entities that appear separate but are the same situation
 *   IMPLICIT_INSTRUCTION — unstated preferences/directions revealed by context
 *   CONTRADICTION        — statements that conflict when viewed holistically
 *   THEMATIC_THREAD      — recurring themes that reveal deeper patterns
 *   TONAL_SHIFT          — changes in how someone discusses a topic over time
 *
 * Lesion Test: if LLM is unavailable, reflection is skipped entirely.
 * Without LLM, Sylphie still learns per-event facts through the pipeline;
 * she just cannot synthesize cross-event insights.
 *
 * Provenance: INFERENCE (0.30). Reflection is reasoning about patterns, not
 * direct observation. Confidence can grow through retrieval-and-use or
 * guardian confirmation.
 *
 * Temperature 0.3 (conservative) — accuracy over creativity.
 */

import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  LLM_SERVICE,
  TimescaleService,
  Neo4jService,
  Neo4jInstanceName,
  type ILlmService,
  type LlmRequest,
} from '@sylphie/shared';
import type {
  IConversationReflectionService,
  ILearningEventLogger,
  ReflectionInsight,
  ReflectionResult,
  SessionCandidate,
  InsightType,
} from '../interfaces/learning.interfaces';
import { LEARNING_EVENT_LOGGER } from '../learning.tokens';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How long a session must be quiet before it is eligible for reflection. */
const SESSION_QUIET_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

/** Minimum events in a session before reflection is worthwhile. */
const MIN_EVENTS_FOR_REFLECTION = 4;

/** Maximum characters of conversation content to send to the LLM. */
const MAX_CONVERSATION_CHARS = 8000;

/** Maximum insights parsed per session (guards against runaway LLM output). */
const MAX_INSIGHTS_PER_SESSION = 10;

/** Provenance for reflection-derived knowledge. */
const REFLECTION_PROVENANCE = 'INFERENCE' as const;

/** Base confidence for reflection-derived nodes and edges. */
const REFLECTION_CONFIDENCE = 0.30;

/** Valid insight type strings for parsing validation. */
const VALID_INSIGHT_TYPES = new Set<string>([
  'DELAYED_REALIZATION',
  'MISSED_CONNECTION',
  'IMPLICIT_INSTRUCTION',
  'CONTRADICTION',
  'THEMATIC_THREAD',
  'TONAL_SHIFT',
]);

/** Valid edge types the LLM may suggest (matches refine-edges.service.ts). */
const VALID_EDGE_TYPES = new Set([
  'LIKES', 'DISLIKES', 'KNOWS', 'WORKS_AT', 'LIVES_AT', 'OWNS', 'USES',
  'CREATED', 'BELONGS_TO', 'IS_PART_OF', 'IS_TYPE_OF', 'LOCATED_IN',
  'HAS_PROPERTY', 'CAUSED_BY', 'LED_TO', 'CONTRADICTS', 'RELATED_TO',
]);

/** Regex patterns for parsing LLM response. */
const INSIGHT_LINE_RE =
  /^INSIGHT:\s*(DELAYED_REALIZATION|MISSED_CONNECTION|IMPLICIT_INSTRUCTION|CONTRADICTION|THEMATIC_THREAD|TONAL_SHIFT)\s*\|\s*([\d.]+)\s*\|\s*(.+)$/;
const ENTITIES_LINE_RE = /^ENTITIES:\s*(.+)$/;
const EDGE_LINE_RE = /^EDGE:\s*(.+?)\s*->\s*(.+?)\s*\|\s*([A-Z_]+)\s*$/;

// ---------------------------------------------------------------------------
// ConversationReflectionService
// ---------------------------------------------------------------------------

@Injectable()
export class ConversationReflectionService implements IConversationReflectionService {
  private readonly logger = new Logger(ConversationReflectionService.name);

  constructor(
    @Optional() @Inject(LLM_SERVICE) private readonly llm: ILlmService | null,
    private readonly timescale: TimescaleService,
    private readonly neo4j: Neo4jService,
    @Inject(LEARNING_EVENT_LOGGER) private readonly eventLogger: ILearningEventLogger,
  ) {}

  // ---------------------------------------------------------------------------
  // Schema
  // ---------------------------------------------------------------------------

  async ensureSchema(): Promise<void> {
    try {
      await this.timescale.query(`
        CREATE TABLE IF NOT EXISTS reflected_sessions (
          session_id TEXT PRIMARY KEY,
          reflected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          insights_created INTEGER NOT NULL DEFAULT 0,
          edges_created INTEGER NOT NULL DEFAULT 0
        )
      `);
      this.logger.debug('ensureSchema: reflected_sessions table ready');
    } catch (err) {
      this.logger.error(
        `ensureSchema failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // IConversationReflectionService
  // ---------------------------------------------------------------------------

  async findReflectableSessions(): Promise<SessionCandidate[]> {
    const quietThresholdSec = Math.floor(SESSION_QUIET_THRESHOLD_MS / 1000);

    try {
      const result = await this.timescale.query<{
        session_id: string;
        last_event_at: Date;
        event_count: string; // COUNT returns bigint → string in pg
      }>(
        `SELECT e.session_id,
                MAX(e.timestamp) AS last_event_at,
                COUNT(*)         AS event_count
         FROM events e
         WHERE e.session_id != 'learning-internal'
           AND NOT EXISTS (
             SELECT 1 FROM reflected_sessions rs
             WHERE rs.session_id = e.session_id
           )
         GROUP BY e.session_id
         HAVING MAX(e.timestamp) < NOW() - INTERVAL '${quietThresholdSec} seconds'
            AND COUNT(*) >= $1
         ORDER BY MAX(e.timestamp) ASC
         LIMIT 1`,
        [MIN_EVENTS_FOR_REFLECTION],
      );

      return result.rows.map((row) => ({
        sessionId: row.session_id,
        lastEventAt: new Date(row.last_event_at),
        eventCount: parseInt(row.event_count, 10),
      }));
    } catch (err) {
      this.logger.warn(
        `findReflectableSessions failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }
  }

  async reflectOnSession(sessionId: string): Promise<ReflectionResult> {
    const noopResult: ReflectionResult = {
      sessionId,
      insightsCreated: 0,
      edgesCreated: 0,
      wasNoop: true,
    };

    // Emit REFLECTION_CYCLE_STARTED.
    this.eventLogger.log('REFLECTION_CYCLE_STARTED', { sessionId }, sessionId);

    // 1. Gather all events for this session.
    const events = await this.gatherSessionEvents(sessionId);
    if (events.length === 0) {
      this.logger.debug(`reflectOnSession: no events for session ${sessionId}`);
      await this.markSessionReflected(sessionId, 0, 0);
      return noopResult;
    }

    // 2. Check LLM availability — do NOT mark as reflected if unavailable,
    //    so the system retries when LLM comes back.
    if (!this.llm || !this.llm.isAvailable()) {
      this.logger.debug('reflectOnSession: LLM unavailable, skipping');
      return noopResult;
    }

    // 3. Gather known entities for this session from WKG.
    const knownEntities = await this.gatherSessionEntities(sessionId);

    // 4. Build prompt and call LLM.
    const prompt = buildReflectionPrompt(events, knownEntities);
    const correlationId = `reflection-${randomUUID().substring(0, 8)}`;

    const request: LlmRequest = {
      messages: [{ role: 'user', content: prompt }],
      systemPrompt: SYSTEM_PROMPT,
      maxTokens: 1536,
      temperature: 0.3,
      metadata: {
        callerSubsystem: 'LEARNING',
        purpose: 'CONVERSATION_REFLECTION',
        sessionId,
        correlationId,
      },
    };

    let responseContent: string;
    try {
      const response = await this.llm.complete(request);
      responseContent = response.content;
    } catch (err) {
      this.logger.warn(
        `reflectOnSession: LLM call failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // Mark reflected to avoid retrying a session that causes LLM errors.
      await this.markSessionReflected(sessionId, 0, 0);
      return noopResult;
    }

    // 5. Parse insights from LLM response.
    const insights = parseReflectionResponse(responseContent);

    if (insights.length === 0) {
      this.logger.debug(
        `reflectOnSession: LLM returned no parseable insights for ${sessionId}`,
      );
      await this.markSessionReflected(sessionId, 0, 0);
      return { sessionId, insightsCreated: 0, edgesCreated: 0, wasNoop: false };
    }

    // 6. Persist each insight to WKG.
    let totalInsights = 0;
    let totalEdges = 0;

    for (const insight of insights) {
      try {
        const { nodeId, edgesCreated } = await this.persistInsight(insight, sessionId);
        if (nodeId) {
          totalInsights++;
          totalEdges += edgesCreated;

          this.eventLogger.log(
            'REFLECTION_INSIGHT_CREATED',
            {
              insightNodeId: nodeId,
              insightType: insight.insightType,
              confidence: insight.confidence,
              entitiesReferenced: insight.referencedEntities.length,
              edgesCreated,
            },
            sessionId,
          );
        }
      } catch (err) {
        this.logger.warn(
          `persistInsight failed for ${insight.insightType}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        // Continue with remaining insights.
      }
    }

    // 7. Mark session as reflected.
    await this.markSessionReflected(sessionId, totalInsights, totalEdges);

    // Emit REFLECTION_CYCLE_COMPLETED.
    this.eventLogger.log(
      'REFLECTION_CYCLE_COMPLETED',
      {
        sessionId,
        insightsCreated: totalInsights,
        edgesCreated: totalEdges,
        insightsParsed: insights.length,
      },
      sessionId,
    );

    this.logger.log(
      `Reflection complete for ${sessionId}: ${totalInsights} insights, ${totalEdges} edges`,
    );

    return {
      sessionId,
      insightsCreated: totalInsights,
      edgesCreated: totalEdges,
      wasNoop: false,
    };
  }

  // ---------------------------------------------------------------------------
  // Private: data gathering
  // ---------------------------------------------------------------------------

  /**
   * Fetch all events for a session from TimescaleDB, ordered chronologically.
   */
  private async gatherSessionEvents(
    sessionId: string,
  ): Promise<SessionEvent[]> {
    try {
      const result = await this.timescale.query<{
        id: string;
        type: string;
        timestamp: Date;
        subsystem: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT id, type, timestamp, subsystem, payload
         FROM events
         WHERE session_id = $1
         ORDER BY timestamp ASC`,
        [sessionId],
      );

      return result.rows.map((row) => ({
        id: row.id,
        type: row.type,
        timestamp: new Date(row.timestamp),
        subsystem: row.subsystem,
        content: extractContent(row.type, row.payload),
      }));
    } catch (err) {
      this.logger.warn(
        `gatherSessionEvents failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }
  }

  /**
   * Query WKG for entity labels already extracted from this session's
   * Conversation nodes. Provides the LLM with knowledge of what's already
   * in the graph.
   */
  private async gatherSessionEntities(sessionId: string): Promise<string[]> {
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'READ');
    try {
      const result = await session.run(
        `MATCH (c:Conversation {session_id: $sessionId})-[:MENTIONS]->(e)
         RETURN DISTINCT e.label AS label`,
        { sessionId },
      );
      return result.records.map((r) => r.get('label') as string);
    } catch (err) {
      this.logger.warn(
        `gatherSessionEntities failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    } finally {
      await session.close();
    }
  }

  // ---------------------------------------------------------------------------
  // Private: WKG persistence
  // ---------------------------------------------------------------------------

  /**
   * Create an Insight node, DERIVED_FROM edges to Conversation nodes,
   * REVEALS edges to referenced Entity nodes, and any discovered entity edges.
   */
  private async persistInsight(
    insight: ReflectionInsight,
    sessionId: string,
  ): Promise<{ nodeId: string; edgesCreated: number }> {
    const nodeId = `insight-${randomUUID().substring(0, 8)}`;
    const label = `${insight.insightType.toLowerCase()}: ${insight.description.substring(0, 60)}`;
    let edgesCreated = 0;

    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');
    try {
      // Create Insight node.
      await session.run(
        `CREATE (i:Insight {
           node_id:         $nodeId,
           label:           $label,
           node_type:       'Insight',
           insight_type:    $insightType,
           description:     $description,
           session_id:      $sessionId,
           schema_level:    'instance',
           provenance_type: $provenance,
           confidence:      $confidence,
           created_at:      datetime()
         })`,
        {
          nodeId,
          label,
          insightType: insight.insightType,
          description: insight.description,
          sessionId,
          provenance: REFLECTION_PROVENANCE,
          confidence: REFLECTION_CONFIDENCE,
        },
      );

      // DERIVED_FROM edges: Insight → all Conversation nodes in this session.
      await session.run(
        `MATCH (i:Insight {node_id: $insightId}), (c:Conversation {session_id: $sessionId})
         MERGE (i)-[r:DERIVED_FROM]->(c)
         ON CREATE SET
           r.provenance_type = $provenance,
           r.created_at      = datetime()`,
        {
          insightId: nodeId,
          sessionId,
          provenance: REFLECTION_PROVENANCE,
        },
      );

      // REVEALS edges: Insight → each referenced Entity (case-insensitive match).
      for (const entityLabel of insight.referencedEntities) {
        try {
          const revealResult = await session.run(
            `MATCH (i:Insight {node_id: $insightId}), (e)
             WHERE toLower(e.label) = toLower($entityLabel)
               AND e.node_type = 'Entity'
             MERGE (i)-[r:REVEALS]->(e)
             ON CREATE SET
               r.provenance_type = $provenance,
               r.confidence      = $confidence,
               r.created_at      = datetime()
             RETURN COUNT(r) AS cnt`,
            {
              insightId: nodeId,
              entityLabel,
              provenance: REFLECTION_PROVENANCE,
              confidence: REFLECTION_CONFIDENCE,
            },
          );
          const cnt = revealResult.records[0]?.get('cnt');
          if (cnt && (typeof cnt === 'number' ? cnt : cnt.toNumber()) > 0) {
            edgesCreated++;
          }
        } catch {
          // Non-critical — continue with remaining entities.
        }
      }

      // Discovered entity edge (if suggested by LLM).
      if (insight.suggestedEdge) {
        const created = await this.writeDiscoveredEdge(
          session,
          insight.suggestedEdge,
        );
        if (created) edgesCreated++;
      }
    } finally {
      await session.close();
    }

    return { nodeId, edgesCreated };
  }

  /**
   * Create a typed edge between two entities discovered during reflection.
   * Uses case-insensitive label matching. Returns true if the edge was created.
   */
  private async writeDiscoveredEdge(
    session: ReturnType<Neo4jService['getSession']>,
    edge: { readonly source: string; readonly target: string; readonly relType: string },
  ): Promise<boolean> {
    if (!VALID_EDGE_TYPES.has(edge.relType)) return false;

    const sanitized = edge.relType.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();

    try {
      const result = await session.run(
        `MATCH (a), (b)
         WHERE toLower(a.label) = toLower($sourceLabel)
           AND toLower(b.label) = toLower($targetLabel)
           AND a.node_type = 'Entity'
           AND b.node_type = 'Entity'
         MERGE (a)-[r:${sanitized}]->(b)
         ON CREATE SET
           r.confidence      = $confidence,
           r.provenance_type = $provenance,
           r.discovered_by   = 'REFLECTION',
           r.created_at      = datetime()
         ON MATCH SET
           r.confidence = CASE WHEN $confidence > r.confidence
                               THEN $confidence
                               ELSE r.confidence END,
           r.updated_at = datetime()
         RETURN COUNT(r) AS cnt`,
        {
          sourceLabel: edge.source,
          targetLabel: edge.target,
          confidence: REFLECTION_CONFIDENCE,
          provenance: REFLECTION_PROVENANCE,
        },
      );
      const cnt = result.records[0]?.get('cnt');
      return cnt != null && (typeof cnt === 'number' ? cnt : cnt.toNumber()) > 0;
    } catch (err) {
      this.logger.warn(
        `writeDiscoveredEdge failed (${edge.source} -[${edge.relType}]-> ${edge.target}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: session tracking
  // ---------------------------------------------------------------------------

  private async markSessionReflected(
    sessionId: string,
    insightsCreated: number,
    edgesCreated: number,
  ): Promise<void> {
    try {
      await this.timescale.query(
        `INSERT INTO reflected_sessions (session_id, reflected_at, insights_created, edges_created)
         VALUES ($1, NOW(), $2, $3)
         ON CONFLICT (session_id) DO UPDATE SET
           reflected_at     = NOW(),
           insights_created = $2,
           edges_created    = $3`,
        [sessionId, insightsCreated, edgesCreated],
      );
    } catch (err) {
      this.logger.warn(
        `markSessionReflected failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SessionEvent {
  readonly id: string;
  readonly type: string;
  readonly timestamp: Date;
  readonly subsystem: string;
  readonly content: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  'You are a conversation analyst for a cognitive AI system. Your task is to',
  'analyze a completed conversation holistically — looking at the entire exchange',
  'as a narrative unit to extract insights that no single message could reveal.',
  '',
  'You must identify insights in these categories:',
  '- DELAYED_REALIZATION: connections between statements that were temporally distant',
  '- MISSED_CONNECTION: entities or situations that appear separate but are actually related',
  '- IMPLICIT_INSTRUCTION: unstated preferences, directions, or expectations revealed by context',
  '- CONTRADICTION: statements that conflict when viewed together',
  '- THEMATIC_THREAD: recurring themes that reveal deeper patterns',
  '- TONAL_SHIFT: changes in how someone discusses a topic over the course of the conversation',
  '',
  'For each insight, respond with exactly this format (one block per insight):',
  'INSIGHT: <TYPE> | <confidence 0.0-1.0> | <description>',
  'ENTITIES: <comma-separated entity names referenced>',
  'EDGE: <source> -> <target> | <RELATIONSHIP_TYPE>',
  '',
  'If an insight does not suggest a specific relationship edge, write:',
  'EDGE: none',
  '',
  'Valid relationship types: LIKES, DISLIKES, KNOWS, WORKS_AT, LIVES_AT, OWNS,',
  'USES, CREATED, BELONGS_TO, IS_PART_OF, IS_TYPE_OF, LOCATED_IN, HAS_PROPERTY,',
  'CAUSED_BY, LED_TO, CONTRADICTS, RELATED_TO.',
  '',
  'Only report insights you are genuinely confident about. Quality over quantity.',
  'Do not invent connections that are not supported by the conversation.',
].join('\n');

/**
 * Build the user prompt from session events and known entities.
 * Caps total content at MAX_CONVERSATION_CHARS.
 */
function buildReflectionPrompt(
  events: SessionEvent[],
  knownEntities: string[],
): string {
  // Format each event as a timeline entry.
  const lines: string[] = [];
  let charBudget = MAX_CONVERSATION_CHARS;

  for (const event of events) {
    if (charBudget <= 0) break;

    const time = event.timestamp.toISOString().substring(11, 19); // HH:MM:SS
    const role = resolveRole(event.type, event.subsystem);
    const content = event.content || `[${event.type}]`;
    const line = `[${time}] (${role}) ${content}`;

    if (line.length <= charBudget) {
      lines.push(line);
      charBudget -= line.length;
    } else {
      // Truncate to fit remaining budget.
      lines.push(line.substring(0, charBudget) + '...');
      charBudget = 0;
    }
  }

  const duration = events.length >= 2
    ? describeDuration(events[0].timestamp, events[events.length - 1].timestamp)
    : 'unknown duration';

  const entitySection = knownEntities.length > 0
    ? `\nKnown entities already in the knowledge graph for this session:\n${knownEntities.join(', ')}`
    : '';

  return [
    `Analyze the following completed conversation for holistic insights.`,
    `The conversation had ${events.length} events over ${duration}.`,
    '',
    'Conversation timeline:',
    ...lines,
    entitySection,
  ].join('\n');
}

/**
 * Parse the LLM response into structured ReflectionInsight objects.
 * Groups consecutive INSIGHT/ENTITIES/EDGE lines into insight blocks.
 */
function parseReflectionResponse(content: string): ReflectionInsight[] {
  const insights: ReflectionInsight[] = [];
  const lines = content.split('\n').map((l) => l.trim());

  let i = 0;
  while (i < lines.length && insights.length < MAX_INSIGHTS_PER_SESSION) {
    const insightMatch = INSIGHT_LINE_RE.exec(lines[i]);
    if (!insightMatch) {
      i++;
      continue;
    }

    const [, rawType, rawConf, description] = insightMatch;
    const insightType = rawType as InsightType;
    const confidence = Math.min(parseFloat(rawConf) || 0.5, 1.0);

    // Look ahead for ENTITIES and EDGE lines.
    let referencedEntities: string[] = [];
    let suggestedEdge: ReflectionInsight['suggestedEdge'] = null;

    // Check next line for ENTITIES.
    if (i + 1 < lines.length) {
      const entMatch = ENTITIES_LINE_RE.exec(lines[i + 1]);
      if (entMatch) {
        referencedEntities = entMatch[1]
          .split(',')
          .map((e) => e.trim())
          .filter((e) => e.length > 0);
        i++;
      }
    }

    // Check next line for EDGE.
    if (i + 1 < lines.length) {
      const edgeMatch = EDGE_LINE_RE.exec(lines[i + 1]);
      if (edgeMatch) {
        const [, source, target, relType] = edgeMatch;
        if (VALID_EDGE_TYPES.has(relType)) {
          suggestedEdge = {
            source: source.trim(),
            target: target.trim(),
            relType,
          };
        }
        i++;
      } else if (lines[i + 1].toLowerCase().startsWith('edge: none')) {
        i++; // Skip the "EDGE: none" line.
      }
    }

    insights.push({
      insightType,
      description: description.trim(),
      confidence,
      referencedEntities,
      suggestedEdge,
    });

    i++;
  }

  return insights;
}

/**
 * Extract readable content from an event's payload based on its type.
 */
function extractContent(
  eventType: string,
  payload: Record<string, unknown>,
): string {
  if (typeof payload['content'] === 'string') return payload['content'];
  if (typeof payload['text'] === 'string') return payload['text'];
  if (typeof payload['response_text'] === 'string') return payload['response_text'];
  // For INPUT_PARSED, try to reconstruct from entities.
  if (eventType === 'INPUT_PARSED' && Array.isArray(payload['entities'])) {
    return `[entities: ${(payload['entities'] as string[]).join(', ')}]`;
  }
  return '';
}

/**
 * Map event type / subsystem to a human-readable role for the prompt.
 */
function resolveRole(eventType: string, subsystem: string): string {
  switch (eventType) {
    case 'INPUT_RECEIVED':
    case 'INPUT_PARSED':
    case 'CHAT_INPUT_RECEIVED':
      return 'GUARDIAN';
    case 'RESPONSE_GENERATED':
    case 'RESPONSE_DELIVERED':
    case 'CHAT_RESPONSE_SENT':
    case 'SOCIAL_COMMENT_INITIATED':
      return 'SYLPHIE';
    case 'GUARDIAN_CORRECTION':
      return 'GUARDIAN_CORRECTION';
    case 'GUARDIAN_CONFIRMATION':
      return 'GUARDIAN_CONFIRMATION';
    case 'GUARDIAN_TEACHING_DETECTED':
      return 'GUARDIAN_TEACHING';
    default:
      return subsystem;
  }
}

/**
 * Describe duration between two timestamps in human-readable form.
 */
function describeDuration(start: Date, end: Date): string {
  const diffMs = end.getTime() - start.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'less than a minute';
  if (mins === 1) return '1 minute';
  if (mins < 60) return `${mins} minutes`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}
