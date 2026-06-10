# WS4 Ticket 1 — Decision-Cycle Concurrency Guard: Complete Design Spec

**Author:** ashby (cybernetics/stability) · **Date:** 2026-06-10 · **Verified against live source at HEAD (a68a826).**

This spec fixes every parameter and policy. The builder (cortex) implements without inventing anything. Parent plan: `wiki/ws4-build-plan.md` Ticket 1 + §3.

---

## 0. Code verification findings (these change the hazard model)

**0.1 The IDLE-at-:1058-vs-emit-at-:1248 window is REAL and ~190 lines wide.** `executorEngine.transition(IDLE)` fires at `decision-making.service.ts:1058` (LEARNING→IDLE), but the cycle keeps running inside the same `processInput` invocation: extracts response text, emits the `CycleResponse` at `:1248`, then tensor training (:1278), prediction-error routing (:1299), undiscovered-object/unknown-person pressure (:1309–1353). **The executor reports IDLE while `processInput`'s promise is still pending.** The FSM's IDLE-entry invariant (`:438` throw guard) and the actual "cycle is finished" condition are NOT the same event. Any guard keyed on `executor === IDLE` admits a second cycle into a critical section the first cycle still owns.

**0.2 The real serialization seam is the tick loop, not `processInput`.** Entry is gated twice in `onTick` (:288): `if (tickInFlight) return` (:290) AND `if (executor !== IDLE) return` (:295). `tickInFlight` is set true at :376 and reset in the `finally` at :406 — that `finally` wraps the entire `await this.processInput(frame)`, so `tickInFlight` correctly stays true through the whole :1058–:1377 tail. **`tickInFlight` is the honest "cycle truly done" signal; `executor === IDLE` is not.**

**0.3 Overlapping turns are SILENTLY DROPPED today.** Event-driven arrivals: `tickSampler.onNewInput()` → `onTick(true)` (:266–267). If a cycle is in flight, `onTick` hits :290 and the arrival evaporates; meanwhile `tickSampler.updateText()` (gateway :184) overwrote the global text slot. The `:438` throw almost never fires in the event-driven path — the silent drop happens first. The queue's primary job is converting silent drops into ordered processing; CANON Std 4 is already violated today by construction.

**Mechanism verdict:** mutex + bounded FIFO + watchdog, NO preemption — confirmed, no stability flaw. One tightening: **the mutex must release on true `processInput` completion (the :406 seam), never on executor-IDLE (:1058).**

---

## 1. Queue

- **Depth: 12**, two-lane (guardian FIFO + normal FIFO). Sizing: service time S ≈ 3s typical (replay TYPE_2 ~2400–3150ms), 20s worst-case live Ollama (FSM already budgets `EXECUTING_TIMEOUT_MS = 30_000`, executor-engine.service.ts:88); 4-person burst ≈ 4–8 turns in 2–3s. Depth 8 overflows during one slow live turn (spurious declines → resend amplification); depth 16 hides a wedge too long. 12 absorbs realistic bursts + one slow turn, surfaces sustained overload within ~1 service interval.
- **Entry:** the `InboundTurn { turnId, userId, username, socketId, text, receivedAt, isGuardian }` (Tickets 2/3). Ticket 1 standalone minimum: `{ turnId, isGuardian, receivedAt, enqueuedAt }` + opaque payload handle. **turnId minted at intake (gateway), never at the :1249 emit.**
- **FIFO:** non-guardian turns append to normal-lane tail; drainer pops head exactly when the mutex is free (true completion). One pop → one cycle → one response.
- **Guardian lane:** drainer always pops the guardian lane first; only when empty pops normal lane. Never preempts in-flight (F.1). Multiple guardian turns are FIFO among themselves by `enqueuedAt`. Priority is a lane, not a preemption.

## 2. Back-pressure

- **On overflow (13th arrival): evict the oldest waiting non-guardian turn**, with a livelock guard — never evict the head-of-line that is next-to-serve. With depth 12 + serial drain, head-of-line always progresses within one service interval.
- **Guardian turns are NEVER evicted.** A guardian arrival into a full queue evicts the oldest waiting non-guardian turn to make room (Std 5).
- **Honest addressed decline (Std 4)**, emitted as a real delivery carrying the evicted turnId and a `BACKPRESSURE_DECLINE`/SHRUG marker; log `CYCLE_BACKPRESSURE_DECLINE { turnId, userId, queueDepthAtEviction, waitedMs }`. Message: *"I'm a bit overwhelmed right now — too many things at once. Ask me again in a moment and I'll get to it."*
- **No auto-retry.** The human resends; human reaction time is the rate limiter (moves the retry loop outside the machine — §6.1).

## 3. Watchdog

