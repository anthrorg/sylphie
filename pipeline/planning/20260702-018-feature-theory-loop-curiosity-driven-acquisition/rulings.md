# Architect rulings — learning/tensor cluster (items 011, 012, 014, 018)

Date: 2026-07-06 · Architect session A (parallel with two other sessions — no shared
files written; log entries below are staged as AD-A1..AD-A4 for the coordinator to
renumber and append serially to `docs/decisions/architect-log.yaml`).

All cited code read in full this session. Precedent honored: AD-0045..0054,
DEC-30..34 (EWC seam, lock discipline, use_learned pin, drive_rules lockdown,
guardian pool). These rulings are mutually constraining — interlocks are listed in §5.

---

## 1. Item 20260702-011 — Consolidation loop (Q1: extend EP-12 pipeline vs new label)

**RULING (AD-A1): One label, one shape, two producers — reuse `:Insight` with an
additive discriminator; do NOT extend cross-session-synthesis; the consolidation
loop lives in decision-making and triggers as an executor action, mirroring the
autonomous-research injection pattern.**

Neither (a) nor (b) as posed is right:

1. **Reuse the `:Insight` label and existing shape/InsightType enum. No new node
   label.** Additive schema extension (rides item 015's migration framework):
   - `insight_source: 'reflection' | 'synthesis' | 'consolidation'` (absent = legacy,
     read as reflection/synthesis via the existing `is_synthesis` flag).
   - New provenance edges for the new producer: `DERIVED_FROM -> (:Theory)` and
     episode provenance as node properties (`source_episode_ids: string[]`) — episodes
     are not WKG nodes (episodic store is deliberately local to DecisionMakingModule,
     `episodic-memory.service.ts:4-7`), so episode provenance is by-id, not by-edge.
   - Why one label: the WORLD-graph maintenance machinery is keyed to `:Insight` —
     orphan-prune explicitly protects it (`confidence-decay.service.ts:242`), decay
     handles provenance INFERENCE uniformly, cross-session synthesis pairs on it. A
     second label (`:ConsolidationInsight`) silently escapes all of that (ELSE-decay
     0.05, unknown prune semantics, invisible to synthesis) — exactly the schema
     incoherence item 015 exists to prevent.

2. **Do NOT feed episodic/theory candidates into `cross-session-synthesis`.** That
   service's confabulation guards are conversation-insight-pair-specific (verbatim
   descriptions, CITES check, `synthesized_insight_pairs` dedupe —
   `cross-session-synthesis.service.ts:124-127, 441-487`). Stretching it to
   episodes/theories rewrites its guard design, which the item's own non-goals forbid
   ("reuse or extend, don't rewrite"). Instead `atlas` extracts a shared WKG
   insight-writer contract (shape + confidence rules in one place); both producers
   call it.

3. **Trigger: no second naked `driveState$` threshold subscriber.** The existing
   pressure subscriber (`learning.service.ts:263-276`) fires the *maintenance* cycle
   (event→entity pipeline), not synthesis (synthesis is a 30-min timer,
   `learning.service.ts:230-238`) — so the "race" is real but structural, not a
   duplicate of the same work. The clean resolution: the source itself frames
   consolidation as "the consolidation action runs" — so trigger it the way
   autonomous research is triggered (`decision-tick-engine.service.ts:312-336`): on
   an idle self-tick (executor IDLE, no input, cooldown respected) with
   CognitiveAwareness over threshold, inject a synthetic consolidation action. This
   serializes consolidation through CycleGuard against everything else for free, uses
   the push-only drive read (CANON drive isolation clean), and leaves the learning
   maintenance subscriber untouched. Ticket -b's "shared in-flight guard" AC is
   REPLACED by "consolidation is a CycleGuard-serialized executor action; the
   learning maintenance cycle is unaffected (its own guard suffices)".

4. **Confidence:** INFERENCE provenance, base per `PROVENANCE_BASE_CONFIDENCE`
   (0.30), capped at the existing `SYNTHESIS_CONFIDENCE_CAP` **0.45**
   (`cross-session-synthesis.service.ts:83-89`) — do not mint a new cap. Ticket -c's
   "≤0.60" AC tightens to "≤0.45".

