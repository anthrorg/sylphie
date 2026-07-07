# Plan — 20260702-006: Learning/Planning/Supervisor validation-retry + provenance bugs

## Source verification (all claims confirmed against source at HEAD `13a33e8`; no drift from the source-trace commit `228df73` — `git log` on every named file shows no commits since)

All four required-Acceptance claims were read in full and confirmed line-for-line:

1. **Validation retry writes the ORIGINAL failing proposal — CONFIRMED.**
   `packages/planning/src/planning.service.ts:582` sets `let currentProposal = planProposal;`, calls
   `this.constraintValidation.validate(currentProposal, opportunity)` at :583-586, and never reassigns
   `currentProposal` again before `this.procedureCreation.createProcedure(currentProposal, opportunity)`
   at :649. `ValidationResult` (`packages/planning/src/interfaces/planning.interfaces.ts:232-248`) has
   no `proposal` field. Inside `ConstraintValidationService.validate()`
   (`packages/planning/src/pipeline/constraint-validation.service.ts:120-183`) there IS a local
   `currentProposal` that gets reassigned to the refined proposal on each retry (:159-163) and IS used
   for the next attempt's validation — but `runValidation()` (:193-230) never puts that proposal on the
   returned `ValidationResult`, so the caller has no way to get it back. A pass on attempt ≥2 writes the
   attempt-1 (failing) proposal under a `PLAN_VALIDATED` event. Confirmed exactly as described — a real
   constraint-bypass.

2. **`refine()` zeroes `predictedDriveEffects` — CONFIRMED, and the actual fix is simpler than the source's framing suggests.**
   `ProposalService.propose()` populates `predictedDriveEffects` from
   `simulation.bestOutcome?.estimatedDriveEffect` via a `withStableTrigger(proposal, opportunity, { predictedDriveEffects: ... })`
   override (`proposal.service.ts:87-91`). `ProposalService.refine()` (:107-130) calls
   `this.withStableTrigger(refined, opportunity)` at :118 **without** that override, so whatever
   `refined` carries wins — and `refined` comes from `refineLlm` → `parseLlmProposal`, which always
   returns `predictedDriveEffects: {}` (:367, :381, comment "populated by the caller from simulation" —
   a caller that, on the refine path, never does). `checkNoTheatricalBehavior`
   (`constraint-checks.ts:203-238`) fails any expressive step (`LLM_GENERATE`/`TTS_SPEAK`) with an
   all-zero drive-effect map. Confirmed. **Correction to the source's framing**: `IProposalService.refine()`
   (`planning.interfaces.ts:183-187`) does not receive `simulation` at all, so there's no thread-the-simulation-through
   fix available without a signature change — but none is needed. `predictedDriveEffects` is a
   property of the *opportunity/category*, not of the proposal's wording, so the correct minimal fix is
   to carry the *original* proposal's `predictedDriveEffects` forward across refinement
   (`withStableTrigger(refined, opportunity, { predictedDriveEffects: original.predictedDriveEffects })`) —
   a one-line change, no interface/call-chain changes.

3. **Provenance falsification — CONFIRMED, unconditional, comment does not match code.**
   `extract-typed-edges.service.ts`: the edge write at :487-493 and the `edges.push` at :500-509 both use
   `triple.source === 'self_reported' ? 'GUARDIAN' : 'SENSOR'` / `? 0.60 : 0.40` **unconditionally** —
   with no check of `valueAsCandidate`/subject-liveness at all. The comment at :447-453 claims GUARDIAN
   "applies only when the subject is already a live entity," but that condition (`valueAsCandidate`,
   used at :454-480) is applied only to the **object**-entity upsert, never to the **edge**'s own
   provenance/confidence. Confirmed exactly as claimed — every self-reported conversational fact gets
   GUARDIAN/0.60, the slowest decay rate (`confidence-decay.service.ts:141-146`: GUARDIAN=0.03 vs
   SENSOR=0.05).

