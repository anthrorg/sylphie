# Feature: Consolidation loop — idle replay and insight synthesis

**Priority:** P2  ·  **Engineering level:** prototype
**Area / component:** decision-making / learning / WKG

## Why (required)
Acquisition and confirmation (feature-theory-loop) produce verified *atoms*; nothing
currently turns them into connected *understanding*. Acquisition is linear — consolidation
is where learning compounds: she wakes up smarter not because she read more but because
she connected what she already had. The CognitiveAwareness drive already signals "there is
unintegrated cognition to process" and is the natural trigger.

## What it should do (required)
- **Trigger:** idle + accumulated CognitiveAwareness pressure.
- **Process:** replay the recent episodic ring buffer (50 slots) together with recently
  confirmed/refuted theories through the Type-2 deliberation path to:
  detect cross-episode patterns → synthesize higher-order `insight` nodes in the WKG;
  prune contradictions Tess surfaced; re-weight confidence across related nodes.
- **Invariants preserved:** MERGE-raises-only still holds — consolidation can connect,
  never silently overwrite. EWC (real Online EWC, λ-ramped) anchors prior competence so
  new structure integrates without catastrophic forgetting.
- Consolidation output is visible in the snapshot metrics (`insights` count) so the
  dashboard shows it compounding.

## Scope hints
`packages/decision-making/**` (episodic buffer + Type-2 path — owner `cortex`, reviewer
`luria`); WKG insight node shape (`atlas`, reviewer `scout`); EWC anchoring in
`packages/learning/**` / cognition-service (`learning`/`meridian`, reviewer `piaget`);
drive trigger (`drive`, reviewer `skinner`).

## Dependencies (required)
Depends on **feature-theory-loop** (verdicts are a primary input) and
**feature-schema-versioning** (new `insight` node shape). Sequence AFTER
**bug-audit-wkg-knowledge-graph** — "prune contradictions Tess surfaced" depends on the
contradiction scanner actually matching the real CONTRADICTS shape, which that bug fixes
(today the gate is a no-op). Conflict risk: touches the same WKG shape code as
feature-theory-loop — run sequentially.

## Database impact (required)
**Touches a database / schema / migration?** yes
WKG (Neo4j): new `insight` node shape + provenance (migration). Reads episodic buffer and
theory nodes; re-weights confidence via existing MERGE-raises-only path.

## Acceptance — how we'll know it works (required)
1. Given idle + CognitiveAwareness over threshold and ≥N recent episodes/verdicts, when
   the consolidation action runs, then at least one `insight` node appears in the WKG
   with provenance linking its source episodes/theories.
2. Given a Tess-refuted theory contradicting an existing node, when consolidation runs,
   then the contradiction is pruned/demoted — and no node's confidence is silently
   *overwritten* downward outside the sanctioned path (MERGE-raises-only audit passes).
3. Given consolidation completes, then CognitiveAwareness pressure is relieved (drive
   trace) and prior graduated competence is unchanged (agreement metrics for graduated
   categories do not regress — EWC check).
4. Insight count appears in the next snapshot's metrics block.

## Non-goals / scope guard (required)
No changes to the episodic encoding gate or ring-buffer size. No acquisition/Tess work
(upstream feature). No new pathology detectors — existing ones already cover the failure
shapes. Prototype rigor: the pattern-detection quality bar is "produces plausible,
provenance-linked insights", not a benchmark.

## Source / references
`docs/future/sylphie-autonomous-cognition-research.md` §3, §6.