5. **Pressure relief (AC3) is an action outcome**, not a side effect: a new
   ACTION_TYPE_DEFAULTS entry (or guardian-approved rule) for the consolidation
   action type relieving CognitiveAwareness — the drive/skinner ticket. Relief only
   on a cycle that actually wrote ≥1 insight (theater prohibition: no relief for a
   no-op replay).

6. **The verify.md "re-weighting gap":** "re-weight confidence across related nodes"
   is SUBSUMED — upward by MERGE-raises-only on reinforced nodes, downward only via
   the sanctioned demotion path shared with item 018's verdict application (see
   interlock §5). No dedicated re-weighting mechanism (simplest thing; new scope
   would need Jim).

**Ticket changes:** -a = additive `:Insight` extension via 015 framework + the shared
writer contract (atlas). -b = tick-engine injection trigger (drop the second-subscriber
coordination AC). -c = cap 0.45. -d = demotion rides 018's sanctioned verdict path
(hard-blocked on 008 as planned). -e unchanged. -f unchanged. New small drive ticket:
consolidation action-type relief entry. Dependency chain 008 → 015 → 018 → 011 stands;
nothing queues before those land.

**CANON:** drive isolation clean (push-only, action-mediated); provenance honest
(INFERENCE, by-id episode provenance); 0.60 ceiling respected via 0.45 cap; theater —
relief tied to real writes; no guardian/eval surface touched.

---

## 2. Item 20260702-012 — Executor tension (5 forks)

### Q1 — `stakes(action, driveState)` contract

**RULING: continuous score + derived discrete tier; pure, table-driven, in
`packages/shared`; stakes-tier is a HARD CEILING on maximum bootstrap mode — not a
multiplier on the 0.85/0.79 thresholds.**

- Signature: `stakes(actionCategory: string, driveState: DriveSnapshot):
  { score: number /* [0,1] */; tier: 'LOW' | 'MEDIUM' | 'HIGH' }`. Zero-dependency
  pure function in `packages/shared` (same placement philosophy as
  `provenance.types.ts`), so decision-making computes it and drive-engine only ever
  receives the computed value inside pushed events (drive isolation preserved —
  drive-engine never calls it).
- Composition: `BootstrapTracker`'s numbers stay untouched (`bootstrap.py:55-57`:
  0.85 graduate / 0.70 demote / 0.90 full; `tensor-candidate-builder.ts:43-46`: 0.79
  / 0.95 caps). Tier ceiling: **LOW → may reach FULL; MEDIUM → may reach PARTIAL;
  HIGH → never beyond AUDIT** (tensor never decides HIGH-stakes actions). A ceiling
  is monotone and auditable; multiplying calibrated evaluation thresholds creates a
  second moving evaluation surface — Std-6-adjacent and rejected.
- Boundary rule (architect-fixed; the per-category base table is a build fixture
  cortex/luria fill against it): any action with irreversible or outward effect
  beyond conversation (unsanctioned DB writes, outward messages to non-guardians,
  device/actuator) = HIGH; durable knowledge writes = MEDIUM (quarantined `:Theory`
  writes = LOW, see §5); pure conversational/phrasing/exploration = LOW. Drive
  modulation: strong-negative-drive territory (max of Anxiety/Guilt/MoralValence
  pressure over a fixed threshold) bumps the tier one step, never down.
- Determinism ACs from the staged plan stand (byte-identical across calls, no
  tensor/network/DB input).

### Q2 — what mechanically is "the floor"

**RULING: the floor is a NEW small pure module (`executor-floor.ts`, decision-making)
— a hand-written, checksummable drive-conditioned action-category policy table. The
veto predicate is a pure function of (floor table, drive vector, action category,
stakes tier) and applies only to tensor-sourced candidates at arbitration.**

Verified ground truth: no action-*selection* floor exists today — `ACTION_TYPE_DEFAULTS`
(`rules.ts:80-179`) is an outcome-effects table consumed by `computeDefaultAffect()`,
and the only divergence mechanism (`decision-making.service.ts:882-890`) reads
`tensorResult.divergenceScore`, i.e. is downstream of the tensor, not tensor-blind.
So "what the executor would have done" must be *specified*, not recovered:

