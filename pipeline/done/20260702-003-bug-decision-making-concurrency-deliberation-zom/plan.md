# Plan — 20260702-003 — Decision-making concurrency & deliberation defects

- **Type:** bug · **Severity:** high / P1 · **Route:** EP-INTAKE (staged) · **DB:** no (see migration.md — keyword false positive)
- **Owners (work-trio):** `cortex` (conceptual: `luria`), code review: `code-reviewer` — matches `packages/decision-making/**` row in CLAUDE.md
- **Target epic at contract-write:** `EP-21` (parent `FEAT-3`). Working ids below (`003a-1` etc.) are
  labels only — numeric `TK-<n>` ids are assigned by the schema when actually written to
  `planning/contract.yaml` (NOT done by this pass — staged only).

## Classification (plan cog)
Ingest type `bug` and title correct — no `set` needed. Audit-derived
(`docs/audits/repo-bug-audit-2026-07-02.md` §1) with exact file:line evidence.

## Discovery (verified against source, 2026-07-02)
codebase-pkg MCP unavailable this run — direct full-file reads (Haiku reader fan-out) plus
targeted re-confirmation of the two loci this revision depends on:

**All 6 original load-bearing claims CONFIRMED:**
1. `concurrency/cycle-guard.service.ts:547-551` — `finally` unconditionally runs `disarmWatchdog(); tickInFlight=false; inFlightTurn=null`; epoch guard (:555) covers only `completed$`/breaker. CONFIRMED.
2. `llm/ollama-llm.service.ts` — `chatTimeoutMs` read (:112) and logged (:129), applied only to the DeepSeek fetch (`AbortSignal.timeout`, :185); both `client.chat()` calls (:335, :449) pass no signal. CONFIRMED.
3. `tick-engine/decision-tick-engine.service.ts:348-398` — self-ticks bypass CycleGuard; a hung `processInput` (:387) leaves `selfTickInFlight` true forever (:398 unreached). `notifyExternalComplete()` at :403 confirmed present — the watchdog fix must call it or the queued-turns-forever bug re-appears via a different path. CONFIRMED.
4. `deliberation/deliberation.service.ts:641` — `confidence = 0.5 + (selectedIndex === 0 ? 0.1 : 0)` (max 0.6) vs `DEBATE_THRESHOLD = 0.7` (:213) → debate unconditional, ~5 LLM calls. CONFIRMED.
5. Breaker — threshold 5, `available=false`, no auto-probe; manual reset only (`llm.controller.ts:60`); counter shared across tiers. CONFIRMED.
6. `recall-retrieval.ts:517-518` (now :517-519 in current source) — early-return null provenance when already GROUNDED, checked BEFORE the `valueSurfacesAsWord` honesty guard (:525); reinforcement gate `decision-making.service.ts:1993-1999` requires `factNodeId === responseGroundingProvenance` → rarely fires; `discriminateGroundedBy` has no production caller (specs only). CONFIRMED — re-read `recall-retrieval.ts:490-534` directly this pass.

**Re-confirmed this pass (per architect DEC-31 / AD-0048 grounding of the 003c fork):**
- `recall-retrieval.ts:504-534` (`applyRecallGroundingFromRetrieval`) is the single shared function
  behind all four call sites. Its own doc comment (:497-499) already states the CRUCIAL T1
  DISTINCTION contract — "the node id is returned WHENEVER the value surfaced" — that the
  current code violates by ordering the GROUNDED early-return (:517-519) BEFORE the surfaced
  check (:525-528). The fix is: swap the order, inside this one function only (~6 lines).
- All four call sites confirmed calling the shared function unchanged: `deliberation.service.ts:446`
  (short-circuit path), `deliberation.service.ts:813` (post-arbitration novel-deliberation path),
  `decision-making.service.ts:1060` (latent Type-1 replay path), `decision-making.service.ts:1151`
  (procedure-handler path). None of the four call sites need to change — the shared-function fix
  covers all of them, per DEC-31. Do NOT reorder/merge logic at `deliberation.service.ts:420-450`
  (an earlier proposal considered and rejected).