- **T_max = 25,000 ms, whole-cycle**, measured mutex-acquire (:376) → mutex-release (:406). Above 10–20s live TYPE_2 + ~3.5s non-EXECUTING state overhead (23.5s healthy worst-case); **below** the 30s EXECUTING FSM timeout, so it's the strictly tighter outer guard. Key insight: **the per-state FSM timeout cannot protect the :1058–:1377 tail** (IDLE has no timeout, :206) — the whole-cycle watchdog exists to cover exactly that window. Lesion cycles (2–5ms) never trip it.
- **Detection:** `setTimeout(T_max)` armed at cycle start (co-located with `tickInFlight = true`, :376), handler captures the in-flight turnId + `cycleEpoch`; cleared in the `finally` (:406).
- **Recovery sequence (ordered, exact):**
  1. `executorEngine.forceIdle()` (executor-engine.service.ts:229) — the canonical FSM reset seam.
  2. Force `tickInFlight = false` (:406 seam) — **the mutex must be a force-releasable flag, NOT a promise-chained lock** (a promise-chained mutex deadlocks the whole mind on a single wedge).
  3. Increment `cycleEpoch` (neutralizes the zombie).
  4. Emit honest SHRUG addressed to the wedged turn's originator, reusing the degraded-SHRUG plumbing (:1098–:1119): *"I got stuck thinking about that one and had to let it go. Could you ask me again?"*
  5. Log `CYCLE_WATCHDOG_KILL { turnId, wedgedState, elapsedMs, cycleEpoch }`.
  6. Drain next (guardian lane first).
  Both resets required, FSM first then mutex: executor-only → mutex held forever (mind lockup via :290); mutex-only → :438 throw on next cycle.
- **3.6 Zombie-cycle double-response hazard — epoch fencing (mandatory, the core anti-zombie mechanism):**
  - Monotonic `cycleEpoch` on the service; incremented on every watchdog fire AND every normal cycle start (`myEpoch = ++cycleEpoch` at :376).
  - Every state-mutating/emit op in the :1058–:1377 tail is fenced: `if (myEpoch !== this.cycleEpoch) abort silently`. Fence sites: before `responseSubject.next` (:1248), before `pendingLatentPatterns.set` (:1222), before tail `reportOutcome`s.
  - **The single most important fence is immediately before `responseSubject.next` (:1248)** — it is the difference between one response and two contradictory ones.
  - The epoch, not the executor state, is the true cycle-ownership token (closes finding 0.1 for the successor cycle too).
- **3.7 Wedged-promise leak:** the 30s Ollama AbortSignal / LLM circuit breaker eventually settles it; rejection hits the :1369 catch (`forceIdle()` again — idempotent; tail epoch-fenced). Builder should confirm the abort propagates (hygiene, not correctness).

## 4. Circuit breaker (second layer — specified now, buildable later without redesign)

- **Trip: 3 consecutive `CYCLE_WATCHDOG_KILL`s** (no successful completion between; one true completion resets the counter) → **degraded mode = pure Type-1/SHRUG**, reusing the lesion degraded path (a forced flag making arbitration behave as if LLM unavailable; cycles 2–5ms, watchdog stops firing).
- **Exit: probe-based with hysteresis.** Every 30s, ONE probe turn attempts full TYPE_2 under the normal watchdog. **2 consecutive successful probes** → exit, counter reset. Asymmetric thresholds (3 kills in / 2 probes out) + 30s cadence = deadband against endpoint flapping.
- Log `CYCLE_DEGRADED_MODE_ENTER` / `CYCLE_DEGRADED_MODE_EXIT`. Honesty: degraded responses are genuine Type-1/SHRUG via the existing labeling (:1098–:1119) — never labeled TYPE_2.

## 5. Invariants (builder checklist)

Before every cycle: I1 `tickInFlight === false`; I2 executor IDLE; I3 prior cycle's event buffer flushed; I4 queue depth ≤ 12.
After every cycle (completion OR kill): I5 mutex released; I6 executor IDLE; I7 **exactly one** of {CycleResponse emitted, honest decline/SHRUG emitted, legitimate empty-suppression (:1272–:1276)} — never zero for an admitted turn, never two; I8 stale-epoch cycles emitted/mutated nothing; I9 event buffer flushed.