- `floorPolicy(driveVector): { permitted: Set<category>; preferred: category }` —
  deterministic dominance logic over a static table. Deliberately simple; it does NOT
  replace or alter existing arbitration (the source's "floor never modified" non-goal
  binds: existing behavior is unchanged when no tensor candidate is in play).
- Veto: `vetoed(category, driveVector, tier) := category ∉ permitted_tier(driveVector)`
  where the permitted set narrows with tier (LOW: everything not hard-prohibited;
  HIGH: exactly `preferred` ± explicitly-permitted). Tensor-blind by construction —
  its parameters cannot name a tensor type; static-analysis + property-test ACs from
  the staged plan stand.
- On veto: discard the tensor candidate; the cycle proceeds with remaining Type-1/LLM
  candidates (this IS "the executor reasserts"); log a new `FLOOR_VETO` event type
  (additive to `event.types.ts` + `EVENT_BOUNDARY_MAP`, DECISION_MAKING-owned) — a
  premium training signal, and it enriches the item-014 replay corpus for free.
- Guilt divergence_magnitude (feeds Q-accrual): 0 when the tensor category equals the
  floor's `preferred`; 1 on mismatch (prototype-level; refinement later). Accrual =
  `divergence_magnitude × stakes.score` per the source formula.

### Q3 — boot-checksum scope

**RULING: build the minimal standalone check now; do NOT hard-block on item 015;
failure mode is fail-closed-to-shadow, not fail-to-boot.**

- SHA-256 of the canonical serialized floor policy table + veto module source,
  verified at boot against a committed checksum. On mismatch: log loudly and REFUSE
  partial/full tensor modes (pin to shadow/audit) rather than refusing to boot —
  the checksum protects graduated autonomy, and killing conversation availability
  over it would be disproportionate. This is also the correct safety semantics:
  "no graduated autonomy without a verified floor."
- Item 015's invariant-check framework, when it lands, ABSORBS this check (ticket
  notes the convergence explicitly). A ~30-line hash check is not worth serializing
  behind an unbuilt framework when it gates a P0 safety property.

### Q4 — rule-strength write path

**RULING: NEITHER option. The vindicated/punished tolerance adjustment must NOT
touch `drive_rules` at all — not via the guardian pool, not via a new column. It is
decision-making-owned graduation state in a new additive table.**

