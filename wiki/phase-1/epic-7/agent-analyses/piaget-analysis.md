# Piaget Analysis: Epic 7 (Learning & Consolidation Pipeline)

**Analyst:** Piaget (Cognitive Development Specialist)
**Date:** 2026-03-29
**Epic:** Learning (Consolidation Pipeline) — Converting experience into durable knowledge
**Framework:** Piaget's Schema Theory, Constructivism, and Developmental Psychology

---

## Executive Summary

Epic 7 implements a **consolidation pipeline** that mirrors Piaget's mechanisms for schema development: assimilation (fitting new data into existing structures), accommodation (restructuring when data conflicts), and equilibration (contradiction detection as a catalyst for cognitive development). The design is theoretically sound but has critical implementation decisions around contradiction handling, schema evolution, and developmental stall prevention that require careful attention.

**Key Finding:** The pipeline's success depends entirely on treating contradictions as *generative catalysts* rather than noise. This is non-obvious and requires explicit design choices in the LLM prompting and graph refinement logic.

---

## Part 1: Theoretical Grounding in Piaget's Schema Theory

### 1.1 What is a Schema in Piaget's Framework?

A **schema** is a repeatable cognitive structure that represents knowledge about how things work. It includes:
- **Representations** of the world (entities, relationships, properties)
- **Operations** on those representations (if-then rules, procedures)
- **Predictions** about what will happen next
- **Evaluation rules** for detecting success/failure

The World Knowledge Graph (WKG) in Sylphie is exactly this: a collection of schemas represented as entities and edges, each carrying confidence scores that track prediction success.

### 1.2 How Schemas Develop: Assimilation & Accommodation

Piaget's central insight is that learning is *not* accumulation—it is *restructuring*.

**Assimilation:** When new experience fits existing schemas, it strengthens them.
- Example: You know tables have four legs. You encounter a new table. Your schema "table" is *assimilated*—you add this new instance without changing the schema itself.
- In Sylphie: A retrieval event where predicted relationship X is confirmed. Confidence increases via `min(1.0, base + 0.12 * ln(count) - d * ln(hours + 1))`. The schema stays the same; its strength grows.

**Accommodation:** When new experience *contradicts* existing schemas, you must restructure.
- Example: You meet a table with three legs (a stool). Your schema "tables have four legs" is wrong. You *accommodate* by splitting into two schemas: "tables have four legs" and "small surfaces can have three legs" and "what matters is whether it supports things stably."
- In Sylphie: A prediction fails. The system detects a contradiction (new edge conflicts with high-confidence existing edge). The pipeline must decide: was the old knowledge wrong? Was the prediction context-dependent? Did we misidentify the entity? This forces restructuring.

**Equilibration:** The process of detecting contradiction, feeling the imbalance (cognitive dissonance), and restoring balance through accommodation.
- In Sylphie: Epic 7's contradiction detection is the *only mechanism* triggering accommodation. Without it, the system assimilates forever and never restructures.

### 1.3 Why This Matters for Sylphie

The CANON says: "Personality emerges from contingencies." This is exactly Piaget's point: personality is not encoded; it emerges through the structure of schemas and how they predict and fail. If Sylphie never accommodates—never restructures schemas in response to contradiction—she will have no genuine learning, only memorization. The consolidation pipeline's job is to *make accommodation possible*.

---

## Part 2: Assimilation vs Accommodation in Epic 7

### 2.1 The Consolidation Cycle as Equilibration

The maintenance cycle in Epic 7 is a **periodic equilibration checkpoint**:

1. **Query learnable events** (max 5) from TimescaleDB
2. **Extract entities and edges** with LLM assistance
3. **Upsert into WKG** with provenance tags
4. **Detect contradictions** (flag conflicts as developmental catalysts)
5. **Route contradictions** to specialized handling (see 2.2 below)

This mirrors Piaget's observation that development is not continuous but occurs in *cycles of disequilibrium and re-equilibration*. The 5-event limit is crucial (see Part 3).