4. **Speaker facts attach to an arbitrary entity — CONFIRMED, and worse than described.**
   `findSpeakerEntity` (:738-746) is `entities.find(GUARDIAN) ?? entities.find(SENSOR) ?? entities.find(isCandidate)`,
   called **once per event** over *all* entities extracted from the utterance
   (`extract-typed-edges.service.ts:407`), with **no filtering by the actual speaker's identity**. Per
   the file's own header comment (`upsert-entities.service.ts:19-30`), post-Wave-3/C3 every
   conversation-derived proper noun mints as `:Candidate` — there is no dedicated "speaker" node minted
   at all. So for "I love Minecraft," the only extracted entity is "Minecraft" itself, and
   `findSpeakerEntity` returns it as the fallback "candidate" — subject and object become the same node
   (`(Minecraft)-[LIKES]->(Minecraft)`). `event.payload.speakerId` (a stable identifier,
   `extractSpeakerId` at :721-724) exists and is already used to *scope* value-Candidate nodes
   (`groundingPersonId`, :460/:478) but is never used to resolve the *subject* itself.

5. **Rate-limited/rejected opportunities permanently marked planned — CONFIRMED.**
   `planning.service.ts` ingest loop: the `finally` block at :325-346 runs
   `UPDATE events SET payload = jsonb_set(..., '{has_planned}', 'true')` for **every** row regardless of
   whether `this.queue.enqueue(queued)` (:271) returned `true` or `false` — rate-limited (:104-114),
   duplicate (:88-102), or hard-cap-outranked (:120-136) rejections all still get marked planned and are
   never re-polled. Separately, the deferred-opportunity re-enqueue at :619-625 (`executePipeline`) logs
   only `this.logger.warn(...)` when `this.queue.enqueue(opportunity)` returns false — no dead-letter, no
   event, the opportunity is simply gone from the in-memory queue. `MAX_PLANS_PER_WINDOW = 3` confirmed
   (`opportunity-queue.service.ts:63`). Confirmed exactly as claimed.

**Verified holding, no ticket needed** (per source's own "do not re-file" list — spot-checked, not
re-litigated): fail-closed conflict detection (`constraint-validation.service.ts:96-116` returns
`deferred:true` on WORLD-unreachable, never a blind pass) and the stable dedup key
(`withStableTrigger`); person-fact `:Candidate` staging for **object/value** entities (Wave-3/C3, already
landed — the residue is exactly the two provenance/subject findings above, which is why they're ticketed
here, not that staging mechanism itself).

**"Lower" bullet list (8 additional distinct defects across learning/planning/supervisor)**: read but
**not verified line-by-line** and **not ticketed here** — see `split_recommendation`. They are not in the
source's required "Acceptance — how we'll know it's fixed" section (which lists exactly 4 GWT criteria,
matching the 4 findings above), the source itself labels them "Lower," and ticketing 8 more independent
root causes here would blow this item's scope past what its own acceptance section asks for.

## Existing contract overlap

Searched `planning/contract.yaml` (read-only) for every named file and symbol
(`constraint-validation.service.ts`, `proposal.service.ts`, `extract-typed-edges.service.ts`,
`opportunity-queue.service.ts`, `findSpeakerEntity`, `currentProposal`, `has_planned`, `predictedDriveEffects`).

- **No existing epic or ticket fixes any of these 4 bugs.** `EP-12` (learning, Tier-5 residuals) and
  `EP-14` (planning, Tier-5 residuals) are both `status: done` and cover a disjoint set of fixes: `TK-62`
  (deferral exponential backoff — the *retryAfter* mechanism, not the has_planned mis-mark), `TK-63`/`TK-64`
  (simulation cross-drive aggregation / sample-size confidence), `TK-65` (constraint-validation
  trigger-context wiring — confirms the *conflict* check is live, unrelated to the retry-proposal bug).
  None of these touch `ValidationResult`, `refine()`'s drive-effect handling, provenance assignment, or
  `findSpeakerEntity`.