Must NOT change: N1 the :438 throw stays as backstop (gate's "zero executor throws" target — if it fires under the queue, the queue has a bug); N2 lesion fast-SHRUG path unchanged (burst test passes in lesion mode); N3 **drive ticks untouched — drive isolation is CANON** (queue/mutex/watchdog live entirely in the decision-making process; never block/reset/back-pressure the drive engine); N4 the 200ms self-initiated tick path (:260–262) still works — self-ticks respect the mutex but do NOT enter the inbound queue (no originator); N5 FSM per-state timeouts stay (watchdog is additive); N6 `groundingProvenance` threading and C1 87% must not regress.

## 6. Feedback-loop / attractor analysis

- **6.1 Decline → resend amplification (MEDIUM):** damped by no-auto-retry (human reaction time as rate limiter) + "in a moment" wording. Hostile flooder degrades to bounded eviction-with-decline, not collapse; flag flooding pattern to Ticket 8.
- **6.2 Kill → drain → kill tarpit (MEDIUM-HIGH, dominant hazard):** sustained LLM saturation makes the watchdog spend 25s/turn killing. Damped by the circuit breaker (3 kills → fast degraded mode). Worst case before trip: 75s. **Without the breaker, the watchdog converts a slow-LLM incident into an unbounded tarpit — this is why it's specified now.**
- **6.3 Degraded entry/exit oscillation (LOW-MEDIUM limit cycle):** damped by hysteresis (3 in / 2×30s probes out).
- **6.4 Guardian-lane starvation of non-guardian:** intended (Std 5); one human guardian cannot sustain a flood. Not a pathology.
- **6.5 Net topology:** every positive loop has a limiter. Stable attractors under stress: normal serial operation / bounded-queue-with-honest-declines / fast degraded mode — all honest. Converges to "degrade honestly and stay responsive," not "wedge and lie."

## 7. Acceptance criteria (concrete; gate naming note: existing L8 = empty-context SHRUG — name these Q1.x or renumber to avoid collision)

Run in **both normal and lesion mode** unless stated:
- **Q1.1 Burst:** K=5 turns <50ms apart, 5 distinct turnIds → exactly 5 responses correlated by turnId, zero silent drops (regression test for finding 0.3). Depth 12 ≥ 5 → zero declines expected.
- **Q1.2 No executor throws:** zero :438/:439 "executor not in IDLE" errors in logs.
- **Q1.3 Well-formed, no interleave:** each response non-empty (or honest SHRUG/decline); no text spliced across turns; grounding/turnId internally consistent.
- **Q1.4 Injected-hang recovery:** wedge one cycle (LLM mock never resolves) → honest watchdog SHRUG addressed to its originator + `CYCLE_WATCHDOG_KILL` logged; recovery within **T_max + 1000ms = 26,000ms**; queued turns behind the wedge all drain.
- **Q1.5 Zombie guard (CRITICAL):** force the killed cycle's promise to resolve late (~28s) → NO second response for that turnId (epoch fence), successor cycle uncorrupted. **Without Q1.5 the design is unverified on its most dangerous failure mode.**
- **Q1.6 Back-pressure:** K=13 non-guardian turns <50ms → exactly 1 `CYCLE_BACKPRESSURE_DECLINE` (addressed to oldest-waiting), other 12 get real responses; 13 in → 13 outcomes (no silent drop).
- **Q1.7 Guardian priority** (needs Ticket 3 isGuardian threading): 3 non-guardian + 1 guardian enqueued during an in-flight cycle → guardian serviced next; in-flight cycle NOT preempted (completes normally).
- **Q1.8 Lesion parity:** Q1.1–Q1.3 under lesion: 5 fast SHRUG/Type-1 responses <100ms each, **zero spurious watchdog kills**.
- **Q1.9 Circuit breaker (follow-up gate):** 3 injected wedges → `CYCLE_DEGRADED_MODE_ENTER`, subsequent turns <100ms; un-wedge → 2 probes (30s apart) → `CYCLE_DEGRADED_MODE_EXIT`.

## Fixed-parameter summary (may not be re-invented)

| Parameter | Value | Seam |
|---|---|---|
| Queue depth | **12**, two-lane (guardian FIFO + normal FIFO) | `tickSampler.onNewInput`→`onTick` (decision-making.service.ts:266/288) |
| Mutex | formalized **`tickInFlight`** (force-releasable flag + epoch, NOT promise-chained) | :203, set :376, release :406 |
| Back-pressure | evict oldest-waiting non-guardian (livelock-guarded, never the next-to-serve head, never guardian), honest decline, no auto-retry | new |
| Watchdog T_max | **25,000 ms** whole-cycle | arm :376, clear `finally` :406 |
| FSM reset | `executorEngine.forceIdle()` | executor-engine.service.ts:229 |
| Zombie fence | `cycleEpoch` checks before :1248 emit, :1222 pattern write, tail reportOutcomes | :1058–:1377 |
| Circuit breaker | 3 consecutive kills → degraded (lesion path); exit on 2 probes @30s | reuse :1098–:1119 |
| Kill message | "I got stuck thinking about that one and had to let it go. Could you ask me again?" | honest SHRUG |
| Decline message | "I'm a bit overwhelmed right now — too many things at once. Ask me again in a moment and I'll get to it." | `CYCLE_BACKPRESSURE_DECLINE` |
| Events | `CYCLE_WATCHDOG_KILL`, `CYCLE_BACKPRESSURE_DECLINE`, `CYCLE_DEGRADED_MODE_ENTER/EXIT` | DecisionEventLogger |

**Two non-negotiable correctness constraints:** (1) mutex releases on **true `processInput` completion (:406)**, never on executor-IDLE (:1058); (2) **epoch fence before `responseSubject.next` (:1248)**. Get these two right and the design is safe; get either wrong and it is broken regardless of the rest.
