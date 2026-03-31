# Learning Agent Analysis: Epic 7 -- The Consolidation Pipeline

**Agent:** Learning (Learning Subsystem Engineer)
**Epic:** 7 -- Learning (Consolidation Pipeline)
**Date:** 2026-03-29
**Status:** Comprehensive Technical Analysis for Planning

---

## Executive Summary

Epic 7 implements the consolidation pipeline — the subsystem that converts raw experience into durable knowledge. It is the mechanism by which the World Knowledge Graph grows beyond what the LLM generates, and by which Sylphie transitions from memorized patterns to learned procedures.

The architecture is driven by **Cognitive Awareness pressure**: when Sylphie's understanding capacity is saturated (high Cognitive Awareness drive), maintenance cycles trigger to consolidate recent experience. A timer fallback ensures cycles run even during low-pressure periods.

**Critical architectural principle:** Learning is NOT about perfection — contradictions are catalysts (Piagetian disequilibrium), not errors to suppress. The graph grows asymmetrically, driven by what fails predictions and what the guardian corrects.

**Five key components emerge from the architecture:**

1. **Maintenance Cycle Orchestrator** — Pressure-driven trigger with timer fallback; enforces max 5 learnable events/cycle
2. **Event Consolidation** — QueryTimescaleDB for events marked `has_learnable=true`, rank by recency/impact
3. **Entity Extraction** — LLM-assisted identification of entities and relationships from raw events
4. **Edge Refinement** — LLM-assisted relationship identification with explicit confidence tracking
5. **Contradiction Detection** — Flag conflicts as developmental catalysts, not suppressible errors

**Ported from v1:**
- All 7 maintenance jobs (TemporalPatternJob, ProcedureFormationJob, PatternGeneralizationJob, etc.)
- Consolidation engine architecture (pressure-driven orchestrator)
- Metacognitive analyzer (LLM refinement patterns)

**Entirely new in v2:**
- Provenance discipline (every edge carries LLM_GENERATED at 0.35 base)
- Confidence ceiling enforcement (no node >0.60 without retrieval)
- Contradiction flagging (vs. silent suppression)
- Max 5 events/cycle (catastrophic interference prevention)
- Explicit has_learnable event filtering

**Critical findings from this analysis:**

