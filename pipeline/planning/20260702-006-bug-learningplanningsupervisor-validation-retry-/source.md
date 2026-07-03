# Bug: Learning/Planning/Supervisor — validation retry writes the wrong proposal, provenance falsification, silent opportunity drops

**Severity:** high  ·  **Priority:** P1
**Area / component:** packages/learning, packages/planning, packages/supervisor

## What's broken (required)
The three packages are structurally sound (timers cleaned up, in-flight guards correct, LLM timeouts + breaker real, fail-closed conflict detection holds), but several live defects concentrate in constraint-bypass, provenance, and silent drops:
- **Validation retry writes the ORIGINAL failing proposal.** `ConstraintValidationService.validate()` refines the proposal internally and re-validates, but `ValidationResult` carries no proposal back; `PlanningService.executePipeline` never reassigns `currentProposal`, so on a pass at attempt ≥2 it creates the original proposal that FAILED validation — under a `PLAN_VALIDATED` event. A direct constraint-engine bypass.
- **`refine()` zeroes `predictedDriveEffects`.** `parseLlmProposal` returns `predictedDriveEffects:{}` ("populated by the caller from simulation" — but the retry loop never repopulates), so any refined `LLM_GENERATE`/`TTS_SPEAK` plan fails the theater check (`checkNoTheatricalBehavior` requires non-zero drive effect) on every retry. Combined with the above: refinement is either futile (expressive plans) or dangerous (passes, then the original is written).
- **Provenance falsification (CANON Std-2).** For `INPUT_RECEIVED` speaker triples, `triple.source==='self_reported'` maps to edge provenance `GUARDIAN` at 0.60 — unverified sensor input gets guardian provenance and the slowest decay rate. The comment claiming this applies "only when the subject is already a live entity" doesn't match the code (applied unconditionally).
- **Speaker facts attach to an arbitrary entity.** `findSpeakerEntity` falls back to "first GUARDIAN, else first SENSOR, else first candidate" — post-Wave-3, conversation entities are CANDIDATE, so it picks whatever proper noun appeared first. "I love Minecraft" → `(Minecraft)-[LIKES]->(Minecraft)` at GUARDIAN/0.60. Personal facts systematically mis-attributed to non-person nodes.
- **Rate-limited/capacity-rejected opportunities permanently destroyed at ingest.** The `finally` marks every polled row `has_planned=true` — including rows whose `enqueue()` returned false (rate-limited, max 3/hr, or lost the eviction contest) and deferred opportunities whose re-enqueue is rejected. Never re-polled, never dead-lettered. Any burst >3/hr silently loses the excess.
- Lower: re-grounding sweep can push INFERENCE insight confidence past 0.60 (unclamped ratio); transient LLM failure permanently forfeits a session's reflection (marked reflected, 0 insights); `markAsLearned` swallows failures → duplicate `:Conversation` nodes every 60 s per stuck event + false processed counts; sidecar 400 validation rejections counted as breaker failures (5 rejects block freeze/rollback 30 s); `ADDRESSES_OPPORTUNITY` constraint vacuous since the stable-key fix; `pendingInterventions` unbounded and never read; decayed `:Candidate` orphans never pruned; `updateEdgeType` two-statement non-transactional.

## Expected (required)
Whatever proposal passes validation is the proposal that gets written; refined proposals retain their drive-effect predictions so the theater check is meaningful; conversation-derived facts carry SENSOR (not GUARDIAN) provenance and attach to the correct person subject; and rate-limited/deferred opportunities are re-queued or dead-lettered, never silently dropped.

## Steps to reproduce (required)
1. Craft an opportunity whose first proposal fails a constraint but whose refinement would pass. Run the pipeline; inspect the created `:ActionProcedure` — it matches the original failing proposal, not the refined one, while the event log says `PLAN_VALIDATED`.
2. Say "I like coffee" in conversation; inspect the resulting edge — provenance `GUARDIAN`, confidence 0.60, subject possibly a non-person node.
3. Emit >3 plannable opportunities within an hour; observe the excess marked `has_planned=true` with only a `PLANNING_RATE_LIMITED` event and no dead-letter.

**Reproducibility:** always (source-trace; confirm live)

## Evidence
- Validation retry: `packages/planning/src/pipeline/constraint-validation.service.ts:120-172`; `planning.service.ts:582-586,649`; `planning.interfaces.ts:232-248`.
- refine zeroes effects: `packages/planning/src/pipeline/proposal.service.ts:107-130,343-384`; theater check `constraint-checks.ts:203-238`.
- Provenance: `packages/learning/src/pipeline/extract-typed-edges.service.ts:458,487-507` (+ misleading comment :447-453); decay rates `confidence-decay.service.ts:141-146`.
- Wrong subject: `extract-typed-edges.service.ts:738-746`.
- Opportunity drop: `planning.service.ts:325-346,619-625`; queue `opportunity-queue.service.ts:104-114`.
- Lower: `conversation-reflection.service.ts:840-853,1209-1227,271-279`; `update-wkg.service.ts:176-188` (+ `learning.service.ts:577-601`); `sidecar-control.service.ts:343-346` (+ `cognition-service/main.py:728-744`); `constraint-checks.ts:99-118`; `supervisor.service.ts:122,662`; `confidence-decay.service.ts:239`; `refine-edges.service.ts:426-454`.
- Verified holding (do not re-file): fail-closed conflict detection + stable dedup key; person-fact leak sealed via `:Candidate` staging (residue = the two provenance findings above); forceCycle-vs-timer race clean.

Full detail: `docs/audits/repo-bug-audit-2026-07-02.md` §5.

## Where it lives (scope hints)
`packages/planning/src/pipeline/constraint-validation.service.ts` + `planning.service.ts` (return the refined proposal; repopulate drive effects), `packages/planning/src/queue/opportunity-queue.service.ts` + `planning.service.ts` ingest (dead-letter rejected/deferred), `packages/learning/src/pipeline/extract-typed-edges.service.ts` (provenance + subject resolution). Owned by `planner` (planning) and `learning` per CLAUDE.md work-trio.

## Database impact (required)
**Touches a database / schema / migration?** yes — Neo4j (WORLD) writes, but **no schema migration**: the fixes correct which proposal is written, provenance/confidence values, and subject-node selection on the existing model. Data note: existing GUARDIAN-stamped conversation edges and any procedures written from the wrong proposal may warrant a one-time re-provenance/backfill pass (flag for a migration-plan decision, not a schema change). No destructive change, no init-file edit.

## Acceptance — how we'll know it's fixed (required)
- Given a proposal that passes only after refinement, when validation passes, then the procedure written to the graph is the refined proposal (unit test asserting the created node matches the refined, not original, proposal).
- Given a refined expressive plan, when the theater check runs on retry, then `predictedDriveEffects` is populated and the check is meaningful (unit test).
- Given a conversation speaker-fact, when the edge is written, then provenance is SENSOR (or CANDIDATE-appropriate), confidence ≤0.60, and the subject is the speaker's person node — not an arbitrary proper noun (two-person corpus test).
- Given >3 plannable opportunities in an hour, when the excess is rate-limited, then each is re-queued or dead-lettered (observable, re-pollable) rather than marked planned (queue test).

## Environment
Local dev + any deploy. Source-trace at commit `228df73`.

## Notes / non-goals (optional)
- The validation-retry fix (#1/#2) is the highest-severity constraint-integrity issue here — ship first.
- Non-goal: semantic dedup or reworking the confidence/tiering rules; this is about correctness of the existing paths.
