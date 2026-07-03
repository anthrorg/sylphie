# Sylphie Feature Inventory — Honest Status Sheet

**Date:** 2026-07-02 · **Baseline:** commit `228df73` · **Source:** full-repo bug audit (`docs/audits/repo-bug-audit-2026-07-02.md`), seven subsystem auditors reading source in full, criticals independently re-verified.

Status vocabulary (one word per feature, chosen honestly):

- **WORKING** — wired end-to-end, does what it claims.
- **DEGRADED** — works, but with a verified defect that reduces correctness, resilience, or cost.
- **BROKEN** — wired, but a verified bug means it does not function.
- **THEATER** — appears to work (logs success / returns OK / renders UI) while doing nothing real. CANON's worst class.
- **DEAD** — real code with no live invocation path.
- **STUB** — honestly declared not-implemented (501s, labeled TODOs). Not theater.

---

## Motivation (drive engine + drive server)

| Feature | Status | Evidence |
|---|---|---|
| 12-drive dynamics core (accumulation, clamping, cross-modulation, outcome application) | WORKING | Audited clean; math real. Coefficient docs off by 3× (`cross-modulation.ts:113`) |
| Separate-process isolation (transport) | DEGRADED | Real separate process + validated WS, but SESSION_START lets any client overwrite full drive state (`drive-engine.ts:400-406`) |
| RLS half of drive isolation | THEATER | Verifier never registered in any module; no REVOKE/policy in `infra/`; case study claims startup aborts on failure |
| WS reconnect / recovery | THEATER | `attemptRecovery()` zero production callers; startup log claims "recovery will reconnect"; unbounded send queue |
| Theater-prohibition post-flight check (drive side) | THEATER | `detectTheater()` ignores `currentDriveState`; trusts caller-supplied value (`theater-prohibition.ts:59-67`) |
| Drive-event persistence to Timescale (event emitter path) | DEAD | `EventEmitter` never instantiated; INSERT targets nonexistent columns anyway (`timescale-writer.ts:212-225`) |
| HEALTH_STATUS protocol / <10 MB memory criterion | THEATER | Engine never sends; `lastPingAt` fabricated; `childMemoryBytes` hardcoded null |
| Drive baseline self-adjustment (E4-T008) | DEAD | Computed + logged (`adjusted=N`) but no consumer; rates come from static constants |
| Drive snapshot freshness guard | BROKEN | One >5 s gap poisons the anchor permanently; all later snapshots rejected forever |
| Tick drift compensation | BROKEN | Math forces `delay = INTERVAL` every tick; cumulative slowdown under the warn ratio |
| Drive state checkpoint/restore | DEGRADED | Works, but SESSION_START discards it; legacy fork entry races save vs `process.exit` |

## Cognition sidecar (Python/TensorFlow)

| Feature | Status | Evidence |
|---|---|---|
| `/cognition/cycle` tensor inference hot path | BROKEN | Flat vs nested `drive_history` → every call 422s; breaker opens; service reports healthy |
| Online EWC consolidation | DEAD | Only caller is `/cognition/phase-transition`, which nothing invokes; penalty gradients are zeros. Also ordering bug: `set_reference` before `compute_fisher` |
| Bootstrap graduation (shadow→audit→partial→full) | DEGRADED | Tracker logic real, but pairing is unkeyed/unlocked, and currently starved by the 422 |
| Category demotion safety gate | DEAD | `check_demotions()` called only from tests |
| ConvergenceModel learned routing | THEATER | Never trained; one lucky random call after 1000 checks flips `use_learned=True`, persisted |
| Deliberation pipelines / panel models | THEATER | Docstrings claim trained-on-data; no gradient path exists; random-weight outputs served to NestJS |
| Supervisor control endpoints (reinforce/correct/freeze/unfreeze) | WORKING | Real effects verified (2026-06-10 fixes hold) |
| `boost_salience` | WORKING | Real sidecar endpoint now exists and matches the caller (`main.py:834-903`) — previously stubbed |
| `per_category_confidence` metric | BROKEN | Aggregation code is real now, but unreachable while every cycle call 422s |
| `/cognition/control/rollback` | DEGRADED | Loads latest weights regardless of requested checkpoint id; races the trainer; reports the requested id as loaded |
| DataBuffer / trainer / replay internals | WORKING | Individually well-built and tested |

