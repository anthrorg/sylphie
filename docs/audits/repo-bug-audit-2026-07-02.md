# Sylphie Full-Repo Bug Audit

**Date:** 2026-07-02
**Method:** Seven parallel subsystem auditors reading source in full (decision-making core, WKG, drive-engine + drive-server, apps/sylphie, learning/supervisor/planning, shared + frontend, Python cognition/perception), followed by independent spot-verification of every CRITICAL finding against source. All spot-checks confirmed.
**Baseline:** commit `228df73` (working tree matches HEAD; the ~690 "modified" files in `git status` are CRLF/OneDrive line-ending noise — only 9 files carry real uncommitted changes, none source code).

---

## Executive summary

The codebase's *algorithms* are largely real and well-built. The dominant failure mode is **severed wiring presented as live** — real implementations whose invocation path is broken, absent, or silently failing, which is exactly what the CANON theater prohibition exists to catch. Second theme: **resilience layers are façade** (reconnect, RLS, health checks, watchdogs all have holes). Third: **several CANON confidence/provenance escapes** on older write paths.

### The ten most consequential findings

| # | Finding | Where | Effect |
|---|---------|-------|--------|
| 1 | `drive_history` sent flat (120 floats) but sidecar schema requires nested `list[list[float]]` → **every `/cognition/cycle` call fails 422** | `tensor-inference-adapter.service.ts:189-198` vs `cognition-service/schemas.py:48` | Entire tensor cognition path functionally dead; breaker opens; no graduation; `per_category_confidence` empty as a *symptom* |
| 2 | Drive-server WS client **never reconnects** — `attemptRecovery()` has zero production callers; send queue unbounded | `recovery.ts:118`, `ws-channel.service.ts:106-141`, `drive-process-manager.service.ts:56-99` | One socket drop permanently severs the motivational system + memory leak; startup log claims "recovery will reconnect" (false) |
| 3 | **Unauthenticated destructive endpoints**: `POST /api/skills/reset` wipes all three graphs + Timescale tables; metrics resets, `POST /api/llm/lesion`, full OKG read — all anonymous | `skills.controller.ts`, `metrics.controller.ts`, `llm.controller.ts`, `graph.controller.ts` | One anonymous `curl` destroys all accumulated memory in a public deployment |
| 4 | WKG dedup path boosts procedure confidence **+0.05 capped at 1.0**, bypassing the 0.60 CANON ceiling and `computeConfidence()` | `wkg-context.service.ts:823` | Unconfirmed INFERENCE procedures can climb to conf 1.0 and dominate ranking (the documented runaway class) |
| 5 | Zombie cycle's `finally` unconditionally releases the mutex and disarms the **successor's** watchdog | `cycle-guard.service.ts:547-568` | Concurrent cycles → silently dropped turns; successor runs unwatchdogged |
| 6 | Ollama `client.chat()` has **no timeout**, and self-tick cycles bypass the watchdog | `ollama-llm.service.ts:335,449`, `decision-tick-engine.service.ts:348-404` | One hung LLM socket on a self-tick deadlocks the mind until restart |
| 7 | Pre-commit contradiction scanner is a structural no-op: wrong label, wrong id property, reads edge props off nodes | `contradiction-scanner.service.ts:108` vs `detect-contradictions.service.ts:151-169` | The coherence safety gate can never fire — always returns "clean" |
| 8 | Planning validation retry loop validates the **refined** proposal but writes the **original failing** one | `constraint-validation.service.ts:120-172`, `planning.service.ts:582-649` | Procedures that failed theater/step-type checks get created under a `PLAN_VALIDATED` event |
| 9 | Face detector reports a **constant fabricated confidence** (0.5); snapshot gate requires ≥0.65 | `face_detector.py:256-258`, `face-snapshot.service.ts:101,316` | Face enrollment silently collects zero crops, forever, with no log |
| 10 | All four frontend WS hooks have an unmount-reconnect **zombie socket** bug | `useWebSocket.ts:366-375` (+170-183, 512-521), `useSupervisorWebSocket.ts:94-103` | Duplicate message delivery, double turn counts, visible tab evicted by its own orphan |

Also near-critical: RLS drive isolation is **not enforced at runtime** (verifier never registered in any module; no REVOKE/policy in `infra/`), and `VITE_ANTHROPIC_API_KEY` is inlined into the served browser bundle.

---

## Findings by subsystem