- **Adjacent but distinct open_questions** (not duplicates — different root cause, do not attach to
  them): `Q-8` (scope EP-14) proposes priority-eviction on the hard-cap queue path — the eviction
  mechanism described there already exists in code (`opportunity-queue.service.ts:116-151`), so `Q-8`
  reads stale/resolved; it does not cover the has_planned-on-rejection bug (finding 5) which is a
  *different* code path (the ingest `finally` block, not the hard-cap eviction). `Q-21` (scope EP-14)
  flags missing per-row try/catch in `ingestOpportunities` — a different concern (a JSON.parse blowing up
  the whole batch) than finding 5 (successfully-parsed rows silently marked planned on rejection).
- **Recommendation**: stage a **new** epic (this pipeline follows the `EP-27`/`TK-153`-style precedent
  of giving an audit-sourced bug batch its own fresh epic under `FEAT-2` or `FEAT-3`, rather than
  reopening a `status: done` Tier-5 epic) — proposed as `EP-NEW` below with 4 tickets. Final numeric
  `EP-`/`TK-` ids are assigned at contract-write time, not by this plan.

## Proposed epic

```yaml
id: EP-NEW  # numeric id assigned at contract-write time
kind: epic
parent: FEAT-2  # or FEAT-3, coordinator's call at write time — matches sibling audit-bug epics
title: "Bug fix — planning validation-retry proposal/theater-effect loss, learning provenance/subject falsification, planning opportunity silent-drop"
priority: P1
status: todo
intent: >
  Four independently-testable correctness fixes surfaced by the 2026-07-02 repo bug audit
  (docs/audits/repo-bug-audit-2026-07-02.md §5): (a) the planning validation-retry loop discards the
  refined proposal and writes the original failing one; (b) proposal refinement zeroes the drive-effect
  prediction that grounds the theater check; (c) conversation-derived facts are unconditionally stamped
  GUARDIAN provenance and can attach to an arbitrary noun instead of the speaker; (d) opportunities
  rejected by the planning queue (rate-limit/dedup/capacity) are marked planned and never revisited.
design_refs: ["docs/audits/repo-bug-audit-2026-07-02.md#5"]
```

## Tickets

### 20260702-006-a — Validation retry must write the proposal that actually passed, not the original

```yaml
working_id: 20260702-006-a
title: "Planning: constraint-validation retry returns the (possibly refined) proposal that passed, not the original"
priority: P1
engineering_level: production
owner: planner (domain expert) ; conceptual_reviewer: scout ; code_reviewer: code-reviewer
depends_on: []
files_in_scope:
  - packages/planning/src/interfaces/planning.interfaces.ts   # ValidationResult
  - packages/planning/src/pipeline/constraint-validation.service.ts  # validate()/runValidation()
  - packages/planning/src/planning.service.ts                 # executePipeline: use result.proposal
non_goals:
  - "Changing constraint-check logic itself (checkStepTypeValidity, checkProcedureConflict, etc.) — only propagation of which proposal was checked"
  - "Changing the refine() retry count/backoff (MAX_RETRIES=3) or the deferred/WORLD-unreachable path"
  - "Touching proposal.service.ts's refine() body (that's 20260702-006-b)"
acceptance_criteria:
  - given: "ValidationResult (planning.interfaces.ts:232-248) today carries no proposal field, and constraint-validation.service.ts's runValidation() (193-230) discards the proposal it just validated"
    when: "ValidationResult gains a readonly `proposal: PlanProposal` field, set by every return path in runValidation() to the exact proposal it checked, and validate()'s loop (120-183) uses this on every return (pass, exhausted-retries, refine-threw)"
    then: "a unit test in constraint-validation.service.spec.ts constructs an opportunity whose attempt-1 proposal fails a constraint and whose FakeProposalService.refine() returns a distinct, passing proposal object; calling validate() returns passed:true and result.proposal is reference-equal to the refined object, NOT the original — runnable via `npx tsx packages/planning/src/pipeline/constraint-validation.service.spec.ts`"
  - given: "planning.service.ts's executePipeline (582-586, 649) calls createProcedure(currentProposal, ...) where currentProposal is the pre-validation proposal and is never reassigned"
    when: "the createProcedure call site is changed to use validationResult.proposal instead of currentProposal"
    then: "a new unit test packages/planning/src/planning.service.spec.ts (new file, following the FakeNeo4j/FakeEventLogger pattern already used in constraint-validation.service.spec.ts) stubs constraintValidation.validate() to return passed:true with a `proposal` distinct from the proposal ProposalService.propose() returned, and asserts procedureCreation.createProcedure was called with that distinct (refined) proposal — runnable via `npx tsx packages/planning/src/planning.service.spec.ts`; add this file to packages/planning/package.json's `test` script chain"
```