## Perception (Python CV)

| Feature | Status | Evidence |
|---|---|---|
| YOLO detection + IoU tracking + DINOv2 embeddings | WORKING | Genuinely wired; but LOST→CONFIRMED bypasses `min_confirm_frames` (flicker promotion) |
| Face detection confidence | THEATER | Constant 0.5 fabricated as model output (`face_detector.py:256-258`) |
| Face snapshot enrollment | BROKEN | Gate requires ≥0.65; fabricated 0.5 never passes → zero crops ever collected, silently |
| Tracker config via env (`COBEING_PERCEPTION_TRACKING__*`) | THEATER | Validated then ignored; ctor hardcodes values |
| Dominant-color extraction | DEGRADED | Pure-Python per-pixel loop, unthrottled, on every confirmed track every frame |
| Spreading-activation engine (layer3) | DEAD | ~1,090 lines, zero callers (unchanged since 2026-06-13 flag) |

## Decision-making core

| Feature | Status | Evidence |
|---|---|---|
| Dual-process loop (Type 1 / Type 2 / SHRUG) | WORKING | Grounding demotion, epoch fencing at emit sites, honest SHRUGs all real |
| CycleGuard mutex + watchdog | DEGRADED | Zombie `finally` frees successor's mutex + disarms its watchdog (epoch guard only covers the breaker) |
| Self-tick autonomous cycles | DEGRADED | No watchdog + no Ollama timeout → one hung socket deadlocks all turns until restart |
| LLM circuit breaker | DEGRADED | Trips permanently; manual reset only; counter shared across backends |
| Deliberation debate gating | BROKEN | Confidence formula maxes at 0.6 < 0.7 threshold → debate always fires; skip branch dead |
| Executor FSM | DEGRADED | 500 ms per-state timer force-idles healthy cycles; "illegal transitions throw" claim false (warn only) |
| Grounding provenance threading (WS4-T5) | DEGRADED | GROUNDED-before-apply path emits null provenance; `discriminateGroundedBy` never called; WS3-T2 reinforcement gate almost never fires |
| Episodic similarity in process-input | THEATER | Query runs; result feeds only a debug log |
| Habituation / worth-saying / turn-floor (EP-20) | WORKING | Audited; real (habituator map unbounded — minor) |
| Working-memory activation re-ranking | WORKING | Real, but note: it re-ranks retrieved items; it is not multi-hop retrieval |
| Circuit-breaker probes | DEGRADED | Probe turns leak into chat delivery and pattern write-back at conf 0.3 |

## Knowledge graphs (WKG/OKG/Self)

| Feature | Status | Evidence |
|---|---|---|
| Candidate staging + guardian promotion (Std-5) | WORKING | Server-side gate real; four grounding read-paths exclude `:Candidate`; regression-tested |
| Fact reinforcement (`reinforceFactNode`, ACT-R, 0.60 clamp) | DEGRADED | Math right; read-modify-write not transactional; and its trigger (provenance gate) almost never fires — see decision-making |
| Procedure dedup on write | BROKEN (CANON) | Jaccard match boosts confidence +0.05 → cap 1.0, bypassing the 0.60 ceiling and `computeConfidence()` |
| Pre-commit contradiction scanning | THEATER | Wrong label, wrong id property, reads edge props off nodes — structurally can never fire |
| Procedure retrieval for frame context (`matchProcedures`) | BROKEN | Reads only `triggerContext`; planning writes `trigger_context` → planned procedures invisible |
| RESEARCH_ENTITY graph writes | THEATER | Phantom node_id on MERGE match → edges silently dropped while `edgesCreated` logged |
| RELIEVES drive-links | THEATER | No `:Drive` nodes exist anywhere; MERGE matches nothing; success logged |
| Bootstrap seeds | DEGRADED | Minted at 0.60 (ceiling) vs documented 0.40 base — upstream of seed-domination |
| Confidence decay (WORLD, retrieval-aware) | WORKING | T3 coalesce real; `:Candidate` orphans never pruned (minor); OTHER decay still deferred (flagged) |

## Learning / Planning / Supervisor