- Write-time person-scoping (`decision-making.service.ts:1627-1640`) confirmed: `groundingPersonId
  = responseGroundedBy === 'WKG' ? null : currentSpeakerId` — world-scope ONLY for a provably-WKG
  source; OKG or ambiguous → person-scope (conservative-when-ambiguous, §3.1). This logic is
  independent of the recall-retrieval.ts fix and must continue to pass unaffected.
- The reinforcement gate (`decision-making.service.ts:1993-1999`) confirmed: fires only when
  `responseGrounding === 'GROUNDED'`, `responseGroundingProvenance` is a non-empty string, AND
  `recallRetrieval.factNodeId === responseGroundingProvenance`. Today this rarely fires because
  provenance comes back null on the common already-GROUNDED path; the fix restores it.
- Two characterization tests confirmed asserting the OLD (buggy) behavior and must be updated as
  part of the fix, not left behind: `recall-retrieval.spec.ts:142-146` ("already GROUNDED → not
  double-labeled", asserts `provenance).toBeNull()`) and `okg-recall-subsumption.spec.ts:186-192`
  ("already GROUNDED (e.g. WKG-backed short-circuit) → not double-labeled by recall", same
  assertion). Both currently pass BECAUSE of the bug; post-fix they must assert
  `provenance === factNodeId` when the value surfaces.

**Re-confirmed this pass (2026-07-02, refine red-team fix application per DEC-32 + item-specific
red-team asks — codebase-pkg unavailable, direct reads):**
- **DEC-32 (003b) — `scoreCandidates` factor set pinned.** Read `deliberation-helpers.ts:230-318`
  in full. Base (pre-EMA) additive factors: grounding tag — GROUNDED `+1.0`, LLM_ASSISTED `+0.5`,
  UNKNOWN-conversational `+0.1`, UNKNOWN-factual `+0.7`, untagged `+0.5`; penalties — chatbot
  language `-0.5`, "I don't know" (conversational only) `-0.7`, ends-with-`?` `-0.15`, verbose
  (>50 words) `-0.1`; bonus — mentions a known WKG entity `+0.15`. On top of these, an EMA
  adjustment (`nudgeScoringWeights`, :146-189) per known factor key is added to bonuses and
  *subtracted from* penalty magnitudes (so EMA drift only ever pushes a score up, never down);
  each adjustment is initialized at 0, monotonically approaches +1 per reinforced win
  (`current + 0.05*(1-current)`), and the whole adjustment vector is L1-normalized to sum ≤ 1.0
  once it exceeds that — so EMA drift is bounded but does shift over the process lifetime.
  `selectedIndex`/`bestIndex` picks the highest `scores[i].score`; `deliberation.service.ts:614-616`
  already captures `scored.scores[selectedIndex].score` as the real evaluated quality signal DEC-32
  requires. Best base-only combination (GROUNDED + entity mention, no penalties) = `1.15`; worst
  base-only combination (untagged + chatbot + idk-conv + ends-`?` + verbose, all co-occurring is
  structurally possible) = `-0.95`. These two constants anchor the normalization mapping in the
  rewritten 003b ticket below.
- **Ollama abort-API surface (003a-2) — CONFIRMED: no per-call AbortSignal for non-streaming
  `chat()`.** Read `node_modules/ollama` v0.6.3 (`dist/shared/ollama.1bfa89da.d.ts`,
  `dist/browser.cjs`) in full. `ChatRequest` has no `signal` field. Both `client.chat()` call
  sites here (:335, :449) call with default `stream` (falsy) → `processStreamableRequest`'s
  non-streaming branch (`browser.cjs:301-304`) calls `post(this.fetch, host, request, { headers })`
  with **no `signal` at all** — the streaming branch is the only one that builds an
  `AbortController` and threads `signal` (:279-283). `Ollama.abort()` (:258-263) only iterates
  `ongoingStreamedRequests` — it **cannot cancel a non-streaming call at all** today, and even for
  streamed calls it is instance-wide (aborts every in-flight streamed request, not just one) — the
  exact "kills a concurrent queue-turn chat" hazard the task flagged. However, `post()`
  (`browser.cjs:149-162`) DOES forward `options?.signal` through to `fetch`, and `Config.fetch`
  (`browser.cjs:255`, `this.fetch = config?.fetch ?? fetch`) is a pluggable hook already used by
  this same file for the DeepSeek path's own `signal: AbortSignal.timeout(this.timeoutMs)`
  (:185). A custom `fetch` supplied via `Config.fetch` at `new Ollama({ host, fetch })`
  construction (:123) receives one call per outgoing HTTP request and can wrap it in its own
  fresh `AbortController`/`AbortSignal.timeout` — genuine per-request abort granularity, without
  touching `client.abort()` and without needing streaming mode. This is the mechanism pinned into
  003a-2's rewritten AC below.
- **`decision-making.service.ts:1060`/`:1151` provenance threading — CONFIRMED intact, no drop.**
  Read both call sites in full (:1030-1168). `:1060`'s `latentApplied.provenance` is threaded to
  `groundingProvenance: latentProvenance ?? undefined` on the pushed `executionResults` entry
  (:1074); `:1151`'s `procedureApplied.provenance` is threaded via
  `if (procedureProvenance) result['groundingProvenance'] = procedureProvenance;` (:1158). Both
  feed `decision-making.service.ts:1514`'s `responseGroundingProvenance = result['groundingProvenance']`.
  Neither site drops it — 003c's files_in_scope entry for this file remains verification-only, no
  functional change, per the build-time verify note added to the ticket below.
- **`llm.controller.ts` path correction.** The manual-reset endpoint the plan/red-team cited as
  `llm.controller.ts:60` actually lives at `apps/sylphie/src/controllers/llm.controller.ts:60`
  (`heal()`, calls `resetCircuitBreaker()`) — corrected in 003a-3's AC text below.

## Approach (simplest thing that meets the ACs)

**003a split into three atomic tickets per red-team review** (the original single P1
"concurrency hardening" ticket bundled three independently-testable, independently-shippable
fixes; splitting avoids the safety-critical epoch-guard fix waiting on the timeout/watchdog
design decision, and lets the breaker auto-probe land independently of either):
1. **003a-1 (S) — epoch-guarded mutex release.** Capture the cycle's epoch at start; the
   `finally` only calls `disarmWatchdog()` / clears `tickInFlight` / `inFlightTurn` if the
   captured epoch still matches the current epoch (i.e., no successor has started). Mirrors the
   guard already applied to `completed$`/breaker.
2. **003a-2 (S/M) — LLM chat timeout + self-tick watchdog.** Both `client.chat()` call sites get
   an explicit abort/timeout; self-ticks get watchdog coverage equivalent to queue turns (either
   folding self-ticks into CycleGuard, or a scoped watchdog with the same guarantee). The AC must
   name the chosen mechanism explicitly (AbortSignal vs a scoped watchdog) — this is a real design
   choice, not just a bug fix — and prove a chat timeout actually unwedges `processInput`. Must
   call `notifyExternalComplete()` (:403) on timeout, not just clear the local flag, or the fix
   silently re-creates the queued-turns-forever failure via a different code path.
3. **003a-3 (S) — breaker auto-probe.** Half-open auto-recovery mirroring CycleGuard's own
   breaker pattern, so a transient Ollama outage self-heals without the manual HTTP reset.

**003b (P2) — debate gate honesty, per DEC-32 (governance, accepted).** The design fork is
CLOSED — Option A (real confidence signal) is decided, Option B (threshold-lowering) is REJECTED
as Std-4 theater (a still-fabricated confidence value made reachable is theater regardless of
where the bar sits). The real signal already exists one step upstream: `scoreCandidates`
(`deliberation-helpers.ts:230+`) returns `scored.scores[selectedIndex].score`, which
`deliberation.service.ts:614-616` already captures. 003b threads that score into `confidence`
through a fixed, pinned `[0,1]` normalization (constants derived from the base, pre-EMA factor
set — see Discovery — so the mapping, and therefore the 0.7 threshold's meaning, is stable
regardless of `nudgeScoringWeights`' in-process EMA drift). AC#2 pins the full compound-OR gate
(confidence alone is insufficient — `wkg.entities.length > 0` and `anxiety <= 0.5` both still
gate independently), per DEC-32.

**003c (P2) — provenance threading, per DEC-31 / AD-0048.** The CANON fork the red-team originally
flagged (does threading provenance through an already-GROUNDED verdict risk bypassing the
honesty guard?) is resolved: the surfaced-check stays the sole gate, it is just evaluated in the
correct order. Fix is confined to `applyRecallGroundingFromRetrieval` in `recall-retrieval.ts`
(~6 lines: move the `valueSurfacesAsWord` check ahead of the GROUNDED early-return). All four call
sites inherit the fix for free. Two characterization tests are deliberately updated as part of
this ticket. **No longer sequenced after 003b:** per DEC-31/AD-0048 the fix is confined entirely
to `recall-retrieval.ts` (the shared function) — 003b's edits are confined to
`deliberation.service.ts:641-781` (the debate-gate/confidence logic) and 003c touches no lines in
that file at all (its one `decision-making.service.ts` entry is verification-only, confirmed no
functional change needed — see Discovery). There is no overlapping-region hazard left; 003c ships
independently of 003b's build order.

The "Lower:" laundry list (executor force-idle timer, fabricated timestamp, probe-turn
leakage, floating promise, TOCTOU, EMA inversion, NaN, unbounded map) is NOT ticketed
here — refine should confirm it stays as audit-backlog rather than scope-creeping in.

## Staged tickets (contract_write=staged — NOT written to contract.yaml)
```yaml
- id: TK-INTAKE-20260702-003a-1
  kind: ticket
  parent: EP-INTAKE   # → EP-21 (FEAT-3) at contract-write; numeric TK-<n> assigned then
  title: "Epoch-guarded mutex release: a stale watchdog-killed cycle must not release/disarm a newer cycle's mutex/watchdog"
  priority: P1
  engineering_level: production
  complexity_budget: S
  owner: cortex
  conceptual_reviewer: luria
  code_reviewer: code-reviewer
  files_in_scope:
    - packages/decision-making/src/concurrency/cycle-guard.service.ts
  acceptance_criteria:
    - given: "a cycle is watchdog-killed and the epoch is bumped before that cycle's promise settles"
      when: "the stale cycle's finally block eventually runs"
      then: "it does not call disarmWatchdog() or clear tickInFlight/inFlightTurn for the successor's (current) epoch — unit test forces an epoch mismatch and asserts the successor's watchdog/mutex state is unchanged"
    - given: "the same zombie-cycle scenario, with a successor cycle already running under the new epoch"
      when: "the stale cycle's finally runs concurrently with the successor"
      then: "no concurrent runCycle() executes and no in-flight turn is silently dropped (unit test with two overlapping cycles and a forced epoch bump, asserting exactly one honest outcome for the turn)"
    - given: "an ordinary cycle that completes normally — no watchdog fire, no epoch bump between mutex acquisition and the finally block running"
      when: "the finally block runs (myEpoch === current cycleEpoch)"
      then: "it STILL calls disarmWatchdog() and clears tickInFlight/inFlightTurn, and drainNext() proceeds to run the next queued turn to completion — regression unit test: a single ordinary turn completes and asserts the watchdog was disarmed, the mutex was freed, and a second turn queued behind it is drained and completes (not left queued forever). This guards against a naive epoch-gated fix that unconditionally skips release and bricks every ordinary turn while passing the two zombie-cycle ACs above."

- id: TK-INTAKE-20260702-003a-2
  kind: ticket
  parent: EP-INTAKE
  title: "LLM chat timeout (both client.chat() call sites) + self-tick watchdog coverage — unwedge hung Ollama sockets"
  priority: P1
  engineering_level: production
  complexity_budget: M
  owner: cortex
  conceptual_reviewer: luria
  code_reviewer: code-reviewer
  files_in_scope:
    - packages/decision-making/src/llm/ollama-llm.service.ts
    - packages/decision-making/src/tick-engine/decision-tick-engine.service.ts
  acceptance_criteria:
    - given: "chatTimeoutMs is configured, and ollama-js v0.6.3's ChatRequest has NO per-call signal field — CONFIRMED: both client.chat() call sites (:335, :449) use the non-streaming path (browser.cjs processStreamableRequest, stream falsy), which threads no AbortController/signal at all (:301-304); the streaming path is the only one that builds one, and Ollama.abort() (:258-263) only tracks ongoingStreamedRequests — it cannot cancel a non-streaming call today, and even for streamed calls is instance-wide (cancels ALL in-flight requests, wrong granularity for a concurrent queue-turn chat)"
      when: "the mechanism is implemented"
      then: "it is a custom fetch supplied via the Ollama client's Config.fetch hook (new Ollama({ host, fetch }) at onModuleInit :123) that wraps the global fetch: EACH outgoing HTTP request gets its OWN fresh AbortController + AbortSignal.timeout(this.timeoutMs) merged into that request's options — mirroring the DeepSeek path's own signal: AbortSignal.timeout(this.timeoutMs) at :185. This gives true per-request abort granularity (one hung request timing out does not touch any other concurrent request) without ever calling client.abort(). The AC is not satisfied by merely logging the timeout as active, nor by a bare Promise.race that stops awaiting the promise while leaving the underlying HTTP request/Ollama generation running unaborted server-side (that does not meet 'the underlying LLM call is ABORTED'); IF a build-time spike shows the Config.fetch hook is impractical, a Promise.race fallback is acceptable ONLY paired with an explicit non-awaited .catch()/log on the abandoned promise (no unhandled rejection) AND the ticket must record the residual leaked-request risk as a known limitation, not silently ship it. A test with a stalled/hung client proves the chosen mechanism actually unwedges processInput (the promise settles) AND (for the Config.fetch route) that the underlying fetch was actually aborted (signal.aborted / AbortError observed), not just abandoned."
    - given: "a hung Ollama socket occurs during a self-tick (e.g. boredom-research inject) — CONFIRMED: decision-tick-engine.service.ts:387 awaits this.callbacks.processInput(frame) directly inside the try, so if the underlying chat() call inside processInput never settles, the finally block at :390-404 (which clears selfTickInFlight at :398 and calls cycleGuard.notifyExternalComplete() at :403) never runs at all"
      when: "the chat timeout elapses (via the mechanism named in AC #1)"
      then: "the aborted chat() call causes processInput() to settle (reject or resolve), so the self-tick's existing finally block runs and clears selfTickInFlight AND calls cycleGuard.notifyExternalComplete() (:403) — the fix must REACH the existing call, not add a duplicate or a separate flag-only reset (test: stalled client during a self-tick, assert notifyExternalComplete was invoked exactly once via the existing :403 call and a subsequently queued user turn completes rather than queuing forever)"
    - given: "steps-to-repro #1 and #2 from source.md (slow queue-turn Ollama; hung self-tick Ollama)"
      when: "replayed post-fix"
      then: "no turn queues forever and no cycle runs unwatchdogged"

- id: TK-INTAKE-20260702-003a-3
  kind: ticket
  parent: EP-INTAKE
  title: "LLM circuit breaker half-open auto-probe (auto-recovery after a transient outage)"
  priority: P1
  engineering_level: production
  complexity_budget: S
  owner: cortex
  conceptual_reviewer: luria
  code_reviewer: code-reviewer
  files_in_scope:
    - packages/decision-making/src/llm/ollama-llm.service.ts
  non_goals:
    - "a single shared consecutiveFailures/available flag across all three tiers — CONFIRMED (ollama-llm.service.ts:97-101, 267-402): today one pair of instance fields is incremented/checked identically by the DeepSeek-deep path, the DeepSeek-medium path, and the local-Ollama path (quick/medium/deep-fallback), so a failure on ANY tier can trip availability for ALL, and a probe success on ANY tier would wrongly clear it for all. This ticket does not fix cross-tier failure attribution generally — see AC — it scopes the auto-probe to ONE named tier's breaker state."
  acceptance_criteria:
    - given: "the shared consecutiveFailures/available fields today cover 3 distinct call paths (DeepSeek-deep, DeepSeek-medium, local-Ollama), confirmed at ollama-llm.service.ts:267-402"
      when: "per-tier breaker state is introduced for the auto-probe"
      then: "the half-open auto-probe targets ONE named, concretely-specified tier — the primary local-Ollama chat tier (medium/quick, the highest-frequency path) — via its own tracked failure/available state; the DeepSeek tiers keep their existing (manual-reset-only) behavior in this ticket's scope, OR if the build extends per-tier tracking to all three, each tier's breaker state is independently probed and flipped: success recovering the local-Ollama tier's probe does not flip availability for the DeepSeek tiers, and vice versa (unit test: trip the targeted tier only, assert only that tier's available flag flips after a successful probe, and the other tier(s)' availability is unaffected)"
    - given: "the breaker has tripped for the targeted tier (5 consecutive failures, available=false for that tier)"
      when: "a cooldown/probe interval elapses"
      then: "the breaker auto-attempts a single probe call against that tier and flips only that tier's availability back to true on success, mirroring CycleGuard's own breaker pattern — no manual HTTP reset required (the manual-reset endpoint is apps/sylphie/src/controllers/llm.controller.ts:60 heal(), calling resetCircuitBreaker() — path corrected from the plan's earlier llm.controller.ts:60 citation) (unit test: simulate recovery after cooldown, assert available flips without calling the reset endpoint)"
    - given: "the breaker is open for the targeted tier and a probe attempt fails"
      when: "subsequent probe intervals elapse"
      then: "the breaker remains open for that tier and does not busy-loop probes faster than the defined cooldown/backoff (unit test: repeated probe failures, assert probe call count matches the expected schedule, not one-per-request)"

- id: TK-INTAKE-20260702-003b
  kind: ticket
  parent: EP-INTAKE
  title: "Make the deliberation debate gate honest: thread scoreCandidates' selected-candidate score into confidence, normalized/clamped to [0,1] (DEC-32, Option A)"
  priority: P2
  engineering_level: production
  complexity_budget: S
  owner: cortex
  conceptual_reviewer: luria
  code_reviewer: code-reviewer
  files_in_scope:
    - packages/decision-making/src/deliberation/deliberation.service.ts
    - packages/decision-making/src/deliberation/deliberation-helpers.ts
  non_goals:
    - "wholesale redesign of the confidence formula"
    - "Option B (lower DEBATE_THRESHOLD instead of fixing the signal) — REJECTED by DEC-32 as Std-4
      (Theater Prohibition) theater: a still-fabricated confidence value made reachable by moving
      the bar is not honest, it just relocates the fabrication"
  governance_ref: "DEC-32 (planning/contract.yaml) — design fork resolved to Option A; Option B forbidden"
  design_resolution: >
    RESOLVED per DEC-32 (governance, accepted) — no fork remains, build implements this directly.
    `deliberation.service.ts:614-616` already computes `scored = scoreCandidates(...)` and
    `selectedIndex = scored.bestIndex`; thread `scored.scores[selectedIndex].score` (the real,
    already-evaluated quality signal) into `confidence` at :641, REPLACING
    `confidence = 0.5 + (selectedIndex === 0 ? 0.1 : 0)`, via a fixed [0,1] normalization:
    define named constants (in deliberation-helpers.ts, exported for the unit tests and so a future
    factor addition is visibly a constant change, not a silent drift):
      SCORE_MIN = -0.95  // worst base-factor combination: untagged(+0.5) - chatbot(-0.5)
                          //   - idk-conv(-0.7) - ends-with-?(-0.15) - verbose(-0.1)
      SCORE_MAX = 1.15   // best base-factor combination: grounded(+1.0) + entity-mention(+0.15)
      confidence = clamp((selectedScore - SCORE_MIN) / (SCORE_MAX - SCORE_MIN), 0, 1)
                 = clamp((selectedScore + 0.95) / 2.10, 0, 1)
    These bounds are derived from the BASE (pre-EMA) factor weights in scoreCandidates only —
    deliberately excluding the EMA adjustment's own dynamic range (nudgeScoringWeights nudges each
    known factor's adjustment toward +1, L1-normalized to sum ≤ 1.0 across all keys) from the
    normalization constants themselves, so the 0.7 threshold's MEANING does not drift as the EMA
    state evolves post-warmup (100 selections) — this is what DEC-32 means by "a defined factor set
    ... required to keep the 0.7 threshold stable." Worked calibration (base-only, EMA=0): a
    GROUNDED candidate (score 1.0) maps to confidence ≈0.929 (clears 0.7); an untagged candidate
    with no bonus/penalty (score 0.5) maps to confidence ≈0.690 (stays under 0.7, debate still
    fires) — build must verify these two reference points hold in the shipped implementation.
  acceptance_criteria:
    - given: "a candidate whose actual evaluated quality is high per scoreCandidates (e.g. GROUNDED grounding tag, score ~1.0+, selected as scored.bestIndex)"
      when: "deliberation computes confidence for the shouldDebate check using the pinned normalization above"
      then: "confidence reflects scored.scores[selectedIndex].score via the defined [0,1] mapping rather than the fixed 0.5-or-0.6 placeholder, and clears DEBATE_THRESHOLD (0.7) for this candidate (unit test asserting confidence ≈0.929 for the GROUNDED/no-penalty reference case)"
    - given: "such a high-confidence candidate (confidence >= 0.7) is ALSO evaluated against the full compound-OR shouldDebate gate — confidence alone is insufficient; wkg.entities.length === 0 or anxiety > 0.5 each independently force debate regardless of confidence (deliberation.service.ts:648-650)"
      when: "wkg.entities.length > 0 AND (driveSnapshot.pressureVector[Anxiety] ?? 0) <= 0.5"
      then: "shouldDebate === false and the turn completes with measurably fewer LLM calls than the always-debate path (unit test: confidence >= 0.7 AND wkg.entities.length > 0 AND anxiety <= 0.5 => shouldDebate === false, asserting 0 for/against debate LLM calls); AND a companion test proves debate still fires when EITHER wkg.entities.length === 0 OR anxiety > 0.5 even with the same high confidence — the OR-gate is not neutered by the confidence fix"
    - given: "a candidate that is genuinely uncertain under the pinned mapping (e.g. untagged, no grounding/entity bonus, no penalties — score ~0.5, confidence ≈0.690, or any weaker/penalized candidate)"
      when: "deliberation runs"
      then: "confidence stays below DEBATE_THRESHOLD (0.7) and debate still fires — regression test proving the gate was made honest via a real signal, not neutered into never-debate, using the same normalization mapping as the strong-candidate test (not a separately tuned threshold)"

- id: TK-INTAKE-20260702-003c
  kind: ticket
  parent: EP-INTAKE
  title: "applyRecallGroundingFromRetrieval: surface-check ahead of the GROUNDED early-return so provenance threads to the reinforcement gate (per DEC-31 / AD-0048)"
  priority: P2
  engineering_level: production
  complexity_budget: S
  owner: cortex
  conceptual_reviewer: luria
  code_reviewer: code-reviewer
  sequencing_note: >
    NOT sequenced after 003b (stale note removed per DEC-31/AD-0048 + this refine pass): 003b's
    edits are confined to deliberation.service.ts:641-781 (the debate-gate/confidence logic);
    003c touches no lines in that file at all — its fix locus is entirely
    recall-retrieval.ts's shared applyRecallGroundingFromRetrieval function, which all four call
    sites (deliberation.service.ts:446/:813, decision-making.service.ts:1060/:1151) already inherit
    unchanged. No overlapping-region hazard remains; 003c ships independently of 003b's build order.
  files_in_scope:
    - packages/decision-making/src/deliberation/recall-retrieval.ts
    - packages/decision-making/src/deliberation/recall-retrieval.spec.ts
    - packages/decision-making/src/deliberation/okg-recall-subsumption.spec.ts
    - packages/decision-making/src/decision-making.service.ts   # verification only — no functional change expected here
  build_time_verify_note: >
    CONFIRMED during this refine pass (2026-07-02) — read decision-making.service.ts:1030-1168 in
    full: both remaining call sites already thread provenance correctly.
    :1060 (latent/Type-1 replay path) — latentApplied.provenance flows to
    `groundingProvenance: latentProvenance ?? undefined` on the pushed executionResults entry
    (:1074). :1151 (procedure-handler path) — procedureApplied.provenance flows via
    `if (procedureProvenance) result['groundingProvenance'] = procedureProvenance;` (:1158). Both
    feed decision-making.service.ts:1514's `responseGroundingProvenance = result['groundingProvenance']`.
    Neither site drops it — files_in_scope for this file stays verification-only as stated. Build
    MUST still re-confirm this at implementation time (in case the file has drifted since this
    refine pass) — if either site is found to drop provenance, files_in_scope is incomplete and the
    ticket must be reopened/re-scoped rather than silently patched inline.
  non_goals:
    - "returning factNodeId unconditionally on any path — the valueSurfacesAsWord check remains the SOLE provenance gate (an unconditional return would be fabricated provenance, CANON Std-1/Std-4)"
    - "reordering/merging logic at deliberation.service.ts:420-450 — the fix is confined to the shared function in recall-retrieval.ts"
  acceptance_criteria:
    - given: "a recall retrieval whose fact value surfaces as a whole word in the response text, AND the current grounding is already 'GROUNDED' (set by an earlier signal before applyRecallGroundingFromRetrieval runs)"
      when: "applyRecallGroundingFromRetrieval runs"
      then: "it returns provenance === retrieval.factNodeId and groundedBy === retrieval.source (not null), and downstream the WS3-T2 reinforceFactNode gate (decision-making.service.ts:1993-1999) fires for that node (unit test covering the already-GROUNDED + surfaced case at the function level, plus an integration-level assertion that reinforceFactNode is invoked)"
    - given: "a retrieval is present but the fact value does NOT surface as a whole word in the response text"
      when: "applyRecallGroundingFromRetrieval runs"
      then: "grounding is unchanged, provenance is null, and reinforceFactNode does NOT fire — the honesty guard (C2) holds regardless of the prior grounding state (unit test: already-GROUNDED + not-surfaced case)"
    - given: "the two existing characterization tests that currently assert the OLD (buggy) suppressed-provenance behavior — recall-retrieval.spec.ts:142-146 ('already GROUNDED → not double-labeled') and okg-recall-subsumption.spec.ts:186-192 ('already GROUNDED (e.g. WKG-backed short-circuit) → not double-labeled by recall')"
      when: "the fix lands"
      then: "both tests are updated, as part of this ticket, to assert the NEW correct behavior (provenance === factNodeId, groundedBy === retrieval.source, when the value surfaces) — not left asserting the old suppressed-provenance expectation"
    - given: "a GROUNDED verdict resolved at write-time (decision-making.service.ts:1627-1640)"
      when: "responseGroundedBy === 'WKG' vs. responseGroundedBy is 'OKG' or ambiguous/null"
      then: "groundingPersonId is null (world-scoped) in the WKG case, and scoped to the current speaker in the OKG/ambiguous case — test covering both branches to confirm this write-time scoping behavior is unaffected by the recall-retrieval.ts change"
```

## Notes for refine
- **Sequencing:** 003a-1 → 003a-2 → 003a-3 are independently shippable but 003a-1 (epoch guard)
  is the highest-leverage safety fix and should land first; 003a-2 (timeout/watchdog) is the
  second-highest leverage and depends on nothing else. 003a-3 (breaker) is fully independent and
  can land in any order relative to the other two. **003b and 003c are now also fully independent
  of each other** (the stale `sequenced_after: 003b` on 003c is REMOVED this pass — see 003c's
  `sequencing_note` and the Approach section: 003b's edits are confined to
  `deliberation.service.ts:641-781`; 003c touches no lines in that file, its fix locus is entirely
  `recall-retrieval.ts`). All five tickets may build/ship in any order.
- **CANON lens for `luria`:** the zombie-mutex release violates "exactly one honest outcome per
  turn"; the permanent-SHRUG breaker is a silent-degradation honesty issue. For 003c specifically:
  confirm the reordered check still treats `valueSurfacesAsWord` as the sole gate on GROUNDED +
  provenance — the fork the red-team originally raised (does threading provenance through an
  already-GROUNDED verdict bypass the honesty guard?) is resolved per architect DEC-31 / AD-0048,
  but `luria` should still verify the shipped diff matches that resolution (surface-check strictly
  ahead of the early-return, not removed). For 003b: confirm the DEC-32 rejection of Option B holds
  in the shipped diff — no threshold-lowering, no fabricated-but-reachable confidence path; the
  normalization constants (SCORE_MIN/SCORE_MAX) must be visible, named, and derived from the base
  factor set, not tuned ad hoc to make a specific test pass.
- **003b design fork — CLOSED by DEC-32 (governance, accepted).** Option A (real confidence
  signal via `scoreCandidates`' selected-candidate score, normalized/clamped to `[0,1]` with the
  pinned `SCORE_MIN=-0.95`/`SCORE_MAX=1.15` constants) is the decision; Option B (lower
  `DEBATE_THRESHOLD`) is REJECTED as Std-4 theater. No fork remains in the ticket — see
  `design_resolution` in the staged ticket body above.
- **DB impact:** none of the five tickets touch a database/schema/migration surface — all are
  in-process concurrency, timeout, and object-shape (provenance threading) fixes. Confirms
  source.md's own "Database impact: no" and plan.md's DB: no marker above.
