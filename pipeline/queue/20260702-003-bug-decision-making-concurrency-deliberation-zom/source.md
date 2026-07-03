# Bug: Decision-making concurrency & deliberation — zombie-cycle mutex release, no LLM timeout, unconditional debate, provenance drop

**Severity:** high  ·  **Priority:** P1
**Area / component:** decision-making core (packages/decision-making, excl. wkg) — cycle guard, tick engine, LLM, deliberation, executor

## What's broken (required)
The subsystem is well-documented and most CANON honesty invariants hold, but the concurrency layer has two serious holes and the deliberation pipeline wastes calls and quietly fails its provenance threading:
- **Zombie cycle's `finally` releases the successor's mutex and disarms its watchdog.** When the watchdog kills a wedged cycle it increments the epoch and starts the next cycle; when the killed cycle later settles, its `finally` runs `disarmWatchdog(); tickInFlight=false; inFlightTurn=null` **unconditionally** (only the breaker/`completed$` are epoch-guarded). The successor then runs with no watchdog and a falsely-free mutex → concurrent `runCycle()`, and the losing turn is silently dropped (violates the "exactly one honest outcome per turn" invariant).
- **No Ollama timeout + self-ticks bypass the watchdog.** `chatTimeoutMs` is read and logged as active but only applied to the DeepSeek fetch path; both `client.chat()` calls pass no signal. Queue turns are masked by the 25 s watchdog, but self-tick cycles bypass CycleGuard entirely — a self-tick that hits a hung Ollama socket never runs its `finally`, so `selfTickInFlight` stays true forever and every inbound user turn queues indefinitely. No recovery short of restart.
- **Deliberation debate is unconditional.** Confidence is `0.5 + (selectedIndex===0?0.1:0)` (max 0.6) and `shouldDebate = confidence < 0.7 || …` — the first clause is always true, so every novel turn pays 5 LLM calls (2 deep, parallel) and the "skip" branch is dead code. Compounds the watchdog/timeout risk by pushing latency toward 25 s.
- **LLM circuit breaker trips permanently.** 5 consecutive failures set `available=false` with no probe/auto-recovery (unlike CycleGuard's breaker); manual HTTP reset only; the counter is shared across Ollama + both DeepSeek tiers. After a transient outage the system is silently degraded to no-LLM SHRUGs indefinitely.
- **GROUNDED verdicts drop provenance on the common path.** `applyRecallGroundingFromRetrieval` early-returns null provenance when already GROUNDED (`recall-retrieval.ts:516-519`); on the common recall path grounding is set GROUNDED before the apply call, so `groundingProvenance`/`groundedBy` come back null — and the WS3-T2 fact-reinforcement gate (requires `responseGroundingProvenance === factNodeId`) almost never fires. `discriminateGroundedBy()` is exported but never called in production.
- Lower: executor 500 ms per-state timer force-idles healthy cycles (and the "illegal transitions throw" claim is false — warn only); `socialCommentTimestamp` fabricated on every outcome; circuit-breaker probe turns leak into chat delivery + pattern write-back; `runDetectors()` floating promise in a dead try/catch (+ double-run); TOCTOU race in the self-tick guard; episodic similarity query result discarded (theater); EMA weight nudges can invert penalties into bonuses; NaN propagation on missing drive keys; unbounded habituator map.

## Expected (required)
A watchdog-killed cycle cannot release or disarm its successor's mutex/watchdog; every LLM call (including self-ticks) is bounded by a timeout and self-ticks are watchdog-covered; debate fires only when confidence is genuinely low; the breaker auto-probes back to available after an outage; and a successful grounded recall carries its node id through to the reinforcement gate.

## Steps to reproduce (required)
1. Simulate a slow Ollama (>25 s) during a queue turn: watchdog kills the cycle; when the slow response lands, observe the next cycle running unwatchdogged and a concurrent `processInput` throw dropping a turn.
2. Simulate a hung Ollama during a self-tick (e.g. boredom-research inject): observe `selfTickInFlight` never clears and all subsequent user turns queue forever.
3. Send any novel turn and count LLM calls — debate always fires (5 calls) even when a candidate is clearly sufficient.
4. Take Ollama down for a few seconds then back up — the breaker stays open (permanent SHRUGs) until a manual reset.

**Reproducibility:** always for #3/#4; #1/#2 under slow/hung LLM.

## Evidence
- Zombie finally: `concurrency/cycle-guard.service.ts:547-568`.
- Ollama timeout / self-tick bypass: `llm/ollama-llm.service.ts:335,449` (logged active :129, applied only to DeepSeek :185); `tick-engine/decision-tick-engine.service.ts:348-404,332`.
- Debate: `deliberation/deliberation.service.ts:641,648-650,781`.
- Breaker: `ollama-llm.service.ts:95-101,274-279,379-384,564-568`; manual reset `apps/sylphie/src/controllers/llm.controller.ts:60`.
- Provenance drop: `recall-retrieval.ts:516-519`, `deliberation.service.ts:420-451,809-818`, gate `decision-making.service.ts:1993-1999`, `deliberation-helpers.ts:654`.
- Lower: `executor/executor-engine.service.ts:81,206-214` (+ FSM claim `decision-making.service.ts:564-566`); `decision-making.service.ts:2344-2349,1462-1467`; `cycle-guard.service.ts:737-757`; `decision-tick-engine.service.ts:253-348`; `process-input/process-input.service.ts:132-145`; `deliberation-helpers.ts:146-189,264-279`; `threshold/threshold-computation.service.ts:47-73`; `habituation/visual-presence-habituator.ts:52`.

Full detail: `docs/audits/repo-bug-audit-2026-07-02.md` §1.

## Where it lives (scope hints)
`packages/decision-making/src/concurrency/cycle-guard.service.ts` (epoch-guard the release), `llm/ollama-llm.service.ts` (add chat timeout signal + breaker probe), `tick-engine/decision-tick-engine.service.ts` (watchdog self-ticks; move mutex acquisition before async work), `deliberation/deliberation.service.ts` + `recall-retrieval.ts` (debate gate + provenance threading), `executor/executor-engine.service.ts`. Owned by `cortex` (conceptual reviewer `luria`) per CLAUDE.md work-trio.

## Database impact (required)
**Touches a database / schema / migration?** no. All fixes are in-process concurrency/timeout/logic; the provenance fix threads an existing node id through code (no schema).

## Acceptance — how we'll know it's fixed (required)
- Given a watchdog-killed cycle whose promise later settles, when its `finally` runs, then it does not disarm the successor's watchdog or free the successor's mutex (unit test with a forced epoch bump); no concurrent `runCycle` occurs and no turn is dropped.
- Given a hung LLM socket on a self-tick, when the chat timeout elapses, then the self-tick aborts, `selfTickInFlight` clears, and user turns proceed (test with a stalled client).
- Given a candidate with sufficient confidence, when deliberation runs, then debate is skipped (the skip branch is reachable) — verified by a test exercising the confidence path.
- Given a transient LLM outage, when the service recovers, then the breaker auto-probes back to available without a manual reset.
- Given a successful grounded recall, when the response is emitted, then `groundingProvenance === factNodeId` and the reinforcement gate fires (unit test).

## Environment
Local dev + any deploy; concurrency holes manifest under a slow/hung Ollama. Source-trace at commit `228df73`.

## Notes / non-goals (optional)
- The self-tick watchdog + Ollama timeout are the highest-leverage safety fixes here; ship them with the zombie-finally epoch guard as one concurrency-hardening slice.
- Non-goal: redesigning the deliberation confidence formula wholesale — just make the debate gate honest (either raise the confidence signal or lower the threshold intentionally).