| Feature | Status | Evidence |
|---|---|---|
| 60 s learning cycle + pressure-triggered forceCycle | WORKING | Re-entrancy clean; timers cleaned up |
| Person-fact privacy seal (Wave-3 `:Candidate` staging) | WORKING | Holds; residue = provenance issues below |
| Typed-edge provenance | BROKEN (CANON) | Conversation speaker-facts stamped GUARDIAN/0.60; subject fallback attaches facts to arbitrary entities |
| Conversation reflection | DEGRADED | Transient LLM failure permanently forfeits the session (marked reflected, 0 insights); re-grounding ratio unclamped past 0.60 |
| markAsLearned / event bookkeeping | DEGRADED | Failures swallowed → duplicate `:Conversation` nodes per minute per stuck event; false processed counts |
| Planning fail-closed conflict validation + stable dedup key | WORKING | Verified holding (deferral path live, backoff bounded) |
| Planning validation retry loop | BROKEN | Refined proposal validated, original failing proposal written; `refine()` zeroes drive effects so expressive retries can never pass theater check |
| Opportunity queue ingest | DEGRADED | Rate-limited/evicted opportunities permanently destroyed (marked planned) — no dead-letter |
| `ADDRESSES_OPPORTUNITY` constraint | THEATER | Vacuous since the stable-key fix (always true) |
| Supervisor sampling + interventions | WORKING | Real POSTs, honest rejections, real timeouts + breaker |
| Supervisor breaker semantics | DEGRADED | 400 validation rejections counted as failures; five rejects block freeze/rollback 30 s |
| DeepSeek reasoning trace | STUB | Still dropped (`supervisor.service.ts:273-274`, TODO) — carried from old inventory, unresolved |

## Backend app (apps/sylphie)

| Feature | Status | Evidence |
|---|---|---|
| Conversation gateway + delivery | DEGRADED | Works; trigger-phrase chain can silently drop a turn + stick the spinner |
| Endpoint authentication | BROKEN (security) | Only rules + auth/me guarded; graph wipe, table truncation, LLM lesion, OKG reads all anonymous |
| Neo4j init hardening (TK-107) | DEGRADED | Two `onModuleInit` paths still hang-capable; deadline pattern leaves an orphan promise that can crash the process |
| STT streaming (Deepgram) | DEGRADED | Abnormal close = silent death with live-looking mic; stale close handler can kill the replacement session |
| Press-to-talk one-shot transcribe | STUB | Returns empty text (carried from old inventory, unresolved) |
| DrivesController override/drift/reset | STUB | Honest 501s (correct per drive isolation); frontend affordances still render |
| CANON metrics endpoint | DEGRADED | `meanDriveResolutionTimes` SQL permanently broken (ambiguous column) — never reported |
| Executor telemetry (`executor_cycle`) | DEGRADED | Real cadence, but entropy/state/transition_count/is_stale are hardcoded literals |
| WebRTC gateway | DEAD | Unregistered empty stub |

## Frontend

| Feature | Status | Evidence |
|---|---|---|
| Chat, drives, graph panels over WS | DEGRADED | Work, but all four WS hooks share the unmount-zombie reconnect bug → duplicate delivery, orphan-evicts-visible-tab |
| Word rating (guardian training) | THEATER | Sends an un-enveloped frame no backend handler exists for; every rating silently dropped |
| Perception overlay | DEGRADED | TK-105 eviction complete; but perception WS never reconnects (silent detection death) and full-store subscriptions re-render at frame rate |
| Metrics panel: Recent Actions / Prediction Accuracy / maintenance | DEAD | Handles events nothing emits; action field hardcoded null upstream; timestamp units mismatched three ways |
| FE agent (Anthropic) | DEGRADED (security) | API key inlined in served bundle with `dangerouslyAllowBrowser` |
| Auth/session | DEGRADED | Any transient `/api/auth/me` failure deletes the stored token |
| Voice: hold-to-talk streaming | WORKING | Real path |
| Shared package (types, Prisma, DB clients) | WORKING | Clean lifecycle; minor DSN-escaping / error-masking nits |

---

## Scorecard

Of ~75 audited features: **~25 WORKING · ~28 DEGRADED · ~9 BROKEN · ~12 THEATER/DEAD · ~4 honest STUBs.**

The load-bearing cognitive loop (drives → fusion → dual-process → delivery) genuinely works. What's rotten concentrates in: (1) everything the system claims about its own resilience and self-monitoring, (2) the tensor-cognition path (dead at the contract boundary), and (3) old KG write paths that escaped the CANON confidence/provenance discipline the newer paths follow.