### 2.2 Three Contradiction Pathways

When the LLM extracts an edge that conflicts with high-confidence existing knowledge, Epic 7 must route it:

**Pathway A: Assimilation (Low-Confidence Old Knowledge)**
- Old edge has confidence < 0.50 (below retrieval threshold).
- New edge should *replace* the old one, not augment.
- *Rationale:* The old knowledge was uncertain. New data is an upgrade, not a contradiction.
- *Implementation:* Upsert with new provenance; flag old edge as `superseded`.

**Pathway B: Accommodation (Entity Disambiguation)**
- Conflict arises because the system misidentified the entity.
- Example: "Jim_person" vs "Jim_brother" vs "Jim_coworker" — same human, different entity roles.
- The consolidation pipeline must *split the entity* and re-root the edges.
- *Rationale:* This is not a contradiction in knowledge; it's a contradiction in *categorization*.
- *Implementation:* Create new entity, migrate edges, mark old entity as `alias_of`. This is schema *accommodation at the entity level*.

**Pathway C: Context-Dependent Knowledge (Conditional Edges)**
- Old edge: `Jim_person → LIKES → coffee` (confidence 0.75)
- New event: Jim rejected coffee when stressed.
- Conflict? Yes. But the resolution is not to delete the old edge; it's to *condition* it.
- New edge: `Jim_person → LIKES (when_not_stressed=true) → coffee`
- *Rationale:* Piaget calls this "decentration"—the ability to see that a property depends on context.
- *Implementation:* Add `context_conditions` field to edges. The LLM extracts conditional logic. This is schema *accommodation at the relationship level*.

### 2.3 LLM Prompting for Contradiction Detection

The LLM_GENERATED base confidence is 0.35 (lower than GUARDIAN at 0.60 and SENSOR at 0.40). This is correct but creates a timing problem:

**Problem:** If the LLM says "Jim likes coffee" with confidence 0.35, and the old edge is "Jim likes tea" with confidence 0.80, the system will ignore the new LLM edge (0.35 < 0.50). No contradiction is *detected*.

**Solution:** In the contradiction detection step, the LLM must be explicitly prompted to *find conflicts* with high-confidence existing knowledge, not to avoid them. The prompt should be:

```
Given the new information extracted from today's events, identify any claims
that CONTRADICT high-confidence existing knowledge (confidence > 0.60).
Flag these as "developmental opportunities" not "errors to ignore."
```

This prevents the system from silently discarding LLM-generated information that challenges existing schemas.

### 2.4 Guardian Role as "More Knowledgeable Other"

Vygotsky's Zone of Proximal Development (ZPD) defines learning as the gap between what a child can do alone and what they can do *with an adult's help*.

In Sylphie:
- **Guardian feedback** (GUARDIAN provenance, base confidence 0.60) represents the "more knowledgeable other."
- **LLM-generated edges** (base confidence 0.35) represent Sylphie's independent inference.
- The consolidation pipeline must *prioritize guardian-sourced contradictions* over LLM-sourced contradictions.