This is the sharpest CANON call in the cluster. The adjustment is *autonomous*
(fires at outcome evaluation with no human in the loop). Writing `drive_rules`
through `POSTGRES_GUARDIAN_POOL` would execute autonomous writes under the
guardian_admin identity — laundering autonomy through the guardian role and
violating the exact threat model AD-0051/AD-0052 just locked down ("the AUTONOMOUS
runtime rewriting its own evaluation rules"; TK-154/155, PR #86). Ruled design:

- Per-action-class divergence tolerance / rule strength lives in a NEW
  decision-making-owned Postgres table (e.g. `action_class_tolerance`), additive
  migration, bounded values (tolerance clamped to a ruled band around its base —
  loosening can never exceed ±20% of the base tolerance; strengthening is unbounded
  toward zero-tolerance).
- Asymmetry mirrors the guardian-asymmetry spirit: punished-strengthen magnitude
  ≥ 2× vindicated-loosen magnitude (conservative ratchet — reuse the existing
  x2/x3 constants' pattern rather than minting a new weighting scheme).
- Std-6 separation holds the Type1Tracker pattern (`type1-tracker.service.ts:28-30`):
  the *evaluation* functions (MAE, qualifiesForGraduation/Demotion, BootstrapTracker
  thresholds) are never written by this path — only the tolerance *applied* to
  graduated autonomy changes.
- Guilt contingencies in Postgres drive state are seeded ONCE by a guardian-approved
  migration (human action — legitimate); at runtime Guilt accrual/resolution reach
  drive-engine exclusively as pushed events (new event types; never a call the drive
  process must answer). `guilt-repair.ts` untouched (separate relief path).
- migration.md shape: one additive decision-making table + one guardian-approved
  Guilt-contingency seed + Timescale event types. `drive_rules` untouched.

### Q5 (verify.md NEW) — Depressive Attractor does not read Guilt

**RULING: add Guilt to the existing detector's Signal 3 — one-line additive change,
no new detector, no threshold changes; source AC#5 is REWRITTEN accordingly.**

Verified: Signal 3 = `max(sadness, anxiety)` (`attractor-monitor.service.ts:488-491`)
and the composite is the mean of three signals (:499-514), so guilt-alone-high gives
~0.33 < 0.60 — Opus's finding is correct and ticket 012-i's premise was false. Ruled:
`worstNegativeDrive = max(sadness, anxiety, guilt)`. The all-three-signals-elevated
averaging design is KEPT deliberately: chronic guilt *while still acting and
predicting well* is not learned helplessness and must not fire the detector — that is
correct behavior, not a gap. 012-i re-scopes to: (i) the one-line drive-set change,
(ii) a fixture staging guilt>0.60 + elevated shrug + elevated MAE → fires, (iii) a
negative fixture (guilt high, shrug/MAE healthy) → does not fire. This is a
developer-time reviewed change to a monitor, not runtime self-modification — no
Std-6 tension; the detector's thresholds stay unreachable by any runtime path.

**Sequencing (unchanged from plan/verify):** blocked on 016 (snapshot-restore), 017
(tensor contract), 002 closing (live sidecar), per the dependency table. drive_rules
P0 is done (PR #86). Tickets b–i re-derive from these rulings; 012-a (the ruling
ticket) is satisfied by this document once logged.

---

## 3. Item 20260702-014 — Replay-from-events (OQ-1 + stage mapping)

### OQ-1 — can TrainingSample inputs be reconstructed?

**RULING: branch (a′) — "live-path fidelity" reconstruction. Materially better than
either side believed: the 768-dim fused embedding IS already persisted.**

New evidence neither the planner nor the verifier weighed:

1. **`sensory_ticks` persists `fused_embedding vector(768)` on every sampled frame**
   (`sensory-stream-logger.service.ts:99-115`, schema :183-193), with session_id,
   time, tick_number, and the drive snapshot. The primary input vector is durable —
   the "embeddings are absent from every event payload" finding is true of `events`
   but half-false of the event backbone as a whole.
2. **The live training path already runs with degraded optional fields**:
   `decision-making.service.ts:831-841` passes `undefined` episodicContext into
   inference, and `TrainingSample` defines episodic_context/modality_embeddings as
   optional with zero/empty defaults (`schemas.py:120-121`). "Full fidelity relative
   to what the model actually trains on" = fused_embedding + drive vectors + labels.

Ruled reconstruction contract, per field:
- `fused_embedding`: read from `sensory_ticks` (persisted, NOT recomputed).
- `drive_vector`/`drive_deltas`/`total_pressure`: from the event `drive_snapshot`
  chain (every SylphieEvent carries it — `event.types.ts:424-431`).
- Labels (`arbitration_type`, `action_category`, `outcome`, `drive_effects`,
  `prediction_mae`): from the correlated ACTION_EXECUTED / ARBITRATION_COMPLETE /
  PREDICTION_EVALUATED chain.
- `response_embedding`: recomputed deterministically from persisted response text
  through the versioned encoder (version pinned by item 017's contract; mismatched
  encoder version → recompute is flagged, not silently mixed).
- `episodic_context`, `modality_embeddings`: emitted as the schema's documented
  defaults (zero vector / empty dict), honestly matching the live path.
- Every sample carries a `fidelity` provenance block recording which fields were
  original / recomputed / defaulted, plus the replay run id and event range
  (provenance-required).

Consequences for ACs: AC1 holds (count vs qualifying joined events); AC2 holds
byte-identically (DB reads + versioned encoder; any augmentation must be explicitly
seeded); AC3 holds. NOT branch (c): no event-schema change is needed — the source's
non-goal survives intact.

**One load-bearing risk 014-a must measure first: join fidelity.** Both `logFrame`
call sites pass NO cycleId (`decision-making.service.ts:441`,
`decision-tick-engine.service.ts:372`), so tick→action joins are session_id +
nearest-time/tick_number. 014-a's audit must quantify join precision on a real
session; ambiguous joins are DROPPED, never guessed (the count AC counts qualifying
*joined* events). Surface as a finding + optional micro-ticket: populate the existing
`cycle_id` column at both call sites (wiring into an existing column, not a schema
change; historical rows stay time-joined) — sequenced with this epic, not absorbed
into 014-b.

### Stage/threshold mapping (verify.md Q2)

**RULING: AC3 targets the partial-graduation bar, reworded.** Audit *stage* is a
volume gate (100 comparisons, `bootstrap.py:233-235`) and proves nothing about
learned competence; "audit-stage agreement" in the source is loose wording. 014-c's
AC becomes: after retrain-from-replay, the model re-enters at `shadow` with an empty
graduated set, and the most-populated action category subsequently **graduates**
(≥0.85 agreement over ≥20 samples per `check_graduations()`, `bootstrap.py:101-128`)
within the test run. Thresholds themselves untouched (non-goal preserved).

Naming: keep the planner's constraint — the new tool must not collide with
`training/replay.py` (the Online-EWC buffer, docstring lines 1-20); name it
`event-replay`/`experience-reconstruction`, placed per owning expert. The
`verified_training_samples` manifest comparison stays deferred until 016/017 land;
count/category-distribution reporting stands alone.

---

## 4. Item 20260702-018 — Theory loop (2 forks)

### Q1 — `Tess_Confirmed` vs the 0.60 ceiling

**RULING: option (a) — TESS_CONFIRMED stays within the ≤0.60 non-guardian ceiling.
"High confidence for non-experiential knowledge" = the TOP of the non-guardian band
(0.60) with GUARDIAN-slow decay — never above it. Option (b) is a CANON Std-3/Std-5
change: available ONLY via `update-canon` with Jim's explicit approval, and my
recommendation is NO.**

Grounds: `provenance.types.ts` reserves the above-ceiling path exclusively to
guardian confirmation (0.90, Std-5 — :184-194), and the non-guardian evidence
hierarchy already tops out at exactly 0.60 (`deriveOkgFactTier` cases b/c/d,
:220-244). Tess is an automated statistical pipeline; granting it the guardian
exception would (i) split the guardian asymmetry that the whole trust model hangs
on, and (ii) blur the very line this item's own Hallucinated-Knowledge sharpening
depends on. The feature loses nothing: 0.60-slow-decay is durable, dominant over all
other non-guardian knowledge, and epistemically honest.

Mechanics ruled:
- New extended provenance value `TESS_CONFIRMED`. Promotion function:
  `confidence = min(0.60, 0.35 + 0.25 × tess_verdict_confidence)` (monotone from the
  LLM_GENERATED base; exactly 0.60 at Tess confidence 1.0). Decay rate **0.03**
  (GUARDIAN-slow) added to ALL THREE CASE sites in
  `confidence-decay.service.ts` (:140-146 nodes, :197-203 edges, :294-299 OKG) —
  today an unhandled value silently falls to ELSE 0.05, which would quietly defeat
  "decays slowly".
- Refuted: `status: 'refuted'`, confidence set to 0.10 (prune band) but the node
  retained as the spawned-from anchor; Curiosity discharge via a pushed action
  outcome; spawn the "why was I wrong" theory with `spawned_from`. Inconclusive:
  status stays open, no confidence change, NO curiosity relief, re-eligible after a
  cooldown.
- Detector interaction (structural, worth recording): `detectHallucinatedKnowledge`
  matches `(n:Entity)` only (`attractor-monitor.service.ts:369-394`), and theory
  writes are quarantined `:Theory` nodes (018-a) — so autonomous acquisition cannot
  trip the 20% detector by volume. TESS_CONFIRMED does NOT join that detector's
  trusted set (it is non-experiential and non-guardian); the new precision metric
  (confident-but-never-verdicted ratio) is additive per plan B4.

### Q2 — Tess transport contract

**RULING: asynchronous file-drop (outbox/inbox), mirroring this repo's own pipeline
cog pattern. Not a sync CLI subprocess; not a queue.**

- The source's own contract is asynchronous ("Sylphie proposes continuously; verdicts
  land on their own schedule") — a 10-stage Beta-statistics pipeline has
  minutes-to-hours latency; a blocking subprocess is architecturally wrong. A queue
  is unjustified new infra for a single-consumer, low-rate, local integration
  (same no-new-deployable reasoning as AD-0051).
- Convention: `tess/outbox/<theory_id>.request.json` written by Sylphie;
  `tess/inbox/<theory_id>.verdict.json` written by Tess; Sylphie-side poller applies
  verdicts idempotently (processed files moved to `tess/processed/`); malformed or
  unknown `schema_version` → `tess/deadletter/` + loud log, never guessed.
- Request payload v1: `{ schema_version: 1, theory_id, claim, source_node_ids[],
  context: { entity_labels[], evidence?[] }, proposed_at, requested_by: 'sylphie' }`.
- Verdict payload v1: `{ schema_version: 1, theory_id, verdict:
  'confirmed'|'refuted'|'inconclusive', confidence: [0,1], rationale?,
  evidence_refs?[], verdict_at }`.
- Verdict application is THE sanctioned demote/promote path for theory-derived
  knowledge (see interlock — item 011's contradiction pruning rides it).

Minor rulings folded in (from verify.md criticals): 018-a's `confidence: 0.35`
literal must derive from `PROVENANCE_BASE_CONFIDENCE.LLM_GENERATED`, not be
hardcoded (the value is right; the coupling is wrong). Staleness threshold for
`pickResearchTarget` (currently confidence-only, `decision-tick-engine.service.ts:
411-436`): briefing-builder decides with a logged governance assumption (suggest
default 72h); confirm `queryEntities('*')` actually returns a timestamp before
018-b is built — if not, 018-b's scope grows a read-path change and must say so.
Epic split stands: A (acquisition, buildable after 008 tickets) / B (confirmation,
now unblocked by these rulings but still sequenced after 015/016).

---

## 5. Interlocks (how the rulings constrain each other)

1. **018 → 011:** verdict application (018) defines the ONE sanctioned demotion path;
   011's contradiction pruning (ticket -d) rides it — no second demote mechanism.
   Confidence ordering is deliberate: consolidation insights cap at 0.45 <
   theory-promotion 0.60 < guardian 0.90 (second-order inference < verified atom <
   guardian truth).
2. **012 → 018/011:** stakes classification of the new autonomous actions —
   `RESEARCH_ENTITY`/theory-writes = LOW stakes *because* writes are quarantined
   non-groundable `:Theory`; consolidation writes = LOW/MEDIUM (capped 0.45,
   MERGE-raises-only). The quarantine rulings are what make autonomous idle behavior
   low-stakes; remove either and the stakes table must be revisited.
3. **012 → 014:** `FLOOR_VETO` and guilt accrual/resolution events enrich the replay
   corpus (014 is read-only over whatever event types exist — no conflict). A
   replay-retrained model re-enters shadow AND stays under 012's stakes-tier
   ceilings — the ceiling is static policy, not agreement state, so retraining can
   never launder a HIGH-stakes category into full mode.
4. **017 underpins 012 and 014:** graduation durability (012) and recompute
   determinism / encoder versioning (014) both hang off the versioned tensor
   contract — 017 stays ahead of both in sequence.
5. **015 absorbs 012's checksum:** the minimal boot-checksum (012-Q3) is explicitly
   convergent with 015's invariant framework; 015's plan should list it as an
   incoming invariant.

## 6. ESCALATE-TO-JIM

None blocking. One flagged escape hatch: if Jim *intends* Tess to be a second
above-0.60 epistemic authority (guardian-equivalent for non-experiential knowledge),
that is a CANON Std-3/Std-5 change requiring `update-canon` + his explicit approval.
Ruled design (a) does not need it and my recommendation is against it.

## 7. Staged decision-log entries

See the YAML block returned to the coordinator (AD-A1..AD-A4) — renumber to the next
free AD-00xx ids and append serially to `docs/decisions/architect-log.yaml`.