### 20260702-006-b — Refined proposals must keep their predicted drive effects (theater check stays meaningful on retry)

```yaml
working_id: 20260702-006-b
title: "Planning: proposal refinement carries forward predictedDriveEffects instead of zeroing it"
priority: P1
engineering_level: production
owner: planner ; conceptual_reviewer: scout ; code_reviewer: code-reviewer
depends_on: []
files_in_scope:
  - packages/planning/src/pipeline/proposal.service.ts   # refine()
non_goals:
  - "Re-deriving predictedDriveEffects from a fresh simulation call on refine (out of scope; the value is a property of the opportunity/category, not the proposal wording — carrying the original forward is correct and sufficient)"
  - "Changing IProposalService.refine()'s signature or threading SimulationResult through it"
  - "Changing checkNoTheatricalBehavior's pass/fail rule"
acceptance_criteria:
  - given: "ProposalService.refine() (proposal.service.ts:107-130) calls this.withStableTrigger(refined, opportunity) at :118 with no predictedDriveEffects override, so an LLM-refined proposal's predictedDriveEffects is always {} (parseLlmProposal, :367/:381)"
    when: "the withStableTrigger call at :118 is changed to withStableTrigger(refined, opportunity, { predictedDriveEffects: original.predictedDriveEffects })"
    then: "a unit test in proposal.service.spec.ts calls refine() with an `original` proposal carrying a non-empty predictedDriveEffects map and an expressive (LLM_GENERATE) action step, stubs the LLM to return a refined proposal, and asserts the returned proposal's predictedDriveEffects deep-equals original's (non-zero) — AND that checkNoTheatricalBehavior(result) from constraint-checks.ts returns passed:true — runnable via `npx tsx --tsconfig packages/planning/tsconfig.json packages/planning/src/pipeline/proposal.service.spec.ts`"
  - given: "the LLM-unavailable fallback path in refine() (:128-129) returns `original` unchanged"
    when: "no code change is needed here (already correct)"
    then: "an existing/new assertion in the same spec confirms this path is untouched: refine() with a null/unavailable llm returns the exact original object, predictedDriveEffects intact"
```

### 20260702-006-c — Conversation-derived facts: correct provenance (no false GUARDIAN) and correct subject (speaker, not an arbitrary noun)