- The v1 jobs were designed as **reactive** processors (triggered on events). In v2, they become **episodic** processors (triggered on maintenance cycles). This changes their interaction model with the consolidation engine.
- The LLM's role must be **scoped precisely**: entity extraction and relationship identification only. The LLM cannot propose confidence updates, cannot declare something "learned," cannot suppress contradictions.
- v1 had no explicit provenance tracking. v2 must tag every extracted edge with `LLM_GENERATED` at 0.35 base. This lowers the confidence floor for all extracted knowledge — a deliberate design choice to prevent hallucination cascade.
- Temporal pattern detection (TemporalPatternJob) is the **highest-confidence learnable output** because it detects genuine regularities. Procedure formation depends on temporal patterns. This job should run first.
- Contradiction detection must emit events to TimescaleDB for observation, not suppress or resolve them. They are raw material for the Planning subsystem (when a procedure fails, that's a contradiction to investigate).
- The max-5-per-cycle constraint is critical: learning from more than 5 complex experiences in a single cycle causes catastrophic interference. This is a hard floor, not a guideline.

---

## 1. Component Breakdown & File Structure

### 1.1 Directory Structure

All files live in `src/learning/` following the E0 scaffold:

```
src/learning/
├── learning.module.ts                   (module config, DI setup)
├── learning.service.ts                  (main orchestrator service)
├── learning.tokens.ts                   (DI tokens)
│
├── consolidation/
│   ├── consolidation.service.ts         (Event query, max-5 enforcement, ranking)
│   ├── consolidation.types.ts           (LearnableEvent, ConsolidationBatch, ConsolidationMetrics)
│   ├── event-ranker.service.ts          (Recency, impact, novelty scoring)
│   └── index.ts
│
├── extraction/
│   ├── entity-extraction.service.ts     (LLM-assisted entity identification)
│   ├── edge-refinement.service.ts       (LLM-assisted relationship identification)
│   ├── extraction.types.ts              (ExtractedEntity, RefinedEdge, ExtractionContext)
│   ├── llm-extraction-prompt.ts         (Curated prompts for LLM)
│   └── index.ts
│
├── contradiction/
│   ├── contradiction-detector.service.ts (Conflict detection, flagging)
│   ├── contradiction.types.ts            (Contradiction, ContradictionSeverity)
│   └── index.ts
│
├── jobs/
│   ├── temporal-pattern.job.ts          (RESPONSE_TO edge creation from phrase patterns)
│   ├── procedure-formation.job.ts       (Cluster actions, propose ActionProcedures)
│   ├── pattern-generalization.job.ts    (Sibling phrase clusters, propose ConceptPrimitives)
│   ├── correction-processing.job.ts     (Process SUPERSEDES, create CORRECTED_BY, penalize)
│   ├── sentence-splitting.job.ts        (v1 ported: Split phrase nodes)
│   ├── sentence-structure.job.ts        (v1 ported: Build template slots, TRIGGERS edges)
│   ├── symbolic-decomposition.job.ts    (v1 ported: Delegate to sub-services)
│   ├── job.interface.ts                 (IMaintenanceJob interface)
│   ├── job-runner.service.ts            (Execute jobs in sequence/parallel)
│   └── index.ts
│
├── interfaces/
│   ├── learning.interfaces.ts           (ILearningService, IMaintenanceCycle)
│   ├── consolidation.interfaces.ts      (IConsolidationService, IEventRanker)
│   ├── extraction.interfaces.ts         (IEntityExtractionService, IEdgeRefinementService)
│   ├── contradiction.interfaces.ts      (IContradictionDetector)
│   └── index.ts
│
└── index.ts (barrel export)
```

### 1.2 Service Dependencies & Injection

**Learning Module imports:**
- `EventsModule` → IEventService (query, mark learnable as processed)
- `KnowledgeModule` → IWkgService (upsert entities/edges), IConfidenceService (ceiling checks)
- `CommunicationModule` → ILlmService (entity/edge refinement)
- `DriveEngineModule` → IDriveStateReader (Cognitive Awareness pressure)
- `SharedModule` → Config, types, pure functions

**DI tokens (learning.tokens.ts):**

```typescript
export const LEARNING_SERVICE = Symbol('ILearningService');
export const CONSOLIDATION_SERVICE = Symbol('IConsolidationService');
export const EVENT_RANKER = Symbol('IEventRanker');
export const ENTITY_EXTRACTION_SERVICE = Symbol('IEntityExtractionService');
export const EDGE_REFINEMENT_SERVICE = Symbol('IEdgeRefinementService');
export const CONTRADICTION_DETECTOR = Symbol('IContradictionDetector');
export const JOB_RUNNER = Symbol('IJobRunner');
export const TEMPORAL_PATTERN_JOB = Symbol('IMaintenanceJob:TemporalPattern');
export const PROCEDURE_FORMATION_JOB = Symbol('IMaintenanceJob:ProcedureFormation');
export const PATTERN_GENERALIZATION_JOB = Symbol('IMaintenanceJob:PatternGeneralization');
export const CORRECTION_PROCESSING_JOB = Symbol('IMaintenanceJob:CorrectionProcessing');
export const SENTENCE_SPLITTING_JOB = Symbol('IMaintenanceJob:SentenceSplitting');
export const SENTENCE_STRUCTURE_JOB = Symbol('IMaintenanceJob:SentenceStructure');
export const SYMBOLIC_DECOMPOSITION_JOB = Symbol('IMaintenanceJob:SymbolicDecomposition');
```

---

## 2. Maintenance Cycle Orchestration

### 2.1 Pressure-Driven Trigger with Timer Fallback

The `LearningService.runMaintenanceCycle()` method is the entry point. It executes on two timescales:

**Primary trigger: Cognitive Awareness Pressure**
- Queries `IDriveStateReader.getCurrentState()` to read Cognitive Awareness value
- When Cognitive Awareness exceeds configurable threshold (recommend 0.65+), **immediately** triggers a maintenance cycle
- Cognitive Awareness represents "I have accumulated too many unprocessed experiences"

**Secondary trigger: Timer Fallback**
- If no maintenance cycle triggered by pressure for `N` seconds (recommend 30-60s), trigger cycle regardless of pressure
- Prevents knowledge starvation even during periods of low cognitive load
- Ensures predictable learning cadence for dashboard telemetry

**Cycle throttling:**
- Enforce minimum time between cycles (recommend 5s) to prevent thrashing
- If a cycle is in progress when pressure triggers again, queue the next cycle (max 1 queued)

**Implementation pattern:**

```typescript
class LearningService implements ILearningService {
  private lastCycleAt: number = Date.now();
  private nextCycleScheduled: boolean = false;
  private cycleInProgress: boolean = false;

  async runMaintenanceCycle(): Promise<MaintenanceCycleResult> {
    if (this.cycleInProgress) {
      this.nextCycleScheduled = true;
      return { status: 'QUEUED', learnableCount: 0 };
    }

    this.cycleInProgress = true;
    try {
      const batch = await this.consolidationService.getBatch(5);
      if (batch.events.length === 0) {
        return { status: 'NO_EVENTS', learnableCount: 0 };
      }

      // Execute consolidation pipeline
      const result = await this.executePipeline(batch);

      this.lastCycleAt = Date.now();

      // Emit MAINTENANCE_CYCLE event to TimescaleDB
      await this.eventsService.record({
        type: 'MAINTENANCE_CYCLE',
        subsystem: 'LEARNING',
        data: {
          learnableCount: batch.events.length,
          entitiesExtracted: result.entitiesCreated,
          edgesRefined: result.edgesRefined,
          contradictionsDetected: result.contradictions.length,
          jobResults: result.jobResults
        }
      });

      return result;
    } finally {
      this.cycleInProgress = false;
      if (this.nextCycleScheduled) {
        this.nextCycleScheduled = false;
        // Schedule next cycle asynchronously
        setImmediate(() => this.runMaintenanceCycle());
      }
    }
  }

  shouldConsolidate(): boolean {
    const timeSinceLastCycle = Date.now() - this.lastCycleAt;
    const cognitiveAwareness = this.driveReader.getCurrentState().drives.CognitiveAwareness;

    // Pressure-driven
    if (cognitiveAwareness > 0.65) return true;

    // Timer fallback (30s)
    if (timeSinceLastCycle > 30000) return true;

    return false;
  }
}
```

### 2.2 Maintenance Cycle Anatomy

A single cycle follows this sequence:

1. **Consolidation**: Query TimescaleDB for up to 5 learnable events
2. **Ranking**: Score events by recency, impact, novelty
3. **Extraction**: LLM extracts entities and relationships
4. **Contradiction Detection**: Check for conflicts with existing knowledge
5. **Job Execution**: Run all 7 maintenance jobs in order
6. **Result Emission**: Record metrics to TimescaleDB and update WKG

**Why jobs run AFTER extraction**: Jobs may use the newly extracted entities as context for their own graph traversals.

---

## 3. Event Consolidation: The Max-5 Constraint

### 3.1 Why Max 5?

Catastrophic interference in neural systems (and graph-based systems) occurs when too much diverse information is consolidated in a single episode. The constraint is not optional — it is architectural.

**Recommendation:** Research suggests 5 events per cycle is an empirically valid floor. This allows consolidation of moderately complex experiences without interference.

**Enforcement:**

```typescript
class ConsolidationService implements IConsolidationService {
  async getBatch(maxEvents: number = 5): Promise<ConsolidationBatch> {
    const events = await this.eventsService.queryLearnableEvents({
      limit: maxEvents,
      hasBeenProcessed: false,
      orderBy: 'RECENCY'
    });

    // HARD FLOOR: never exceed maxEvents
    if (events.length > maxEvents) {
      this.logger.warn(`Query returned ${events.length} events, truncating to ${maxEvents}`);
      events.length = maxEvents;
    }

    // Score events for ranking
    const scored = events.map(e => ({
      event: e,
      score: this.eventRanker.scoreEvent(e)
    }));

    scored.sort((a, b) => b.score - a.score);

    return {
      events: scored.slice(0, maxEvents).map(s => s.event),
      totalAvailable: events.length,
      batchSize: scored.length
    };
  }
}
```

### 3.2 Event Selection and Ranking

Events are ranked by:

1. **Recency** (weight: 0.3): Recent events have higher priority (decay by time)
2. **Impact** (weight: 0.4): Events with prediction failures, guardian corrections, or novel entities score higher
3. **Novelty** (weight: 0.3): Events that reference unfamiliar entities or relationship types score higher

**Rationale for impact weighting:** The Learning subsystem's job is to improve the world model by learning from surprising outcomes and guardian guidance. Confirming something already known is lower priority than investigating a failed prediction.

---

## 4. Entity Extraction: LLM-Assisted, Provenance-Tracked

### 4.1 Extraction Interface

The LLM's role in learning is **scoped tightly**: extract entities and relationships from natural language events. The LLM cannot decide confidence, cannot evaluate learning success, cannot suppress contradictions.

```typescript
interface IEntityExtractionService {
  extract(event: LearnableEvent, context: ExtractionContext): Promise<ExtractedEntity[]>;
}

interface ExtractedEntity {
  label: string;                    // "Jim", "mug", "kitchen"
  type: string;                      // "PERSON", "OBJECT", "LOCATION"
  confidence: number;                // 0.0-1.0 (confidence in extraction, not in world model)
  provenanceHint: string;            // Raw text from event that prompted extraction
  properties?: Map<string, unknown>;  // e.g., { color: 'blue', size: 'large' }
}

interface ExtractionContext {
  existingEntities: Map<string, WKGNode>;  // Already-known entities for disambiguation
  recentEvents: LearnableEvent[];          // Context for coreference resolution
  personModel?: PersonKG;                   // Guardian model for "Jim" disambiguation
  recentEdges: KnowledgeEdge[];           // What relationships were recently created?
}
```

### 4.2 LLM Extraction Prompt

The prompt must be **deterministic** and **constrained**:

```
You are analyzing a recent conversation or action event to extract entities and relationships.

CONTEXT:
{event_text}

KNOWN_ENTITIES (avoid duplicate extraction):
{existing_entities_json}

TASK:
1. Extract NEW entities mentioned that are NOT in KNOWN_ENTITIES
2. For each entity, classify type (PERSON, OBJECT, LOCATION, ACTION, PROPERTY, PROCEDURE, ABSTRACT_CONCEPT)
3. Output as JSON array

CONSTRAINTS:
- Do NOT infer confidence scores
- Do NOT decide if something "counts" as learned
- Do NOT suppress contradictions
- Do NOT create relationships yet (that's edge refinement)
- Keep entity labels concise (1-3 words)

OUTPUT:
[
  { "label": "entity_name", "type": "TYPE", "provenanceHint": "text span from event" },
  ...
]
```

**Implementation:**

```typescript
class EntityExtractionService implements IEntityExtractionService {
  async extract(
    event: LearnableEvent,
    context: ExtractionContext
  ): Promise<ExtractedEntity[]> {
    const prompt = this.buildExtractionPrompt(event, context);

    const response = await this.llmService.complete({
      prompt,
      maxTokens: 500,
      temperature: 0.3,  // Low temperature for consistency
      model: 'claude-3-5-sonnet-20241022'
    });

    const parsed = JSON.parse(response.text);

    // Validate output shape
    const entities: ExtractedEntity[] = parsed
      .filter(e => e.label && e.type)
      .map(e => ({
        label: e.label,
        type: e.type,
        confidence: 0.5,  // Extraction confidence, not world model confidence
        provenanceHint: e.provenanceHint
      }));

    return entities;
  }
}
```

---

## 5. Edge Refinement: LLM-Assisted Relationship Identification

### 5.1 Refinement Interface

Once entities are extracted, the LLM identifies relationships between them:

```typescript
interface IEdgeRefinementService {
  refine(
    entities: ExtractedEntity[],
    event: LearnableEvent,
    context: ExtractionContext
  ): Promise<RefinedEdge[]>;
}

interface RefinedEdge {
  source: string;           // Entity label or WKG node ID
  target: string;           // Entity label or WKG node ID
  relationship: string;     // Edge type: "CAN_PRODUCE", "TRIGGERS", "INVOLVES", custom...
  confidence: number;       // Confidence in the relationship existing (0.0-1.0)
  evidence: string;         // Direct quote or description from event
  llmReasoning?: string;    // Optional: why LLM chose this edge
}
```

### 5.2 Edge Refinement Prompt

```
You are identifying relationships between entities extracted from an event.

ENTITIES:
{entities_json}

EVENT_CONTEXT:
{event_text}

EXISTING_RELATIONSHIPS (avoid suggesting duplicates):
{existing_edges_json}

TASK:
1. For each pair of entities, identify if a relationship exists
2. Choose relationship type from: CAN_PRODUCE, RESPONSE_TO, TRIGGERS, INVOLVED_IN, CAUSES, PREVENTS, IS_A, PROPERTY_OF
3. Cite evidence: exact phrase or action demonstrating the relationship

OUTPUT:
[
  { "source": "entity1", "target": "entity2", "relationship": "TYPE", "evidence": "text span" },
  ...
]

CONSTRAINTS:
- Do NOT assign confidence scores
- Relationships must be grounded in the event (no inference)
- Only suggest relationships you are confident appear in the context
```

**Implementation:**

```typescript
class EdgeRefinementService implements IEdgeRefinementService {
  async refine(
    entities: ExtractedEntity[],
    event: LearnableEvent,
    context: ExtractionContext
  ): Promise<RefinedEdge[]> {
    const prompt = this.buildRefinementPrompt(entities, event, context);

    const response = await this.llmService.complete({
      prompt,
      maxTokens: 800,
      temperature: 0.3
    });

    const parsed = JSON.parse(response.text);

    const edges: RefinedEdge[] = parsed
      .filter(e => e.source && e.target && e.relationship)
      .map(e => ({
        source: e.source,
        target: e.target,
        relationship: e.relationship,
        confidence: 0.5,  // Will be clamped or refined by confidence service
        evidence: e.evidence,
        llmReasoning: e.reasoning
      }));

    return edges;
  }
}
```

### 5.3 Critical Design Point: LLM Confidence ≠ World Model Confidence

**The LLM outputs a relationship.** It does NOT assign the confidence value that goes into the WKG.

This is crucial: the LLM says "Jim and the mug are related by CAN_PRODUCE" (extraction). The Knowledge Service then assigns base confidence `LLM_GENERATED: 0.35` to that edge. Over time, if the edge is retrieved and succeeds, confidence increases via ACT-R dynamics. If it fails or is contradicted, confidence decreases or the edge is marked with a CORRECTED_BY edge.

The LLM's role: **precision in extraction, not calibration of confidence.**

---

## 6. Contradiction Detection

### 6.1 Contradiction Detection Service

When upserting a new entity or edge, the Knowledge Service queries for conflicts:

```typescript
interface IContradictionDetector {
  check(
    entity: WKGNode | KnowledgeEdge,
    context: ContraindictionCheckContext
  ): Promise<Contradiction[]>;
}

interface Contradiction {
  type: 'ENTITY_CONFLICT' | 'EDGE_CONFLICT' | 'PROPERTY_CONFLICT';
  severity: 'MINOR' | 'MODERATE' | 'SEVERE';
  existingNode: WKGNode | KnowledgeEdge;
  proposedNode: WKGNode | KnowledgeEdge;
  conflictingProperty?: string;  // e.g., "color" if mug.color changed
  description: string;           // Human-readable conflict description
}
```

### 6.2 Contradiction Handling Policy: Flag, Don't Suppress

**In v1**, contradictions were often silently handled (overwrite, skip, or soft-conflict). **In v2**, contradictions are flagged as events for observation:

```typescript
async upsertNodeDuringLearning(node: WKGNode): Promise<UpsertResult> {
  // Check for contradictions
  const contradictions = await this.contradictionDetector.check(
    node,
    { existingKnowledge: await this.queryConflictingNodes(node) }
  );

  if (contradictions.length > 0) {
    // EMIT CONTRADICTION EVENT (Piagetian disequilibrium)
    for (const contradiction of contradictions) {
      await this.eventsService.record({
        type: 'CONTRADICTION_DETECTED',
        subsystem: 'LEARNING',
        data: {
          contradiction: contradiction,
          proposedNode: node.id,
          existingNode: contradiction.existingNode.id,
          severity: contradiction.severity
        }
      });
    }

    // Do NOT suppress the new knowledge
    // Upsert it with a flag indicating contradiction
    node.metadata.hasContradictions = true;
    node.metadata.contradictionsDetectedAt = new Date();
  }

  // Proceed with upsert regardless of contradiction status
  return this.wkgService.upsertNode(node, {
    provenance: 'LLM_GENERATED',
    baseConfidence: 0.35
  });
}
```

**Why flag instead of suppress?** Contradictions are **developmental catalysts**. When Sylphie's models conflict with reality or guardian feedback, that mismatch drives learning. Suppressing the contradiction suppresses the learning signal.

The Planning subsystem (E8) can then investigate: "Why did procedure X fail? Was there a contradiction in the knowledge that predicted it would succeed?"

---

## 7. Maintenance Jobs: Ported from v1

### 7.1 Job Architecture

All jobs implement a common interface:

```typescript
interface IMaintenanceJob {
  name: string;
  dependencies: string[];  // Job names that must run before this one
  canRun(context: JobExecutionContext): boolean;
  execute(context: JobExecutionContext): Promise<JobResult>;
}

interface JobExecutionContext {
  batch: ConsolidationBatch;
  extractedEntities: ExtractedEntity[];
  refinedEdges: RefinedEdge[];
  contradictions: Contradiction[];
  wkgService: IWkgService;
  eventsService: IEventService;
  llmService: ILlmService;
}

interface JobResult {
  name: string;
  status: 'SUCCESS' | 'SKIPPED' | 'PARTIAL' | 'FAILED';
  created: { entities: number; edges: number };
  updated: { entities: number; edges: number };
  contradictions: number;
  metrics: Record<string, unknown>;
}
```

### 7.2 Job Execution Order

Jobs should run in this order (dependency-aware scheduling):

1. **TemporalPatternJob** — Detects response patterns (A followed by B reliably)
2. **CorrectionalProcessingJob** — Processes guardian corrections (creates CORRECTED_BY edges)
3. **ProcedureFormationJob** — Clusters actions into procedures (requires temporal patterns)
4. **PatternGeneralizationJob** — Generalizes phrase clusters (requires stable procedures)
5. **SentenceSplittingJob** — Splits complex phrase nodes
6. **SentenceStructureJob** — Builds slot-filler templates from phrases
7. **SymbolicDecompositionJob** — Delegates complex decomposition tasks

**Rationale:** Temporal patterns are the **highest-confidence learnable output** (based on actual regularities in the event stream). Build procedures on solid temporal foundations, then generalize.

### 7.3 Job Summaries

#### TemporalPatternJob

**Purpose:** Detect regularities in action sequences. If A reliably precedes B in the event stream, create a RESPONSE_TO edge.

**v1 source:** `maintenance-engine/src/jobs/TemporalPatternJob.ts`

**v2 adaptation:**
- v1 queried a graph of past phrases. v2 should query recent TimescaleDB events for action sequences.
- Window size (recommend 10 recent events) and recency threshold (recommend 3 occurrences in window) are configurable.
- Emit TEMPORAL_PATTERN_FOUND events to TimescaleDB for observability.

**Key code pattern from v1 (to be ported):**
```python
# Pseudocode from v1
for phrase_pair in get_phrase_pairs(confidence > 0.5):
    frequency = count_occurrences(phrase_pair, lookback=10_events)
    if frequency >= 3:
        create_edge(phrase_pair[0], RESPONSE_TO, phrase_pair[1], confidence=0.60)
```

#### CorrectionProcessingJob

**Purpose:** Process guardian corrections from the event stream. When guardian says "no, that's wrong," create a CORRECTED_BY edge and penalize the old edge.

**v1 source:** `maintenance-engine/src/jobs/CorrectionProcessingJob.ts`

**v2 adaptation:**
- Query events of type `GUARDIAN_CORRECTION` from TimescaleDB.
- For each correction: find the edge being corrected (by content matching or explicit reference), create CORRECTED_BY edge to the new knowledge.
- Penalize the old edge: confidence -= 0.15, mark as `has_known_correction=true`.

**Guardian Asymmetry application (Immutable Standard 5):**
- A single guardian correction should trigger **3x weight** in confidence updates.
- Implementation: correction edge base confidence = 0.60 (vs. 0.35 for LLM).

#### ProcedureFormationJob

**Purpose:** Cluster related actions into ActionProcedure nodes. If multiple actions reliably follow the same context, they form a procedure.

**v1 source:** `maintenance-engine/src/jobs/ProcedureFormationJob.ts`

**v2 adaptation:**
- Cluster RESPONSE_TO edges by source node (context). If a context has 2+ reliable targets, consider forming a procedure.
- Use LLM to generalize: "These actions {a1, a2, a3} all follow context {c}. What is the abstract procedure?" → propose ConceptPrimitive or ActionProcedure node.
- Confidence: if all component edges are >0.60, procedure gets 0.60. If mixed, weighted average.

#### PatternGeneralizationJob

**Purpose:** Find sibling phrase clusters and propose abstract concepts. If "red mug", "blue mug", "green mug" are all retrieved successfully, propose ConceptPrimitive "colored mug."

**v1 source:** `maintenance-engine/src/jobs/PatternGeneralizationJob.ts`

**v2 adaptation:**
- Query WKG for nodes with shared properties (e.g., all have PROPERTY_OF relationship to the same parent).
- Use LLM: "What abstract concept unites {node1, node2, node3}?"
- Propose new ConceptPrimitive node with IS_A edges to instances.

#### SentenceSplittingJob

**Purpose:** Split complex phrase nodes into simpler components. E.g., "the blue mug on the table" → "mug", "blue", "on table".

**v1 source:** `maintenance-engine/src/jobs/SentenceSplittingJob.ts`

**v2 adaptation:**
- Use LLM: "Break this phrase into constituent concepts: {phrase}". Output as a sequence.
- Create a new phrase node for each constituent.
- Link with PART_OF edges for compositionality.
- Lower confidence for decomposed nodes (0.40-0.50) since they're inferred from the whole.

#### SentenceStructureJob

**Purpose:** Identify slot-filler patterns in phrases. E.g., "put X in Y" has slots [X=object, Y=location].

**v1 source:** `maintenance-engine/src/jobs/SentenceStructureJob.ts`

**v2 adaptation:**
- Use LLM: "Identify variable slots in this phrase template: {phrase}". E.g., "put [OBJECT] in [LOCATION]".
- Create PATTERN nodes representing slot-filler structures.
- Create TRIGGERS edges from patterns to related actions.
- These patterns enable more sophisticated procedure generalization.

#### SymbolicDecompositionJob

**Purpose:** Delegate complex symbolic tasks (mathematical operations, logic, rule inference) to sub-services.

**v1 source:** `maintenance-engine/src/jobs/SymbolicDecompositionJob.ts`

**v2 adaptation:**
- This job primarily delegates to domain-specific sub-services (math, logic, relational inference).
- Can mostly be ported as-is. In v2, it should be triggered only if there are events explicitly tagged with symbolic content (e.g., "count this", "apply this rule").

---

## 8. v1 Code Lift and Adaptation Strategy

### 8.1 What Can Be Lifted Directly (Minimal Adaptation)

**High-confidence lifts (>80% reusable):**
- `maintenance-engine/src/jobs/CorrectionProcessingJob.ts` — Guardian correction handling is straightforward
- `maintenance-engine/src/jobs/SentenceSplittingJob.ts` — LLM-based splitting is general
- `maintenance-engine/src/jobs/SentenceStructureJob.ts` — Slot identification via LLM is portable

**Adaptation needed:**
- Replace v1's graph query layer with v2's IWkgService calls
- Replace direct Python graph manipulation with TypeScript/NestJS equivalents
- Add provenance tagging (all edges get `LLM_GENERATED: 0.35`)
- Add event emission to TimescaleDB for observability

### 8.2 What Needs Significant Adaptation

**Medium-confidence lifts (50-70% reusable):**
- `maintenance-engine/src/jobs/TemporalPatternJob.ts` — v1 queried graph; v2 must query TimescaleDB events
- `maintenance-engine/src/jobs/ProcedureFormationJob.ts` — v1 clustered static graph nodes; v2 must cluster dynamic events
- `maintenance-engine/src/services/consolidation-engine.service.ts` — Main orchestrator structure is reusable; details change

**Adaptation needed:**
- Rethink data sources: v1 had graph-persisted patterns; v2 has ephemeral events in TimescaleDB
- Add max-5 constraint enforcement
- Add confidence computation (ACT-R) wrapping
- Add Event emission for each job result

### 8.3 What's Entirely New

**No v1 equivalent:**
- **Contradiction detection** — v1 suppressed or soft-handled contradictions. v2 flags them as catalysts.
- **Max-5 enforcement** — v1 had no catastrophic interference constraint.
- **Provenance tagging at scale** — v1 didn't track provenance on extracted knowledge.
- **Pressure-driven orchestration** — v1 had timer-only triggers; v2 is pressure-driven.

---

## 9. Dependency Analysis

### 9.1 E7 Dependencies (from roadmap)

**E7 depends on:**
- **E2 (Events)**: IEventService must support querying learnable events and recording learning results
- **E3 (Knowledge)**: IWkgService must support upsert with provenance, IConfidenceService for ceiling checks
- **E4 (Drive Engine)**: IDriveStateReader must expose Cognitive Awareness for pressure-driven trigger
- **E6 (Communication)**: ILlmService and the communication event stream (communication events mark events with `has_learnable=true`)

**E7 does NOT depend on:**
- E5 (Decision Making) — Learning processes are orthogonal to decision cycles (asynchronous)
- E8 (Planning) — Planning uses learning outputs; not vice versa

### 9.2 Interface Contracts to Clarify

**From E2 (Events):**
```typescript
interface IEventService {
  // Existing
  record(event: SylphieEvent): Promise<void>;
  query(filter: EventQueryFilter): Promise<SylphieEvent[]>;

  // NEW for E7: Query learnable events
  queryLearnableEvents(filter: {
    limit?: number;
    hasBeenProcessed?: boolean;
    subsystems?: SubsystemSource[];
    since?: Date;
  }): Promise<LearnableEvent[]>;

  // Mark an event as processed by learning
  markLearnable(eventId: string, metadata: LearningMetadata): Promise<void>;
}
```

**From E3 (Knowledge):**
```typescript
interface IWkgService {
  // Existing
  upsertNode(node: WKGNode, options: UpsertOptions): Promise<WKGNode>;
  upsertEdge(edge: KnowledgeEdge, options: UpsertOptions): Promise<KnowledgeEdge>;

  // NEW for E7: Contradiction checking
  findConflictingNodes(
    node: WKGNode,
    searchScope: 'PROPERTY' | 'RELATIONSHIP' | 'IDENTITY'
  ): Promise<WKGNode[]>;

  // NEW: Provenance enforcement
  // upsertNode already takes provenance, but E7 needs verification that
  // provenance cannot be omitted and defaults to LLM_GENERATED for extract results
}
```

**From E4 (Drive Engine):**
```typescript
interface IDriveStateReader {
  // Existing
  getCurrentState(): DriveSnapshot;
  driveState$: Observable<DriveSnapshot>;
  getTotalPressure(): number;

  // NEW: Pressure query (convenience method)
  getNamedDrivePressure(driveName: DriveName): number;
}
```

**From E6 (Communication):**
```typescript
// No new contracts. E6 must emit communication events to TimescaleDB
// with has_learnable=true flag for E7 to pick up.
// E7 depends on this event stream being present and well-formed.
```

---

## 10. Architectural Risks & Mitigations

### Risk 1: Hallucinated Knowledge Cascade (MEDIUM)

**Scenario:** LLM extracts an entity that's plausible but false. It gets base confidence 0.35 (LLM_GENERATED). If the guardian never corrects it and it appears in multiple events, its confidence climbs via ACT-R. Eventually false knowledge becomes "part of the world model."

**Mitigation:**
- Enforce Immutable Standard 3: confidence ceiling at 0.60 without retrieval-and-use.
- Flag all LLM_GENERATED knowledge in the WKG UI so guardians can inspect.
- Implement a "knowledge audit" dashboard showing highest-confidence LLM_GENERATED nodes (post-E7, pre-E9).
- Lesion test (E10): periodically disable LLM and see if the system still handles basic situations. Hallucinated knowledge won't help.

### Risk 2: Catastrophic Interference (HIGH if max-5 not enforced)

**Scenario:** Consolidate 50 events at once. They contain contradictory patterns. Temporal pattern detection creates conflicting RESPONSE_TO edges. Procedure formation clusters them inconsistently. The graph becomes locally incoherent.

**Mitigation:**
- **Hard enforcement** of max-5 events per cycle. Make it a fatal error if exceeded.
- Add a monitoring alert: if >5 events somehow make it into a cycle, log CRITICAL and skip that batch.
- Test with synthetic workloads: feed 20 contradictory events in a single cycle, verify learning still produces stable procedures.

### Risk 3: LLM Refusal to Decompose (MEDIUM)

**Scenario:** The LLM extraction prompt asks "Extract entities from: {event}". The LLM responds with "I don't see entities" or generates empty JSON. The cycle silently produces no learning.

**Mitigation:**
- Validate LLM outputs: if empty entity list from a well-formed event, log a warning and skip that event (don't treat as successful consolidation).
- Add a fallback: simple regex-based entity extraction (nouns, capitalized words) if LLM fails.
- Monitor "zero-learning cycles" in telemetry (E9 dashboard) — a surge indicates LLM extraction failure.

### Risk 4: Job Dependency Ordering (MEDIUM)

**Scenario:** ProcedureFormationJob runs before TemporalPatternJob (dependency order wrong). It tries to cluster non-existent patterns. Produces malformed procedures.

**Mitigation:**
- Implement a dependency resolver in JobRunner. Jobs declare dependencies; runner executes in topological order.
- At module initialization, validate the job dependency graph. Fail fast if there are cycles.
- Add unit tests for job execution order.

### Risk 5: Contradiction Suppression (LOW)

**Scenario:** Somewhere in the code, a developer catches the contradiction event and suppresses it, "fixing" the conflict silently.

**Mitigation:**
- Make contradiction handling explicit and logged. Add tests verifying contradictions are emitted as events.
- In code review, flag any suppression of contradictions as a CANON violation.
- Document the Piagetian principle: contradictions are learning signals, not bugs to fix.

### Risk 6: LLM Cost Explosion (MEDIUM)

**Scenario:** Every consolidation cycle calls LLM 2x (extraction + refinement). 10 cycles/min × 2 calls/cycle × $0.01/call = $12/hour.

**Mitigation:**
- Batch LLM calls: send all 5 events' extraction in a single prompt (may reduce precision).
- Cache extractions: if the same event text appears again, reuse cached extraction.
- Configurable LLM usage: allow disabling LLM refinement for resource-constrained deployments (fall back to pure graph-based learning).
- Monitor token spend in telemetry; alert if daily cost exceeds threshold.

---

## 11. Type & Interface Refinements Needed from E0/E3

### 11.1 Refinements to IEventService (E2)

Add discriminated union for learnable event properties:

```typescript
type LearnableEventType =
  | { type: 'COMMUNICATION'; content: ParsedInput; response: CommunicationResponse }
  | { type: 'GUARDIAN_CORRECTION'; correctionTarget: string; correctionType: GuardianFeedbackType }
  | { type: 'PREDICTION_FAILURE'; prediction: Prediction; outcome: PredictionOutcome; mismatch: number }
  | { type: 'ACTION_OUTCOME'; action: ActionProcedureData; outcome: ActionOutcome }
  | { type: 'DIRECT_OBSERVATION'; observation: SensorData };

interface LearnableEvent extends SylphieEvent {
  hasLearnable: true;
  learnableType: LearnableEventType;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';  // For event ranker
  metadata?: {
    processedAt?: Date;
    extractedEntities?: ExtractedEntity[];
    refinedEdges?: RefinedEdge[];
  };
}
```

### 11.2 Refinements to IWkgService (E3)

Add contradiction checking interface:

```typescript
interface IWkgService {
  // Existing methods...

  // NEW: Query for conflicting knowledge
  findConflictingNodes(
    node: WKGNode | KnowledgeEdge,
    checkMode: 'PROPERTY' | 'RELATIONSHIP' | 'IDENTITY'
  ): Promise<(WKGNode | KnowledgeEdge)[]>;

  // NEW: Upsert with explicit conflict handling
  upsertNodeWithConflicts(
    node: WKGNode,
    options: UpsertOptionsWithConflicts
  ): Promise<{ node: WKGNode; conflicts: Contradiction[] }>;

  // NEW: Tag a node as having known contradictions (metadata update)
  markContradicted(nodeId: string, reason: string): Promise<void>;
}

interface UpsertOptionsWithConflicts extends UpsertOptions {
  detectConflicts?: boolean;  // default true
  suppressConflict?: boolean; // default false (v2 philosophy)
}
```

### 11.3 Refinements to Shared Confidence Type

```typescript
// In src/shared/types/confidence.types.ts
interface ConfidenceRetrievalRecord {
  timestamp: Date;
  context: string;  // Where/how was it retrieved?
  outcome: 'SUCCESS' | 'FAILURE' | 'PARTIAL';
  predictionError?: number;  // If prediction-based
}

interface ACTRParams {
  base: number;
  count: number;
  retrievalHistory: ConfidenceRetrievalRecord[];
  decayRate: number;
}

// NEW: Type 1 graduation tracker
interface Type1GraduationCandidate {
  nodeId: string;
  currentConfidence: number;
  retrievalCount: number;
  recentMAE: number;  // Mean absolute error over last 10 uses
  isGraduated: boolean;
  graduatedAt?: Date;
  reason?: string;
}
```

---

## 12. Testing Strategy

### 12.1 Unit Tests

**By service:**

1. **ConsolidationService**
   - Test max-5 enforcement (batch size > 5 is truncated)
   - Test event ranking (impact events rank higher)
   - Test batch composition (all events from single batch are related or recent)

2. **EntityExtractionService**
   - Test LLM prompt generation (correct escaping, determinism)
   - Test extraction validation (malformed output is rejected)
   - Test entity deduplication (duplicate extractions within same batch are merged)

3. **EdgeRefinementService**
   - Test relationship validation (only valid relationship types allowed)
   - Test evidence requirements (edges without evidence are flagged)

4. **ContradictionDetectorService**
   - Test contradiction detection (ENTITY_CONFLICT vs. EDGE_CONFLICT)
   - Test severity classification (MINOR vs. SEVERE)
   - Test false positives (ensure some conflicts are correctly identified as non-conflicts)

5. **Each Job**
   - Test execution conditions (canRun() correctly identifies when job should execute)
   - Test output shape (JobResult has expected structure)
   - Test no-op cases (job produces empty results when input is empty)

### 12.2 Integration Tests

1. **Full Cycle Test**
   - Inject 5 communication events into mock TimescaleDB
   - Call runMaintenanceCycle()
   - Verify: entities extracted, edges created, jobs executed, result emitted to events
   - Verify WKG was updated with LLM_GENERATED provenance

2. **Pressure-Driven Trigger Test**
   - Mock IDriveStateReader to return high Cognitive Awareness
   - Verify runMaintenanceCycle() is triggered (or queued)
   - Verify timer fallback also works independently

3. **Max-5 Enforcement Test**
   - Feed 20 events to ConsolidationService
   - Verify only 5 make it into a batch
   - Verify remaining 15 are available for next cycle

4. **Contradiction Flagging Test**
   - Upsert entity "mug is red"
   - Later upsert "mug is blue"
   - Verify contradiction is emitted to TimescaleDB
   - Verify both values coexist in WKG (not suppressed)

5. **Job Dependency Order Test**
   - Run all 7 jobs with a synthetic event batch
   - Verify execution order matches dependency resolution
   - Verify temporalPattern edges exist before ProcedureFormation runs

### 12.3 E2E Test (after E6 Communication)

1. **Conversation → Learning Cycle**
   - Guardian says: "I put the mug in the kitchen"
   - Communication event recorded with has_learnable=true
   - Maintenance cycle triggers
   - Entity extraction finds: "mug", "kitchen"
   - Edge refinement finds: PUT relationship
   - TemporalPatternJob detects pattern
   - Verify WKG has new entities and edges with LLM_GENERATED provenance

2. **Guardian Correction → Learning Cycle**
   - Previous: "mug is blue"
   - Guardian corrects: "no, mug is red"
   - GUARDIAN_CORRECTION event recorded
   - Maintenance cycle processes correction
   - CorrectionProcessingJob creates CORRECTED_BY edge
   - Old edge penalized (confidence -= 0.15)
   - New edge created with GUARDIAN provenance (0.60)

3. **Prediction Failure → Learning Cycle**
   - Prediction: "If I ask, guardian will respond" (confident action)
   - Outcome: No response (silent)
   - PREDICTION_FAILURE event recorded
   - Learning cycle investigates failure
   - PlanningSubsystem (E8) creates Opportunity
   - Next time, Arbitration downgrades confidence of that action

### 12.4 Performance Tests

1. **Cycle Latency**: Single maintenance cycle should complete in <2 seconds (tunable)
2. **Max-5 Scaling**: Cycle latency should be constant regardless of batch size (always ≤5)
3. **LLM API Timing**: Entity extraction + edge refinement should take <1.5s (tunable with batch optimization)
4. **Memory Footprint**: Single cycle should not allocate >50MB transient memory

---

## 13. v1 Lift Checklist

### Files to Review from v1 (`co-being/packages/`)

**Direct lifts (copy with minimal edits):**
- [ ] `maintenance-engine/src/jobs/CorrectionProcessingJob.ts`
- [ ] `maintenance-engine/src/jobs/SentenceSplittingJob.ts`
- [ ] `maintenance-engine/src/jobs/SentenceStructureJob.ts`

**Significant adaptation required:**
- [ ] `maintenance-engine/src/jobs/TemporalPatternJob.ts` (graph → TimescaleDB queries)
- [ ] `maintenance-engine/src/jobs/ProcedureFormationJob.ts` (clustering logic)
- [ ] `maintenance-engine/src/jobs/PatternGeneralizationJob.ts` (concept induction)
- [ ] `maintenance-engine/src/services/consolidation-engine.service.ts` (orchestrator structure)
- [ ] `maintenance-server/src/maintenance/maintenance-pressure-loop.service.ts` (pressure trigger)

**Review for patterns only (no direct lift):**
- [ ] `maintenance-engine/src/services/metacognitive-analyzer.service.ts` (LLM refinement patterns)
- [ ] `backend/src/graph/semantic/` (contradiction detection concepts)
- [ ] `backend/src/orchestrator/confidence-updater.service.ts` (confidence update logic)

---

## 14. Build Order Within Epic 7

Recommended implementation sequence (can parallelize some pieces):

1. **Phase 7.1: Infrastructure** (days 1-2)
   - Create module scaffold, stubs, DI tokens
   - Implement ConsolidationService (event query, max-5 enforcement)
   - Implement EventRankerService
   - Verify `npx tsc --noEmit` passes

2. **Phase 7.2: Extraction & Contradiction** (days 2-3)
   - Implement EntityExtractionService (LLM prompts, output validation)
   - Implement EdgeRefinementService
   - Implement ContradictionDetectorService
   - Unit tests for all three

3. **Phase 7.3: Orchestrator** (days 3-4)
   - Implement LearningService (pressure-driven trigger, timer fallback)
   - Implement MaintenanceCycleOrchestrator
   - Wire up event emission to TimescaleDB
   - Integration tests: full cycle

4. **Phase 7.4: Jobs** (days 4-6)
   - Implement TemporalPatternJob
   - Implement CorrectionProcessingJob (v1 lift)
   - Implement ProcedureFormationJob
   - Implement PatternGeneralizationJob
   - Implement SentenceSplittingJob, SentenceStructureJob, SymbolicDecompositionJob
   - Implement JobRunner with dependency resolution
   - Unit tests for each job

5. **Phase 7.5: Integration** (days 6-7)
   - Wire Learning module into AppModule
   - Full-cycle E2E tests with mock data
   - Telemetry/metrics integration
   - Session log and context preservation

**Critical path:** 7.1 → 7.2 → 7.3 → 7.4 → 7.5 (sequential; dependencies prevent parallelization)

**Estimated total effort:** 7-8 days for a single developer

---

## 15. Open Questions & Design Decisions Needed

### Question 1: How frequently should maintenance cycles run?

**Recommendation:** Pressure-driven trigger at Cognitive Awareness > 0.65; timer fallback at 30s interval. Tunable via config.

**Alternative:** Adaptive cadence based on event arrival rate. If events arrive slowly, increase interval.

### Question 2: Should extracted entities be merged with existing nodes or created as separate nodes?

**Recommendation:** Merge by label+type. If "mug" exists and extraction finds "mug" again, upsert the existing node (add properties if new). This prevents entity duplication.

**Complexity:** Requires entity disambiguation (same label, different entity). Use person model for "Jim" disambiguation; spatial context for "kitchen" disambiguation.

### Question 3: What's the right balance between LLM calls and accuracy?

**Recommendation:** Separate calls for extraction and refinement (2 calls/cycle). Investigate batching (all 5 events in one prompt) in Phase 2 if cost becomes an issue.

### Question 4: Should contradiction events trigger re-training of procedures that depend on contradicted knowledge?

**Recommendation:** No, not in v2. Let the Planning subsystem (E8) detect when a procedure fails due to contradicted knowledge. That's how learning happens — through failed predictions.

---

## 16. Conclusion

Epic 7 is the **persistence engine** for experience. It converts ephemeral events into durable knowledge, subjects that knowledge to the CANON's immutable standards (provenance, confidence ceilings, guardian asymmetry), and flags contradictions as learning signals rather than errors.

The architecture is designed to **resist hallucination** (LLM_GENERATED base confidence 0.35, confidence ceiling without retrieval), to **enable genuine learning** (pressure-driven trigger, max-5 catastrophic interference prevention), and to **honor the guardian's role** (corrections weighted 3x, flagged contradictions waiting for investigation).

The v1 maintenance jobs are well-designed and reusable; v2 primarily changes the **data source** (TimescaleDB events vs. graph-persisted patterns) and adds **provenance discipline**. No fundamental cognitive insight needs to be invented — the work is engineering adaptation and integration.

**Success criteria for E7:**
- Maintenance cycles run pressure-driven and timer-backed
- Extracted entities carry LLM_GENERATED provenance at 0.35
- Contradiction events are emitted; no silent suppression
- Max-5 enforcement is hard and monitorable
- All 7 v1 jobs are ported and execute in dependency order
- Full-cycle E2E test demonstrates: event → extraction → edge refinement → procedure formation → WKG update

The subsystem is ready for implementation.