Severity key: **C** critical · **H** high · **M** medium · **L** low.

### 1. Decision-making core (`packages/decision-making`, excl. `wkg/`)

- **C — Zombie `finally` releases successor's mutex/watchdog.** `concurrency/cycle-guard.service.ts:547-568`. `disarmWatchdog(); tickInFlight=false; inFlightTurn=null` run unconditionally; only breaker/`completed$` are epoch-guarded. After a watchdog kill, the killed cycle's late settlement disarms the new cycle's watchdog and frees the mutex → concurrent `runCycle()`, silent turn drops. Fix: epoch-guard the whole release, as the breaker already is.
- **C — No Ollama timeout + self-ticks bypass the watchdog.** `llm/ollama-llm.service.ts:335,449` (`chatTimeoutMs` read and *logged as active* at :129 but only applied to the DeepSeek fetch path); `tick-engine/decision-tick-engine.service.ts:348-404`. A hung self-tick leaves `selfTickInFlight=true` forever → `drainNext()` defers all user turns indefinitely. No recovery short of restart.
- **H — Executor 500 ms per-state timer force-idles healthy cycles.** `executor/executor-engine.service.ts:81,206-214`. CATEGORIZING/PREDICTING/ARBITRATING routinely exceed 500 ms (Neo4j + embedding calls); `forceIdle()` nulls metrics mid-cycle, fragments cycleIds. Also: the FSM only *warns* on illegal transitions while `decision-making.service.ts:564-566` claims they throw.
- **H — Deliberation debate is unconditional.** `deliberation/deliberation.service.ts:641,648-650`. Confidence maxes at 0.6 < threshold 0.7, so the "skip debate" branch is dead code; every novel turn pays 5 LLM calls (2 deep, parallel), pushing latency toward the 25 s watchdog.
- **H — LLM circuit breaker trips permanently.** `ollama-llm.service.ts:95-101,274-279,379-384,564-568`. No probe/auto-recovery (unlike CycleGuard's breaker); manual HTTP reset only. Failure counter shared across Ollama + both DeepSeek tiers. After a transient outage the system is silently lobotomized (permanent SHRUGs).
- **M — GROUNDED verdicts drop provenance on the common path; `discriminateGroundedBy` never called.** `recall-retrieval.ts:516-519`, `deliberation.service.ts:420-451,809-818`. Early-return when already GROUNDED emits `groundingProvenance: null` → the WS3-T2 fact-reinforcement gate (`decision-making.service.ts:1993-1999`) almost never fires. World-scoping half of WS4-T5 §3.1 inert.
- **M — `socialCommentTimestamp` fabricated on every outcome** (`decision-making.service.ts:2344-2349`) — the drive engine receives a "Sylphie-initiated comment" signal for reactive replies.
- **M — Circuit-breaker probe turns leak into chat delivery + WKG write-back.** `cycle-guard.service.ts:737-757`. Probe responses emit as `USER_REPLY` and can be cached as learned patterns at conf 0.3.
- **M — `runDetectors()` floating promise in a dead try/catch; detectors run twice per cycle when tensor sidecar wired.** `decision-making.service.ts:1462-1467` (+ awaited run at :816).
- **M — TOCTOU race in self-tick guard.** `decision-tick-engine.service.ts:253-348`. Awaits between the busy-check and `selfTickInFlight=true`.
- **M — Episodic similarity query result discarded** (`process-input/process-input.service.ts:132-145`) — documented pipeline step with zero influence (theater).
- **M — EMA weight nudges can invert penalties into bonuses.** `deliberation-helpers.ts:146-189,264-279`. `adjustments` can exceed the penalty base (e.g. chatbot-phrasing penalty becomes +0.3 bonus).
- **L —** NaN propagation on missing drive keys (`threshold-computation.service.ts:47-73`, also `process-input.service.ts:458-471`, `attractor-monitor.service.ts:489-491`); dead `CycleGuardService.runSelfTick()`; unbounded habituator `exposureCounts` map.

### 2. WKG / knowledge graphs (`packages/decision-making/src/wkg`)

- **C — Dedup confidence boost to 1.0** (`wkg-context.service.ts:823`) — see top-ten #4. Contrast `reinforceFactNode()` :740 which correctly clamps to 0.60.
- **C — Contradiction scanner structural no-op** (`arbitration/contradiction-scanner.service.ts:108`) — see top-ten #7. Three independent mismatches vs the only CONTRADICTS writer.
- **H — `writeEntity()` returns a phantom `node_id` on MERGE match** (`wkg-context.service.ts:370-401`) — caller gets a locally-generated id that exists on no node; RESEARCH_ENTITY edges (`action-handler-registry.service.ts:512-538`) silently lost while logging `edgesCreated` success. (Learning's `upsert-entities.service.ts:257-259` fixed this exact bug; wkg-context didn't.)
- **H — `RELIEVES` drive-links are guaranteed no-ops**: no `:Drive` nodes are ever created anywhere in the repo (`wkg-context.service.ts:899-903`), yet success is logged (:915-918).
- **H — `matchProcedures()` reads only `p.triggerContext`** (`wkg-context.service.ts:1155`); planning writes `trigger_context` → all planned/guardian-taught procedures invisible to frame context. (Other readers coalesce both spellings; this one was missed.)
- **M —** `reinforceFactNode()` read-modify-write not transactional (can stomp a concurrent guardian promotion, :700-752); bootstrap seeds minted at conf 0.60 vs documented 0.40 base (`action-retriever.service.ts:519` — upstream of the seed-domination problem TK-104 patched at rank time); `getSubgraph()` discards neighborhood relationships + string-interpolates `depth` (:291-314); `writeEntity()` APOC-fallback drops all properties + no ceiling on ON MATCH confidence lift (:405-426); `writeRelationship()` ignores its `properties` param and logs success on zero-row no-ops (:441-471).
- **L —** `promoteCandidate()` reports infra failure as `not_found` (:615-626); `getBaseContext()` defaults missing confidence to 1.0 (:1032); promoted candidates keep `node_type: 'Candidate'`.
- **Clean:** session hygiene (all sessions closed in `finally`), Jaccard math, Lucene escaping, `sanitizeRelType` injection guard, server-side Std-5 guardian gate, `:Candidate` exclusion on all four grounding read-paths.

### 3. Drive engine + drive server (`packages/drive-engine`, `apps/drive-server`)

- **C — No reconnect, ever** (`recovery.ts:118` uncalled; `ws-channel.service.ts:106-112` close handler just nulls the socket; unbounded `sendQueue` :132-141) — see top-ten #2. Even if wired, `attemptRecovery` declares success before the `open` event (:151-166).
- **C — RLS isolation unenforced and unverified.** `postgres-verification/verify-rls.ts` is registered in no module (its `OnModuleInit` never runs); `infra/postgres/init/001-runtime-user.sql:9-10` grants full DML to `sylphie_app` with no REVOKE/policy on `drive_rules`. Archived case study claims "startup ABORTS on failure." CANON drive-isolation violation presented as enforced.
- **H — `detectTheater()` never reads `currentDriveState`** (`theater-prohibition.ts:59-67`); the verdict trusts the main process's self-reported `driveValueAtExpression`. The isolated judge trusts the defendant's testimony.
- **H — Baseline adjustment is a no-op subsystem**: `SelfEvaluator` computes and logs `adjusted=N` (`self-evaluation.ts:113-193`) but no production caller consumes it; tick rates come only from static constants (`accumulation.ts:27-37`).
- **H — SESSION_START lets any WS client overwrite the entire drive state** (`drive-engine.ts:400-406`; validator only range-checks) — a direct main→drive mutation path, also discards the Timescale-restored checkpoint.
- **H — One >5 s snapshot gap permanently poisons `DriveReaderService`** (`drive-state-snapshot.ts:99-118`, `drive-reader.service.ts:196-207`): the staleness anchor only advances on acceptance, so after one stall every subsequent snapshot is rejected forever (throws swallowed at `drive-process-manager.service.ts:170-177`).
- **H — TimescaleWriter INSERT targets nonexistent columns** (`timescale-writer.ts:212-225` vs `infra/timescaledb/init/002-events.sql:7-17`); currently unreachable only because `EventEmitter` is never instantiated (`drive-engine.ts:155`) — the whole event-persistence pipeline is dead code with headers claiming persistence.
- **H — HEALTH_STATUS protocol fake end-to-end**: engine never sends it; main app registers a handler that can't fire; `lastPingAt` fabricated at report time; `childMemoryBytes` hardcoded null → the <10 MB memory criterion unenforced.
- **M —** server-side reconnect race + no dead-client detection (`ws-transport.ts:60-64`, `main.ts:124-129`); tick "drift compensation" math wrong — forces `delay = INTERVAL` every tick, cumulative slowdown below the warn ratio (`drive-engine.ts:427-437`); NaN via partial pressure vectors (`ipc-message-validator.ts:166-171`, `drive-state.ts:198-204`); legacy fork entry races checkpoint save against `process.exit(0)` (`drive-process/main.ts:50-55`).
- **L —** `POSTGRES_DB` default mismatch (`'sylphie'` vs `'sylphie_system'`); `reloadRules()` swallows errors so "Rule engine initialized" logs with 0 rules; cross-modulation coefficients 3× documented strength; stray scaffolding file `drive-engine-import-additions.ts`.
- **Clean:** drive dynamics core (accumulation/clamp/outcome application), Timescale pool handling (TK-94 area), env names vs `.env.example`.

### 4. Main backend (`apps/sylphie`)

- **C — Nearly everything is unauthenticated** — see top-ten #3. Only `RulesController` and `AuthController.me` use `AuthGuard`. Includes full-graph wipe, table truncation, LLM lesion, and full OKG (person facts) reads. CORS only restrains browsers.
- **H — TK-107 boot-hang fix incomplete**: `person-model.service.ts:96-132` and `face-snapshot.service.ts:189-215` still `await CREATE CONSTRAINT` in `onModuleInit` with no deadline — the original hang class survives on two init paths.
- **H — TK-107's own pattern can crash the process**: `Promise.race` deadline leaves the losing `bootstrap()` promise unhandled (`wkg-bootstrap.service.ts:61-81`, `wkg-query.service.ts:149-182`); a late rejection is an unhandled rejection → process exit.
- **H — `meanDriveResolutionTimes` SQL is permanently broken** (`metrics.controller.ts:1759-1774`): unqualified `payload->>'drive'` in a self-join → `column reference "payload" is ambiguous` on every call; catch returns `{}` — this CANON metric has never reported.
- **M —** ConversationGateway trigger-phrase chain has no `.catch` → dropped turn + stuck thinking spinner (`conversation.gateway.ts:394-422`); abnormal Deepgram close neither reconnects nor notifies the client — mic looks live while audio is discarded (`audio.gateway.ts:162-173`); stale STT close handler can destroy the replacement session (`stt.service.ts:157-173`); `handleCycleResponse` unhandled-rejection path (`communication.service.ts:211-218`).
- **L —** eviction leaks socket-map entries for half-dead sockets (`conversation.gateway.ts:263-273`); `WebRTCGateway` unregistered empty stub; `SensoryLoggerService` interval never cleared; `DrivePublisher` hardcodes `drive_entropy: 0, state: 'idle', transition_count: 0, is_stale: false` as real-looking telemetry.
- **Clean:** WS event names match frontend; `AuthGuard` fails closed without `JWT_SECRET`; voice endpoints return honest errors; DrivesController honestly 501s; PerceptionGateway resets `processing` in `finally`.

### 5. Learning / Supervisor / Planning

- **H — Validation retry writes the original failing proposal** (`constraint-validation.service.ts:120-172` + `planning.service.ts:582-586,649`) — see top-ten #8.
- **H — `refine()` zeroes `predictedDriveEffects`** (`proposal.service.ts:107-130,343-384`) → refined expressive plans can never pass the theater check; combined with the above, refinement is futile or dangerous.
- **H — Provenance falsification: conversation speaker-facts stamped GUARDIAN at 0.60** (`extract-typed-edges.service.ts:458,487-507`) — unverified sensor input gets guardian provenance and the slowest decay rate; the in-code comment claiming a guard (:447-453) doesn't match the code.
- **H — Rate-limited/capacity-rejected opportunities permanently destroyed at ingest** (`planning.service.ts:325-346,619-625` + `opportunity-queue.service.ts:104-114`): `finally` marks `has_planned=true` even when enqueue was rejected; >3 opportunities/hour silently loses the excess.
- **M —** speaker facts attach to an arbitrary first entity → `(Minecraft)-[LIKES]->(Minecraft)` at GUARDIAN/0.60 (`extract-typed-edges.service.ts:738-746`); re-grounding ratio unclamped → INFERENCE insights can breach the 0.60 ceiling (`conversation-reflection.service.ts:840-853,1209-1227`); transient LLM failure permanently forfeits a session's reflection (:271-279); `markAsLearned` swallows failures → duplicate `:Conversation` nodes every 60 s per stuck event (`update-wkg.service.ts:176-188`); sidecar 400 rejections counted as breaker failures — five rejects block freeze/rollback for 30 s (`sidecar-control.service.ts:343-346`).
- **L —** `ADDRESSES_OPPORTUNITY` constraint became vacuous after the stable-key fix (`constraint-checks.ts:99-118`); `pendingInterventions` unbounded and never read (`supervisor.service.ts:122,662`); decayed `:Candidate` orphans never pruned (`confidence-decay.service.ts:239`); `updateEdgeType` two-statement non-transactional (`refine-edges.service.ts:426-454`).
- **Verified holding:** fail-closed conflict detection + stable dedup key (with residuals above); person-fact leak sealed via `:Candidate` staging (residue = the two provenance findings); forceCycle-vs-timer race clean; planning LLM-unavailability requeue fixed.

### 6. Shared + Frontend

- **C — Unmount-reconnect zombie sockets in all four WS hooks** — see top-ten #10. Re-creates the exact double-delivery bug the code comments claim was fixed; orphan reconnects can evict the visible tab (close 1012 suppresses its reconnect → permanently "disconnected").
- **H — Anthropic API key in the browser bundle** (`feAgent.ts:37-44`, `VITE_ANTHROPIC_API_KEY` + `dangerouslyAllowBrowser`). Proxy it through the backend.
- **H — Word-rating feature sends into the void** (`ConversationPanel.tsx:349-351`): raw frame instead of `{event, data}` envelope, and no `phrase_word_rating` handler exists anywhere in the backend. Guardian ratings silently dropped.
- **H — Perception WS never reconnects** (`usePerception.ts:310-326`): camera keeps painting, detection permanently dead after one drop.
- **H — Telemetry contract drift**: frontend handles `prediction_result` / `maintenance_cycle` / `state_transition` which nothing emits; `drive-publisher` hardcodes `action: null` so the action-history branch never fires → MetricsPanel "Recent Actions"/"Prediction Accuracy" are permanently empty dead UI.
- **M —** ms-vs-seconds timestamp mismatch (three conventions in one file: `store/index.ts:433-437,464,472`, `MetricsPanel.tsx:15-21`, `useWebSocket.ts:445`); WebRTC leaks an RTCPeerConnection per signaling reconnect + missing staleness guard (`useWebRTC.ts:120,243-279`); transient `/api/auth/me` failure logs the user out and deletes the token (`App.tsx:32-40`); full-store Zustand subscriptions re-render media components at 15 fps / 2 Hz (`usePerception.ts:133`, `useVoiceRecording.ts:51`, `useAudioStream.ts:47`, `useWebRTC.ts:50`); `usePressureStatus` two competing writers → indicator flapping.
- **L —** Prisma DSN not URL-escaped + `env!` assertions (`prisma.service.ts:14`, `database.config.ts:6-27`); `withTransaction` ROLLBACK can mask the original error (`timescale.service.ts:82-84`); `useAutoScroll` ignores its `behavior` option.
- **Clean:** all seven WS paths match backend registrations; Vite proxy port matches; shared DB clients' lifecycle (pools, `finally` releases, disconnects); schema matches migrations; TK-105 buffer eviction complete; store buffers capped.

### 7. Python services (cognition, perception)

- **C — `drive_history` contract mismatch kills every `/cognition/cycle` call** — see top-ten #1. The service reports healthy while its core function is dead; masks findings 3-6 below.
- **C — Fabricated face confidence disables face enrollment** — see top-ten #9. Comment claims blendshape-derived estimate; code only ships the fallback constant.
- **H — Online EWC never activates in production**: `POST /cognition/phase-transition` (the only `set_reference`/`compute_fisher` caller) has zero runtime callers; live mode transitions happen with no consolidation while `penalty_gradients()` returns zeros (`replay.py:392-393`).
- **H — EWC ordering bug**: `set_reference` before `compute_fisher` (`main.py:583-596`) — the freshly computed Fisher is parked and never used for its phase; first post-transition phase runs plain L2. The comment asserting this lag is "Online EWC design" is wrong (Schwarz 2018 blends immediately).
- **H — ConvergenceModel can graduate a never-trained random head** (`convergence.py:148-168`): no code trains convergence weights; after 1000 checks one lucky call (random sigmoid within 0.2 of heuristic) flips `use_learned = True`, persisted in the checkpoint.
- **H — `check_demotions()` never wired** (`inference/bootstrap.py:130-160`): graduated categories keep authority even if agreement collapses — the docstring's demotion promise is unimplemented in the live path.
- **M —** deliberation pipelines/panels never trained but outputs served as real signals (`deliberation.py`, `cycle.py:131-134,171-173`); `/cognition/control/rollback` silently ignores the requested checkpoint id and races the trainer (`main.py:961-978`); tracker LOST→CONFIRMED bypasses `min_confirm_frames` (`tracker.py:364-368`); tracker config env vars validated but ignored — hardcoded ctor (`perception-service/main.py:376-380`); per-pixel Python color loop on every confirmed track every frame (`feature_extraction.py:154-166`, `main.py:660-665`) — hundreds of ms per frame at scale.
- **L —** 50 ms client `AbortSignal` guarantees first-cycle timeout (Keras tracing) counted against the breaker; Fisher chunk-mean approximation under-estimates up to ~32×; `PanelModel` Xavier seed uses `hash(self.name)` (PYTHONHASHSEED-random) despite determinism claims.
- **Verified fixed:** `boost_salience` now has a real matching sidecar endpoint (`main.py:834-903`); `per_category_confidence` aggregation is real code — unreachable solely because of the 422.

---

## Cross-cutting patterns

1. **Silent-empty success** — Cypher/SQL that matches nothing or fails, then logs success or returns `{}`: contradiction scanner, RELIEVES links, `writeRelationship`, research edges, `meanDriveResolutionTimes`, `reloadRules`.
2. **Dead invocation paths around real code** — recovery, RLS verifier, EWC consolidation, demotion check, baseline adjustment, spreading activation, HEALTH_STATUS: the implementation exists; nothing calls it.
3. **Contract drift between writer and reader** — `triggerContext`/`trigger_context`, `id`/`node_id`, flat/nested `drive_history`, edge-props-vs-node-props, ms/seconds timestamps, telemetry events nothing emits.
4. **Watchdogs that don't cover the dangerous path** — CycleGuard misses self-ticks; executor timer fires on healthy states; LLM breaker never re-closes; snapshot staleness anchor locks out permanently.
5. **Confidence-ceiling escapes on old write paths** — dedup boost to 1.0, seed minting at 0.60, unclamped re-grounding ratio, GUARDIAN-stamped conversation edges — all bypass `computeConfidence()` (a Std-6 concern).

## Suggested fix order (highest leverage first)

1. `drive_history` shape fix (one-line: send nested) — revives the entire cognition sidecar.
2. Auth guard (or localhost/token gate) on skills/metrics/llm/graph controllers.
3. Wire WS reconnect (drive-server client + perception hook) and fix the frontend unmount-zombie pattern (one shared fix, four hooks).
4. Epoch-guard CycleGuard's `finally`; add Ollama chat timeout; watchdog self-ticks.
5. WKG property-name reconciliation (`trigger_context` coalesce in `matchProcedures`, `node_id` return in `writeEntity`) + remove the 1.0 dedup boost (route through `computeConfidence`, clamp 0.60).
6. Planning: return the refined proposal from `validate()`; preserve `predictedDriveEffects` through refine.
7. Contradiction scanner rewrite against the actual CONTRADICTS shape.
8. Face confidence: derive a real score or lower the snapshot gate; log the gate decision.
9. Move the Anthropic key behind a backend proxy.
10. Register the RLS verifier + land the `drive_rules` REVOKE (TK-AUDIT-1).

## Stale documentation flagged (not rewritten in this pass)

- `wiki/architecture/**` — generated at `4f0b473` (2026-06-13); several subsystem maps predate EP-19/EP-20 and the retired `sylphie-pkg` doc is still present.
- `wiki/ideas/*.md` — several describe as "ideas" things that are live bugs confirmed here (drives-controller stubs, sensory-logger stand-in, learning dead-letter tracking, theater-prohibition real validation).
- The archived RLS case study (claims startup aborts on RLS failure — false at runtime).
- `README.md`, `sylphie-tech-spec.md`, `ROADMAP.md`, `sylphie-stub-inventory.md` — updated in this pass; see companion docs `sylphie-feature-inventory.md` and the regenerated `sylphie-stub-inventory.md`.