```yaml
working_id: 20260702-006-c
title: "Learning: self-reported conversational facts get SENSOR/CANDIDATE provenance (not GUARDIAN) and attach to the actual speaker (not an arbitrary extracted noun)"
priority: P1
engineering_level: production
owner: learning (domain expert) ; conceptual_reviewer: piaget ; code_reviewer: code-reviewer
depends_on: []
files_in_scope:
  - packages/learning/src/pipeline/extract-typed-edges.service.ts
non_goals:
  - "Reworking the confidence-decay tiering or decay-rate constants (confidence-decay.service.ts) — CANON confidence ceiling (0.60) stays; only which tier/rate applies changes"
  - "Semantic dedup of :Candidate value nodes"
  - "A one-time backfill/re-provenance pass over already-written GUARDIAN-stamped edges — that is a separate governance decision (see migration.md), not part of this ticket's runnable check"
  - "Changing how GUARDIAN_CORRECTION/GUARDIAN_CONFIRMATION events (actual guardian teaching, a different event type) are provenanced — this ticket is scoped to INPUT_RECEIVED/INPUT_PARSED (conversational, self_reported) triples only"
acceptance_criteria:
  - given: "the edge write (writeTypedEdge call, extract-typed-edges.service.ts:487-493) and the edges.push record (:500-509) both set provenance/confidence via `triple.source === 'self_reported' ? 'GUARDIAN' : 'SENSOR'` / `? 0.60 : 0.40` unconditionally, ignoring whether the subject is a live GUARDIAN entity or an unverified :Candidate"
    when: "both sites are changed to condition on the same `valueAsCandidate`-style test already used for the object entity at :454-480 (i.e., self_reported input from a non-guardian speaker on a :Candidate subject gets CANDIDATE_PROVENANCE_TYPE / confidence capped at 0.60, never GUARDIAN)"
    then: "a two-speaker unit test (new describe block in a new/extended extract-typed-edges.service.spec.ts) sends an INPUT_RECEIVED event with a self_reported speaker triple for speaker A ('I like coffee'), asserts the resulting edge's provenance is NOT 'GUARDIAN' and confidence <= 0.60 — runnable via `npx tsx packages/learning/src/pipeline/extract-typed-edges.service.spec.ts` (create if absent, following the plain node:assert pattern used elsewhere in this repo)"
  - given: "findSpeakerEntity (extract-typed-edges.service.ts:738-746) resolves the subject of a subjectHint==='speaker' triple by scanning ALL extracted entities for the first GUARDIAN, else first SENSOR, else first :Candidate — a purely positional heuristic with no identity check, so for 'I love Minecraft' the only extracted entity (Minecraft) is picked as both subject and object"
    when: "subject resolution for subjectHint==='speaker' triples is changed to resolve/merge a stable per-speaker node keyed by `speakerId` (extractSpeakerId(event), already available and already used to scope object :Candidate nodes at :460/:478) — using the same mergeCandidateNode-style MERGE-by-grounding_person_id pattern already established in this file for value entities, rather than picking from the entities array"
    then: "the same two-speaker unit test asserts: (1) speaker A's 'I like coffee' produces an edge whose subject node is NOT the same node as the object ('coffee'); (2) speaker B's separate utterance in the same test run produces a DIFFERENT subject node than speaker A's, keyed to B's speakerId; (3) a third-person triple (subjectHint !== 'speaker', e.g. 'Alice likes tea') is unaffected — its subject still resolves via `_subjectLabel` as before"
```

### 20260702-006-d — Opportunities rejected by the planning queue must be re-queued or dead-lettered, never marked planned

```yaml
working_id: 20260702-006-d
title: "Planning: rate-limited/duplicate/capacity-rejected opportunities are not silently marked has_planned=true; deferred re-enqueue rejections are observable"
priority: P1
engineering_level: production
owner: planner ; conceptual_reviewer: scout ; code_reviewer: code-reviewer
depends_on: []
files_in_scope:
  - packages/planning/src/planning.service.ts        # ingestOpportunities finally block (325-346); executePipeline deferred re-enqueue (619-625)
  - packages/planning/src/queue/opportunity-queue.service.ts   # enqueue() return semantics (unchanged, just consumed correctly)
non_goals:
  - "Building a persistent dead-letter table/queue — 'observable, re-pollable' is satisfied by NOT marking has_planned=true (row stays eligible for the next poll) plus an event-logged reason; a durable dead-letter store is future scope"
  - "Changing MAX_PLANS_PER_WINDOW (3/hr), MAX_QUEUE_SIZE, or the hard-cap eviction comparison logic itself"
  - "Deduplicating true duplicates (same contextFingerprint already queued) differently — a duplicate reject is intentional and the row can stay marked planned (the fingerprint's other copy is still live); this ticket's scope is rate-limit + hard-cap-outranked + deferred-reenqueue-rejected"
acceptance_criteria:
  - given: "ingestOpportunities' finally block (planning.service.ts:325-346) runs the has_planned=true UPDATE for every row regardless of whether `this.queue.enqueue(queued)` (:271) returned true or false"
    when: "the finally block is changed to only mark has_planned=true when `accepted` is true (or the row was a duplicate — see non_goals); when enqueue() returns false for rate-limit or hard-cap-outranked reasons, the row is left unmarked (has_planned stays false) so the next poll picks it up again"
    then: "a unit test seeds >3 opportunities within the rate-limit window against a real OpportunityQueueService, runs ingestOpportunities against a fake Timescale client recording UPDATE calls, and asserts the UPDATE(has_planned=true) was issued for exactly the 3 accepted rows and NOT for the rate-limited excess — runnable via a new/extended spec in packages/planning/src (e.g. planning.service.spec.ts from 20260702-006-a, or a new ingest-focused spec), added to packages/planning/package.json's test script"
  - given: "executePipeline's deferred-opportunity re-enqueue (planning.service.ts:619-625) only calls this.logger.warn(...) when this.queue.enqueue(opportunity) returns false — no event log, no dead-letter, the opportunity is simply gone"
    then: "the rejected-re-enqueue branch additionally emits an eventLogger.log('OPPORTUNITY_DROPPED', { opportunityId, reason: 'deferred_reenqueue_rejected', ... }) (matching the existing OPPORTUNITY_DROPPED event shape already used elsewhere in this file, e.g. :601-606) so the drop is observable in the event log rather than only a debug-level warn"
    when: "a unit test forces queue.enqueue() to return false on the deferred re-enqueue path and asserts eventLogger.log was called with type 'OPPORTUNITY_DROPPED' and reason 'deferred_reenqueue_rejected'"
```