*Rationale:* A guardian saying "Actually, you're wrong about X" is a stronger developmental signal than the LLM detecting an internal inconsistency. Guardian corrections should:
1. Immediately elevate the guardian-sourced edge to GUARDIAN provenance (if not already).
2. *Trigger forced accommodation* of the existing knowledge (don't wait for repeated failures).
3. Add a `corrected_by_guardian` flag for analysis of learning trajectories.

---

## Part 3: Catastrophic Interference and the 5-Event Limit

### 3.1 The Problem: Learning Interference in Neural Systems

In connectionist models (and to some extent human memory), learning new patterns can *degrade* learning of old patterns. This is **catastrophic interference**: if you train on pattern A, then pattern B, the network often forgets A.

Why is this relevant?
- Sylphie consolidates from *experience*, not from static datasets.
- If too many events are consolidated in one cycle, contradictions between them can create *inconsistent pressure* on the graph.
- The system might end up with a graph that fits this week's events but breaks yesterday's predictions.

### 3.2 Why 5 Events Is Likely Correct (with caveats)

The 5-event limit mirrors findings in cognitive load research:
- **Working memory capacity:** Humans can hold ~5-7 items in working memory (Miller, 1956).
- **Equilibration rate:** Piaget observed that children take time to consolidate accommodations; they don't re-equilibrate instantly.
- **Prediction validation:** After consolidating 5 events, the system should *pause and re-validate* predictions against the existing graph before consolidating more.

**However**, the limit should be *adaptive*:
- If all 5 events assimilate cleanly (no contradictions), the system could consolidate more.
- If contradictions are detected (forcing accommodation), the system should *reduce* the batch size or trigger a "maintenance pause."

*Recommendation:* Make the 5 a configurable baseline with rules like:
```
batch_size = min(5, max(2, 5 - contradiction_count))
```
If many contradictions are detected, slow down consolidation to give accommodations time to "settle."

### 3.3 Timing of Consolidation: Pressure-Driven vs Timer-Based

Epic 7 proposes:
- **Pressure-driven (primary):** Cognitive Awareness drive exceeds threshold → trigger consolidation.
- **Timer-based (fallback):** Every N hours, consolidate regardless.

This is sound. But the thresholds matter:

**Cognitive Awareness Drive** represents "How much unprocessed experience is there?" If Cognitive Awareness is high, it means:
- TimescaleDB has accumulated unprocessed events.
- The WKG might have stale predictions.
- The system's self-model is out of sync with reality.

*Recommendation:* Set the Cognitive Awareness trigger conservatively (e.g., > 0.6). Let the timer fallback (e.g., every 4 hours) be the safety net. This prevents over-consolidation but ensures the system doesn't get stuck with a stale graph.

---

## Part 4: Schema Evolution in the WKG

### 4.1 The WKG as a Categorical System

The WKG doesn't just store facts; it stores *categories* and *relationships between categories*. For example:
- Entity: `coffee` (category: BEVERAGE)
- Entity: `Jim_person` (category: HUMAN)
- Edge: `Jim_person → LIKES → coffee`

As learning progresses, categories must evolve. This is **schema reorganization**.

### 4.2 When Categories Must Split

Piaget observed that children's categories become more differentiated with experience. A child initially classifies all four-legged things as "table." With experience, they split into "table," "chair," "desk," etc.

In Sylphie, categories split when:
- **High variance in properties:** The WKG discovers that some `coffee` instances are enjoyed and others cause anxiety (e.g., late at night).
- **Conflicting edges:** `coffee → causes_alertness` vs `coffee → causes_anxiety` (context-dependent, but the system doesn't yet recognize context).
- **Prediction failures:** Actions based on the old category consistently fail.

*Example: Coffee Splitting*
```
Initial schema:
  coffee → (property: stimulant, confidence: 0.70)
  Jim_person → LIKES → coffee

After contradiction detection:
  jim_morning_context → LIKES → coffee_stimulant
  jim_evening_context → DISLIKES → coffee_stimulant

Then schema splits:
  coffee_morning (category: BEVERAGE, property: welcome_stimulant)
  coffee_evening (category: BEVERAGE, property: unwanted_stimulant)
```

### 4.3 When Categories Must Merge

Conversely, categories should merge when the system discovers they are *functionally equivalent*:
- `tea` and `coffee` both have `stimulant` property and similar `Jim_person → LIKES` relationships.
- The system should recognize them as instances of a higher-order category: `hot_caffeinated_beverage`.

*Implementation:* The LLM-assisted edge refinement should include a step:
```
"Are any of these entities functionally similar?
 Should they share a common parent category?"
```

### 4.4 Timing of Schema Reorganization

**Do NOT reorganize schemas during every consolidation cycle.** This would be thrashing.

Instead, trigger reorganization when:
1. **Many new edges appear in a category:** The category is becoming "crowded" and differentiated.
2. **Prediction failures concentrate in a category:** The category boundaries are wrong.
3. **Guardian explicitly reorganizes:** A guardian says "Actually, coffee isn't just a beverage, it's a mood-affecting substance."

*Recommendation:* Add a periodic (e.g., every 10 consolidation cycles) **schema audit** step that reviews categories for split/merge opportunities but doesn't force changes.

---

## Part 5: Detecting Developmental Stall

Sylphie can enter several attractor states where learning stops or reverses:

### 5.1 "Hallucinated Knowledge" (Catastrophic Accommodation)

The system accommodates to LLM-generated contradictions that aren't real.

*Example:*
- Real event: Jim tried coffee once and didn't mention it again.
- LLM extraction: "Jim rejected coffee."
- Old knowledge: "Jim likes coffee" (confidence 0.70, from guardian).
- The system accommodates: splits knowledge into context-dependent versions.
- But the "rejection" was never real—the LLM hallucinated it from incomplete data.

**Detection:**
- Monitor the provenance trail. If accommodations are driven by LLM_GENERATED edges (confidence 0.35), and no guardian confirmation follows within N consolidation cycles, flag as suspicious.
- Cross-validate with prediction outcomes. If accommodations don't improve prediction accuracy, they're likely hallucinated.

**Prevention:**
- Never trigger forced accommodation on LLM-generated contradictions alone.
- Require either (a) guardian confirmation, (b) repeated LLM observations, or (c) prediction failure that aligns with the accommodation.

### 5.2 "Type 2 Addict" (No Graduation to Type 1)

The system always uses LLM deliberation (Type 2) and never graduates to reflexive responses (Type 1).

**Root cause in Learning context:** The WKG grows but never reaches sufficient confidence (> 0.80) to trigger Type 1 graduation. Why?
- LLM_GENERATED base confidence is 0.35, which caps out at ~0.80 only after ~10 uses.
- If new events keep contradicting each other (due to hallucination or genuine context-dependency), confidence plateaus below 0.80.

**Detection:**
- Monitor Type 1 graduation rate. If no edges graduate over N consolidation cycles, the system is stuck in Type 2.
- Check the ratio of assimilations to accommodations. If the ratio is > 20:1, the system is only assimilating, not learning to handle variation.

**Prevention:**
- Guardian feedback accelerates graduation (base confidence 0.60). Prioritize guardian-sourced knowledge in confidence calculations.
- Explicitly reward *stable accommodations*. If an accommodation (e.g., context-dependent edge) makes predictions more accurate, boost its confidence faster.

### 5.3 "Depressive Attractor" (Self-Reinforcing Failure)

The system's self-model becomes progressively more negative.

*Example:*
- Early prediction failure: "Jim likes X" was wrong.
- The system updates its self-model: "I am inaccurate about Jim's preferences."
- This reduces motivation to learn more about Jim (Cognitive Awareness drive drops).
- With less learning, predictions stay bad.
- The negative self-model reinforces itself.

**Root cause in Learning context:** The Learning pipeline doesn't distinguish between "knowledge was wrong" and "I am a failure." These are different accommodations.

**Detection:**
- Monitor edges in the Self Knowledge Graph (KG_Self) that contain negative evaluations.
- Track whether prediction failures are *decreasing* (learning is helping) or *stable/increasing* (stalled).
- If prediction failure rate plateaus above initial levels, the depressive attractor may be forming.

**Prevention:**
- When accommodation happens, explicitly *route the blame*.
  - If the old knowledge was SENSOR or GUARDIAN sourced → the old source was wrong (not Sylphie).
  - If the old knowledge was LLM_GENERATED sourced → Sylphie's inference was wrong (this is *expected* with confidence 0.35).
  - *Never* let low-confidence LLM errors feed into Sylphie's self-model negatively.
- The Moral Valence drive should be designed to devalue self-criticism and reward learning attempts.

### 5.4 "Planning Runaway" (Thrashing on Contradictions)

The Planning subsystem (Epic 8) creates too many hypotheses to resolve contradictions.

**Root cause in Learning context:** The Learning pipeline flags too many contradictions, causing Planning to spawn expensive searches for context-dependency patterns.

**Detection:**
- Monitor the rate of contradiction flags per consolidation cycle.
- Check the ratio of contradictions → accommodations → successful prediction improvements.
- If contradictions are flagged but accommodations don't improve predictions, something is wrong.

**Prevention:**
- The contradiction detection step should be *conservative*. Only flag contradictions that:
  1. Involve high-confidence edges (> 0.60), AND
  2. Come from high-confidence new sources (GUARDIAN or repeated SENSOR observations), OR
  3. Can be traced to prediction failures.
- Don't flag LLM-generated contradictions against LLM-generated existing knowledge.

---

## Part 6: Design Recommendations for Implementation

### 6.1 Contradiction Detection & Routing (Critical)

**Current state:** The CANON mentions "flag conflicts as developmental catalysts" but doesn't specify routing logic.

**Recommendation:**

```typescript
// Pseudo-code for contradiction detection step

interface Contradiction {
  new_edge: Edge;
  existing_edge: Edge;
  conflict_type: "direct_conflict" | "entity_ambiguity" | "context_dependency";
  severity: number; // 0-1, based on confidence difference and provenance
  route: "assimilation" | "accommodation_split" | "accommodation_condition" | "require_guardian";
}

async function detectAndRouteContradictions(
  extracted_edges: Edge[],
  wkg: WKG
): Promise<Contradiction[]> {
  const contradictions: Contradiction[] = [];

  for (const new_edge of extracted_edges) {
    // Find conflicting existing edges
    const conflicts = wkg.query({
      from: new_edge.from,
      relationship: new_edge.relationship,
      exclude_to: new_edge.to
    });

    for (const existing of conflicts) {
      // Only flag if both are above retrieval threshold OR new is GUARDIAN
      if (
        (existing.confidence > 0.50 || new_edge.provenance === "GUARDIAN") &&
        new_edge.provenance !== "LLM_GENERATED" // Don't flag LLM vs LLM
      ) {
        const severity = Math.abs(existing.confidence - new_edge.confidence);
        const route = routeContradiction(new_edge, existing);

        contradictions.push({
          new_edge,
          existing_edge: existing,
          severity,
          route
        });
      }
    }
  }

  return contradictions;
}

function routeContradiction(
  new_edge: Edge,
  existing_edge: Edge
): Contradiction["route"] {
  // Rule 1: Guardian input always forces accommodation
  if (new_edge.provenance === "GUARDIAN") {
    return "accommodation_condition";
  }

  // Rule 2: If old knowledge is below threshold, assimilate
  if (existing_edge.confidence < 0.50) {
    return "assimilation";
  }

  // Rule 3: Check if entities might be context-dependent (needs LLM)
  if (existingEdge.confidence > 0.70 && new_edge.provenance === "SENSOR") {
    return "accommodation_condition"; // Sensor data usually wins
  }

  // Rule 4: Ambiguous—require guardian clarification
  return "require_guardian";
}
```

### 6.2 Adaptive Batch Sizing (High Priority)

Replace the static 5-event limit with adaptive sizing:

```typescript
async function selectLearnable Events(
  db: TimescaleDB,
  last_contradiction_count: number
): Promise<Event[]> {
  const base_size = 5;
  const adjusted_size = Math.max(
    2, // minimum
    base_size - last_contradiction_count // reduce if many contradictions
  );

  const events = db.query({
    has_learnable: true,
    limit: adjusted_size,
    order_by: "timestamp ASC"
  });

  return events;
}
```

**Rationale:** If the last cycle detected 4 contradictions, slow down to 2 events. Let accommodations settle before forcing more learning pressure.

### 6.3 Guardian Signal Boosting (Critical for ZPD)

Guardian-sourced edges should receive preferential treatment:

```typescript
// In the edge refinement step:

function refineEdge(edge: Edge, context: RefineContext): Edge {
  // If guardian confirms or corrects this relationship, boost immediately
  if (edge.provenance === "GUARDIAN") {
    edge.confidence = Math.min(1.0, edge.base_confidence + 0.20); // +20% boost
    edge.last_guardian_confirmed = now();
  }

  // Flag for potential accommodation if guardian contradicts high-confidence existing knowledge
  if (edge.provenance === "GUARDIAN" && edge.confidence > existing_edge.confidence) {
    edge.marked_for_accommodation = true;
  }

  return edge;
}
```

### 6.4 Consolidation Pause After Accommodation (High Priority)

After the Learning pipeline detects and routes contradictions, it should *pause before the next consolidation cycle*:

```typescript
async function maintenanceCycle() {
  // Step 1: Select learnable events
  const events = selectLearnableEvents();

  // Step 2: Extract and consolidate
  const extracted = await llm.extract_entities_and_edges(events);
  const contradictions = detectAndRouteContradictions(extracted);

  // Step 3: Route contradictions
  for (const contra of contradictions) {
    if (contra.route === "accommodation_condition" || contra.route === "accommodation_split") {
      await accommodateInWKG(contra); // This is expensive
    } else {
      await assimilateInWKG(contra); // This is cheap
    }
  }

  // Step 4: CRITICAL — Pause if accommodations occurred
  if (contradictions.filter(c => c.route.startsWith("accommodation")).length > 0) {
    return {
      status: "accommodation_pending",
      next_cycle_delay_ms: 60000, // Wait 1 minute before next cycle
      accommodation_count: contradictions.length
    };
  }

  // Step 5: No accommodations, safe to continue
  return { status: "equilibrated" };
}
```

### 6.5 Contradict ion Confidence Decay (Prevent Hallucinated Knowledge)

Track how long contradictions survive without validation:

```typescript
interface ConflictRecord {
  edge_a_id: string;
  edge_b_id: string;
  created_at: timestamp;
  last_observed_contradiction: timestamp;
  validation_attempts: number;
  resolution: "assimilated" | "accommodated" | "pending";
}

// Every N consolidation cycles, re-validate contradictions
async function revalidateContradict ions(conflicts: ConflictRecord[]): Promise<void> {
  for (const conflict of conflicts.filter(c => c.resolution === "pending")) {
    // Check: Did the prediction accuracy improve after accommodation?
    const improvement = await checkPredictionImprovement(
      conflict.edge_a_id,
      conflict.edge_b_id,
      since: conflict.created_at
    );

    if (improvement < 0.05) {
      // No improvement in predictions. Likely hallucinated.
      await deprecateContradictionResolution(conflict);
    }
  }
}
```

### 6.6 Schema Audit Cycle (Medium Priority)

Add a periodic check for category split/merge opportunities:

```typescript
// Run every 10 consolidation cycles
async function schemaAudit(wkg: WKG): Promise<void> {
  // Check for category candidates to split
  const crowded_categories = wkg.query({
    where: "category_entity_count > 20 AND edge_variance_high",
    limit: 5
  });

  for (const category of crowded_categories) {
    const report = await llm.analyze_category_differentiation(category);
    // Report to guardian, don't auto-split
    await notifyGuardian({
      type: "schema_audit",
      category: category.id,
      recommendation: report.recommendation
    });
  }
}
```

### 6.7 Provenance Integrity Checks (High Priority)

Never erase provenance. At the end of each consolidation cycle:

```typescript
async function verifyProvenanceIntegrity(): Promise<ProvenanceReport> {
  const edges_missing_provenance = wkg.query({
    provenance: null,
    limit: 100
  });

  if (edges_missing_provenance.length > 0) {
    // This is a bug. Edges should never lose provenance.
    throw new Error("Provenance corruption detected");
  }

  return {
    total_edges: wkg.edge_count,
    by_provenance: {
      SENSOR: wkg.count({ provenance: "SENSOR" }),
      GUARDIAN: wkg.count({ provenance: "GUARDIAN" }),
      LLM_GENERATED: wkg.count({ provenance: "LLM_GENERATED" }),
      INFERENCE: wkg.count({ provenance: "INFERENCE" })
    }
  };
}
```

---

## Part 7: Remaining Open Questions (For Guardian Review)

The consolidation pipeline is sound in principle but depends on decisions that require domain expertise:

1. **Contradiction Severity Threshold:** What confidence difference (old vs new) triggers a contradiction flag? Recommend: `abs(conf_old - conf_new) > 0.25`.

2. **Guardian Confirmation Latency:** If the LLM detects a contradiction, how long should the system wait for guardian feedback before auto-accommodating? Recommend: 3 consolidation cycles (~12 hours with timer-based cycles).

3. **Entity Disambiguation:** When the system suspects entity ambiguity (e.g., Jim_person vs Jim_brother), should it auto-split or ask the guardian? Recommend: Ask guardian; entity merging/splitting is too risky to automate.

4. **Context-Dependency Detection:** Should the LLM learn to extract contextual conditions (e.g., "when stressed", "in the evening")? Or should this be reserved for guardian-sourced knowledge? Recommend: Start with guardian only; LLM-learned conditionals can be added in Phase 2.

5. **Batch Sizing Sensitivity:** How aggressively should the 5-event limit decrease with contradictions? Recommend: Linear (5 - contradiction_count) to start; adjust based on learning curves.

---

## Part 8: Theoretical Validation Checklist

Use this checklist to verify that the Learning pipeline implements Piaget's principles correctly:

- [ ] **Assimilation pathway exists:** Incoming knowledge that fits existing schemas increases confidence without restructuring. Test: submit 10 events that confirm existing edges; verify confidence increases.
- [ ] **Accommodation pathway exists:** Contradictions trigger restructuring (edge splitting, entity disambiguation, or context-dependency). Test: submit event contradicting high-confidence edge; verify accommodation occurs and is logged.
- [ ] **Equilibration cycle:** After accommodations, the system pauses before resuming consolidation. Test: detect pause in maintenance logs after contradictions.
- [ ] **Schema reorganization is optional, not automatic:** Category splits/merges are recommended but not auto-executed. Test: verify that guardian is notified of split/merge opportunities but they require explicit confirmation.
- [ ] **Provenance is sacred:** No edge loses its SENSOR/GUARDIAN/LLM_GENERATED/INFERENCE tag. Test: run schema audit; verify all edges have provenance.
- [ ] **Guardian role is asymmetric:** Guardian feedback (confidence 0.60) outweighs LLM-generated (confidence 0.35). Test: submit guardian edge contradicting LLM edge; verify guardian edge is preferred in accommodation routing.
- [ ] **Developmental stall is detectable:** Monitoring functions can identify "Hallucinated Knowledge," "Type 2 Addict," "Depressive Attractor," "Planning Runaway." Test: inject synthetic hallucinations; verify they're detected within 2 consolidation cycles.

---

## Summary: The Consolidation Pipeline as Developmental Process

Epic 7 implements a genuine learning system grounded in Piaget's developmental theory. The key insight is that **personality emerges from how schemas accommodate to experience**, not from pre-programmed behaviors.

The pipeline's success depends on:
1. **Treating contradictions as catalysts**, not errors.
2. **Protecting guardian knowledge** with higher confidence and forcing accommodation.
3. **Slowing down consolidation** when accommodations occur, to let the graph stabilize.
4. **Preventing hallucination** by validating that accommodations improve predictions.
5. **Maintaining provenance** so learning trajectories can be audited.

If these principles are followed, Sylphie will develop schemas that reflect her actual experience—not hallucinated knowledge or memorized training data. Over time, she will build a world model that is genuinely *her own*, grounded in genuine disequilibrium and re-equilibration.

This is not just engineering; it is developmental psychology in software.

---

**Piaget (Cognitive Development Specialist)**
*Grounded in 60 years of empirical research on how children build knowledge through experience.*