## DB gate

See `migration.md` in this folder. No schema/structural change to any store. Neo4j WORLD property
*values* (provenance_type, confidence) and a TimescaleDB `events.payload` JSONB field are written by
existing code paths using the existing model — no new labels, constraints, indexes, columns, or
migrations. A **backfill** of already-mis-provenanced historical edges is explicitly flagged as an
optional, separate governance decision, not part of these 4 tickets.

## Routing recommendation: refine

All four tickets are atomic, independently testable (each has a runnable check with no shared
preconditions), grounded in verified source (no fictional claims), have no CANON conflict (the fixes
*restore* CANON compliance — provenance-required, confidence-ceiling, theater-prohibition — rather than
create new tension), and require no schema change. No design fork was found for tickets a/b/d. Ticket
c's subject-resolution fix extends an *already-established* in-file pattern (per-speaker `:Candidate`
staging via `speakerId`, `mergeCandidateNode`) to a new call site rather than inventing a new mechanism,
so it does not need an architect ruling either — flagged as an open_question below only for the *optional
historical backfill*, not for the forward fix.

## Open questions (route to architect/Jim via governance, NOT guessed, NOT blocking these 4 tickets)

- **OQ-1**: Should the historical GUARDIAN-stamped conversation edges and any ActionProcedure nodes
  written from a pre-fix wrong-original-proposal bug be backfilled/re-provenanced once 006-a/006-c ship?
  Source explicitly flags this as "a migration-plan decision, not a schema change" — needs a decision on
  whether a one-time Cypher backfill script (dry-run/confirm per `pipeline/policies/db-change-safety.md`)
  is worth the risk/cost versus leaving pre-fix data as-is and accepting the historical mis-attribution.
  Not a blocker for shipping the forward fix.

## Split recommendation

The source's "Lower" bullet list bundles **8 additional, independently-rooted defects** across
learning/planning/supervisor that are **not** covered by the source's own required "Acceptance" section
(which defines exactly the 4 findings ticketed above) and are explicitly self-labeled lower severity:
(1) re-grounding sweep can push INFERENCE confidence past 0.60 (unclamped ratio) — a **confidence-ceiling
CANON concern**, arguably deserves its own priority triage, not lumped in as an afterthought; (2)
transient LLM failure forfeits a session's reflection permanently; (3) `markAsLearned` swallows failures
→ duplicate `:Conversation` nodes; (4) sidecar 400s counted as breaker failures; (5)
`ADDRESSES_OPPORTUNITY` constraint vacuous; (6) `pendingInterventions` unbounded/unread; (7) decayed
`:Candidate` orphans never pruned; (8) `updateEdgeType` non-transactional. Recommend these become a
**separate pipeline item** (e.g. re-filed from `docs/audits/repo-bug-audit-2026-07-02.md` §5's "lower"
findings as its own bug-batch intake item) rather than folding them into this item's ticket set — they
have no acceptance criteria in the current source and would need their own Given/When/Then before they're
plannable; bundling them here would exceed this item's own stated scope. Not creating that item folder
myself per instructions — flagging for the coordinator/Jim to decide whether to re-file.
