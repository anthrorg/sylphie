/**
 * CycleGuardService — Decision-cycle concurrency guard (WS4 Ticket 1).
 *
 * Implements the full concurrency guard as specified in wiki/ws4-t1-concurrency-guard-spec.md.
 *
 * Responsibilities:
 *  - Bounded two-lane FIFO queue (guardian lane + normal lane, depth 12 total).
 *  - Formalized mutex: `tickInFlight` is a force-releasable flag, NOT a promise chain.
 *  - Whole-cycle watchdog (T_max = 25,000 ms) with 6-step recovery.
 *  - Back-pressure: evict oldest-waiting non-guardian on overflow, honest decline.
 *  - Circuit breaker: 3 consecutive kills → degraded mode; 2 successful probes → exit.
 *  - Epoch fence: monotonic cycleEpoch neutralizes zombie-cycle double-response.
 *
 * NON-NEGOTIABLE CONSTRAINTS (spec §0):
 *  1. Mutex releases on true processInput() completion (the finally at :406),
 *     NEVER on executor-IDLE (:1058). `tickInFlight` is the honest "cycle done" signal.
 *  2. Epoch fence fires before responseSubject.next (:1248). A watchdog-killed cycle
 *     whose promise resolves late must emit nothing and mutate nothing.
 *
 * CANON COMPLIANCE:
 *  - Drive isolation: the queue/watchdog/epoch live entirely in the decision-making
 *    process. Drive engine is never touched (N3).
 *  - Theater prohibition: every admitted turn gets exactly one honest outcome;
 *    overflow turns get an honest addressed decline, not a silent drop.
 *  - N4: self-initiated 200ms ticks still work. They call runCycleIfIdle() directly,
 *    bypassing the inbound queue (no originator).
 *  - N5: FSM per-state timeouts are additive; the watchdog is a whole-cycle outer guard.
 */

import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';
import type { IDecisionEventLogger, IExecutorEngine } from '../interfaces/decision-making.interfaces';
import { DECISION_EVENT_LOGGER, EXECUTOR_ENGINE } from '../decision-making.tokens';
import type { InboundTurn } from './inbound-turn';
import type { DriveSnapshot } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Constants (all fixed by spec — do not re-invent)
// ---------------------------------------------------------------------------

/** Maximum total turns across both lanes. */
const QUEUE_DEPTH = 12;

/** Whole-cycle watchdog timeout in milliseconds. */
const WATCHDOG_T_MAX_MS = 25_000;

/** Circuit breaker: trips after this many consecutive kills. */
const BREAKER_KILL_THRESHOLD = 3;

/** Circuit breaker: exits after this many consecutive successful probes. */
const BREAKER_PROBE_SUCCESS_THRESHOLD = 2;

/** Circuit breaker: probe interval in milliseconds. */
const BREAKER_PROBE_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Reason a cycle was skipped or declined. */
export type DeclineReason = 'BACKPRESSURE' | 'DEGRADED';

/** Emitted when a turn is honestly declined (overflow or degraded mode). */
export interface TurnDeclinedEvent {
  turnId: string;
  reason: DeclineReason;
  message: string;
  queueDepthAtEviction?: number;
  waitedMs?: number;
}

/** Emitted when a watchdog kill occurs. */
export interface WatchdogKillEvent {
  turnId: string;
  wedgedState: string;
  elapsedMs: number;
  cycleEpoch: number;
}

/** Emitted when a turn completes (successfully or via shrug). */
export interface TurnCompletedEvent {
  turnId: string;
  epochAtCompletion: number;
}

/**
 * WS4 Ticket 6 — Queue-position snapshot.
 *
 * Emitted after every enqueue and after every drain (when the queue advances).
 * Subscribers use this to send honest `queue_position` messages to waiting
 * speakers. Positions are 1-indexed (position 1 = next to be served).
 *
 * CANON (Theater Prohibition): positions are recomputed from the live queue at
 * emit time — never cached, never invented. Guardian-lane preemption means
 * positions can change between enqueue and drain; recipients must treat these
 * as "current estimate", not a promise.
 */
export interface QueuePositionSnapshot {
  /** Ordered list of waiting turns with their current 1-based positions. */
  readonly positions: ReadonlyArray<{
    /** The waiting turn's ID. */
    readonly turnId: string;
    /** The speaker's userId (undefined for anonymous/self-tick). */
    readonly userId?: string;
    /** The speaker's socket ID (for targeted notification delivery). */
    readonly socketId?: string;
    /** 1-based position in the combined queue (guardian lane first). */
    readonly position: number;
  }>;
}

/** Emitted when circuit breaker state changes. */
export interface BreakerStateEvent {
  type: 'ENTER' | 'EXIT';
  consecutiveKills: number;
}

/**
 * Callback type for the actual cycle execution.
 * DecisionMakingService provides this when registering with CycleGuard.
 * Returns a boolean: true = success, false = degraded/failed (for breaker counting).
 */
export type CycleRunnerFn = (turn: InboundTurn, myEpoch: number) => Promise<boolean>;

/**
 * Callback type for emitting a watchdog/degraded SHRUG.
 * Called with the turnId and a message; the actual responseSubject.next is guarded
 * by the epoch check in DecisionMakingService.
 */
export type ShrugEmitterFn = (turnId: string, message: string, epoch: number) => void;

/**
 * Callback consulted by drainNext() to determine if an externally-managed
 * cycle is in flight (i.e. a self-tick in DecisionMakingService).
 *
 * Pre-fix (WS4 T3 pre-fix): drainNext() previously only checked its own
 * `tickInFlight`, but self-ticks set a separate `selfTickInFlight` flag in
 * DecisionMakingService. A queue turn arriving mid-self-tick could start a
 * concurrent cycle and trip the :674 executor throw (I1/N4 invariant violation).
 *
 * With this callback, drainNext() defers when either flag is true. The caller
 * is responsible for calling `notifyExternalComplete()` when the self-tick
 * finishes so stranded queue turns resume draining.
 */
export type IsExternallyBusyFn = () => boolean;

// ---------------------------------------------------------------------------
// CycleGuardService
// ---------------------------------------------------------------------------

@Injectable()
export class CycleGuardService {
  private readonly logger = new Logger(CycleGuardService.name);

  // ── Two-lane FIFO queue ──────────────────────────────────────────────────

  /** Guardian-priority lane: drained first. */
  private readonly guardianLane: InboundTurn[] = [];

  /** Normal lane: drained when guardian lane is empty. */
  private readonly normalLane: InboundTurn[] = [];

  // ── Mutex ─────────────────────────────────────────────────────────────────

  /**
   * Whether a cycle is currently in flight.
   *
   * This is the formalized `tickInFlight` from decision-making.service.ts.
   * It is a simple boolean flag — NOT a promise-chained lock — so the watchdog
   * can force-release it (step 2 of recovery) without deadlocking the mind.
   *
   * Invariant: set true at cycle start, released in the finally that wraps
   * the entire processInput() call. NEVER keyed on executor-IDLE.
   */
  private tickInFlight = false;

  // ── Epoch fence ──────────────────────────────────────────────────────────

  /**
   * Monotonic epoch counter. Incremented on every cycle start AND every watchdog fire.
   * The in-flight cycle captures its epoch at start; all state-mutating ops in the
   * :1058–:1377 tail check `myEpoch === cycleEpoch` before acting.
   *
   * This is the primary anti-zombie mechanism: a watchdog-killed cycle that resolves
   * late sees a stale epoch and emits/mutates nothing.
   */
  cycleEpoch = 0;

  // ── Watchdog ──────────────────────────────────────────────────────────────

  /** Handle to the active watchdog timer. Cleared in the cycle finally. */
  private watchdogHandle: ReturnType<typeof setTimeout> | null = null;

  /** The turn currently being processed (for watchdog SHRUG addressing). */
  private inFlightTurn: InboundTurn | null = null;

  /** Wall-clock time when the current cycle started (for elapsedMs reporting). */
  private cycleStartedAt = 0;

  // ── Circuit breaker ────────────────────────────────────────────────────────

  /** How many consecutive watchdog kills have occurred without a successful completion. */
  private consecutiveKills = 0;

  /** Whether the circuit breaker has tripped into degraded mode. */
  isDegradedMode = false;

  /** Number of consecutive successful probes while in degraded mode. */
  private consecutiveProbeSuccesses = 0;

  /** Handle to the periodic probe timer (active only in degraded mode). */
  private probeHandle: ReturnType<typeof setInterval> | null = null;

  /** Whether we are currently running a probe cycle. */
  private isProbing = false;

  // ── Observables ──────────────────────────────────────────────────────────

  private readonly declined$ = new Subject<TurnDeclinedEvent>();
  private readonly watchdogKill$ = new Subject<WatchdogKillEvent>();
  private readonly completed$ = new Subject<TurnCompletedEvent>();
  private readonly breakerState$ = new Subject<BreakerStateEvent>();
  /** WS4 Ticket 6: emits after every enqueue and every drain. */
  private readonly queuePositions$ = new Subject<QueuePositionSnapshot>();

  get turnDeclined$(): Observable<TurnDeclinedEvent> { return this.declined$.asObservable(); }
  get cycleWatchdogKill$(): Observable<WatchdogKillEvent> { return this.watchdogKill$.asObservable(); }
  get cycleCompleted$(): Observable<TurnCompletedEvent> { return this.completed$.asObservable(); }
  get circuitBreakerState$(): Observable<BreakerStateEvent> { return this.breakerState$.asObservable(); }

  /**
   * WS4 Ticket 6 — Queue-position updates.
   *
   * Emits after every enqueue (when a turn joins the waiting queue) and after
   * every drain (when the queue advances and waiting positions shift). Subscribers
   * send honest `queue_position` messages to waiting speakers so they know where
   * they stand.
   *
   * Positions are recomputed from the live queue at emit time (CANON theater
   * prohibition: never invent a position). Guardian-lane preemption means a
   * non-guardian's position can increase; the message is explicit about that.
   *
   * NOTE: Only emitted when there are actual waiting turns (queue non-empty).
   * An empty-queue snapshot is not emitted — there is nothing to notify.
   */
  get queuePositionUpdates$(): Observable<QueuePositionSnapshot> {
    return this.queuePositions$.asObservable();
  }

  // ── Registered callbacks ──────────────────────────────────────────────────

  /** The actual cycle runner provided by DecisionMakingService. */
  private cycleRunner: CycleRunnerFn | null = null;

  /** SHRUG emitter provided by DecisionMakingService. */
  private shrugEmitter: ShrugEmitterFn | null = null;

  /** Executor engine reference for forceIdle() in watchdog recovery. */
  private executorEngine: IExecutorEngine | null = null;

  /**
   * Pre-fix (WS4 T3 pre-fix): optional callback checked by drainNext().
   * Returns true when an externally-managed cycle (self-tick) is in flight.
   * drainNext() defers when this returns true; the caller calls
   * notifyExternalComplete() when the external cycle finishes so queued
   * turns resume.
   */
  private isExternallyBusy: IsExternallyBusyFn | null = null;

  constructor(
    @Optional()
    @Inject(DECISION_EVENT_LOGGER)
    private readonly eventLogger: IDecisionEventLogger | null,
  ) {}

  // ---------------------------------------------------------------------------
  // Registration API (called by DecisionMakingService during init)
  // ---------------------------------------------------------------------------

  /**
   * Register the cycle runner and SHRUG emitter callbacks.
   * Must be called before any turns are enqueued.
   *
   * @param isExternallyBusy - Optional. Callback returning true when a
   *   self-tick (or other externally-managed cycle) is in flight. drainNext()
   *   defers while this returns true, preventing concurrent cycles (pre-fix).
   */
  register(
    cycleRunner: CycleRunnerFn,
    shrugEmitter: ShrugEmitterFn,
    executorEngine: IExecutorEngine,
    isExternallyBusy?: IsExternallyBusyFn,
  ): void {
    this.cycleRunner = cycleRunner;
    this.shrugEmitter = shrugEmitter;
    this.executorEngine = executorEngine;
    this.isExternallyBusy = isExternallyBusy ?? null;
  }

  /**
   * Notify the guard that an externally-managed cycle (self-tick) has
   * completed and queued turns should resume draining.
   *
   * Call this from the `finally` block of self-tick execution (onTick).
   * Without this, turns queued during a self-tick would wait indefinitely
   * for a drainNext() trigger that never comes.
   */
  notifyExternalComplete(): void {
    // Attempt to drain on the next microtask so the caller's `finally` has
    // fully released selfTickInFlight before isExternallyBusy() is consulted.
    void Promise.resolve().then(() => this.drainNext());
  }

  // ---------------------------------------------------------------------------
  // Public API — inbound turn admission
  // ---------------------------------------------------------------------------

  /**
   * Admit an inbound turn into the queue.
   *
   * If both lanes are at capacity (total ≥ 12):
   *   - If the new turn is a guardian: evict the oldest waiting non-guardian
   *     to make room (never evict the head-of-line, never evict guardian).
   *   - If the new turn is non-guardian: evict the oldest waiting non-guardian
   *     (which is this turn itself if there are no others waiting — i.e. decline
   *     the arrival). Livelock guard: never evict the turn that is next-to-serve.
   *
   * If the queue is not full: enqueue immediately and drain if the mutex is free.
   *
   * CANON Standard 4 (Theater Prohibition): an honest addressed decline is emitted
   * for every evicted turn. No silent drops.
   */
  enqueue(turn: InboundTurn): void {
    const total = this.guardianLane.length + this.normalLane.length;

    if (total >= QUEUE_DEPTH) {
      this.handleOverflow(turn);
      return;
    }

    this.admit(turn);
    // WS4 Ticket 6: notify waiting speakers of their position after admission.
    // Only emit if a cycle is already in flight — if the mutex is free, drainNext()
    // will pop this turn immediately and it will never actually "wait". Emitting a
    // position for a turn that starts processing in the same microtask would produce
    // a spurious "Position 1 in queue" flash for turns that are served right away.
    if (this.tickInFlight || this.isExternallyBusy?.()) {
      this.emitQueuePositions();
    }
    this.drainNext();
  }

  /**
   * Run a cycle for a self-initiated tick (no originator, no queue entry).
   *
   * Self-ticks (200ms background timer) respect the mutex but do NOT enter
   * the inbound queue — they have no originator to address a decline to.
   * If a cycle is already in flight, this is a no-op (same as old behavior).
   *
   * Spec §5 N4: 200ms self-tick path still works.
   */
  async runSelfTick(runner: () => Promise<void>): Promise<void> {
    if (this.tickInFlight) {
      return; // mutex held — skip
    }
    // For self-ticks the epoch/watchdog/drainer machinery does NOT apply.
    // The self-tick runner sets tickInFlight itself (the existing :376/:406 pattern).
    // We just delegate — the caller's finally block releases tickInFlight.
    await runner();
  }

  // ---------------------------------------------------------------------------
  // Queue management (internal)
  // ---------------------------------------------------------------------------

  /**
   * Compute the total queue depth across both lanes.
   */
  get queueDepth(): number {
    return this.guardianLane.length + this.normalLane.length;
  }

  private admit(turn: InboundTurn): void {
    if (turn.isGuardian) {
      this.guardianLane.push(turn);
    } else {
      this.normalLane.push(turn);
    }
  }

  /**
   * Handle queue overflow (total ≥ QUEUE_DEPTH).
   *
   * Policy (spec §2):
   *  - Never evict the head-of-line (next-to-serve). Head of combined queue is
   *    guardianLane[0] if non-empty, else normalLane[0].
   *  - Never evict a guardian turn.
   *  - Evict the oldest waiting non-guardian that is NOT the head-of-line.
   *  - If no such turn exists (e.g. all slots are guardian), decline the arrival.
   */
  private handleOverflow(arriving: InboundTurn): void {
    // Determine who is the head-of-line (next to be drained).
    const headOfLine: InboundTurn | undefined =
      this.guardianLane[0] ?? this.normalLane[0];

    // Find the oldest waiting non-guardian that is not the head-of-line.
    // normalLane is FIFO oldest-first (index 0 is oldest = soonest to serve).
    // We skip index 0 if it IS the head-of-line (it will be next anyway).
    let evictIndex = -1;
    for (let i = 0; i < this.normalLane.length; i++) {
      const candidate = this.normalLane[i];
      // Skip the head-of-line slot.
      if (candidate === headOfLine) {
        continue;
      }
      // Take the oldest eligible (first eligible from the front).
      if (evictIndex === -1 || (this.normalLane[i]?.enqueuedAt ?? 0) < (this.normalLane[evictIndex]?.enqueuedAt ?? 0)) {
        evictIndex = i;
        break; // FIFO: first non-head non-guardian = oldest
      }
    }

    if (evictIndex === -1) {
      // No non-guardian non-head slot available — decline the arriving turn itself.
      this.emitDecline(arriving, this.guardianLane.length + this.normalLane.length, 0);
      return;
    }

    const evicted = this.normalLane.splice(evictIndex, 1)[0];
    if (evicted) {
      const waitedMs = Date.now() - evicted.enqueuedAt;
      this.emitDecline(evicted, this.guardianLane.length + this.normalLane.length + 1, waitedMs);
    }

    // Now admit the arriving turn.
    this.admit(arriving);
    // WS4 Ticket 6: notify waiting speakers of updated positions. In overflow, there
    // is always a cycle in flight (otherwise the queue wouldn't be full), so this is
    // always meaningful to emit.
    this.emitQueuePositions();
    this.drainNext();
  }

  /**
   * Pop the next turn to serve (guardian lane first, then normal lane).
   * Returns null when both lanes are empty.
   */
  private popNext(): InboundTurn | null {
    if (this.guardianLane.length > 0) {
      return this.guardianLane.shift() ?? null;
    }
    if (this.normalLane.length > 0) {
      return this.normalLane.shift() ?? null;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Drain loop
  // ---------------------------------------------------------------------------

  /**
   * Attempt to drain the next queued turn.
   *
   * Called after every enqueue and after every cycle completion.
   * One pop → one cycle → one response. Serial.
   *
   * In degraded mode: skip LLM cycles; use the probe scheduling instead.
   *
   * Pre-fix (WS4 T3 pre-fix): also defers when an external cycle (self-tick)
   * is in flight via the isExternallyBusy callback. The caller calls
   * notifyExternalComplete() when the external cycle finishes.
   */
  private drainNext(): void {
    if (this.tickInFlight) {
      return; // Cycle in flight — drain will be called from its finally block.
    }
    // Pre-fix: defer when a self-tick is in flight to preserve I1 invariant.
    if (this.isExternallyBusy?.()) {
      return; // External cycle in flight — notifyExternalComplete() will re-drain.
    }
    if (this.normalLane.length === 0 && this.guardianLane.length === 0) {
      return; // Empty queue — nothing to do.
    }

    const turn = this.popNext();
    if (!turn) return;

    // WS4 Ticket 6: after popping a turn (queue advanced), notify remaining
    // waiters so their position numbers reflect the new queue state.
    // This fires even in degraded mode — positions are always honest.
    this.emitQueuePositions();

    // In degraded mode, emit an honest SHRUG rather than attempting a full cycle.
    if (this.isDegradedMode && !this.isProbing) {
      this.emitDegradedShrug(turn);
      // Continue draining (more turns may be waiting).
      void Promise.resolve().then(() => this.drainNext());
      return;
    }

    // Run the cycle asynchronously. Do NOT await — the drain is fire-and-forget
    // from the caller's perspective; the cycle's finally block calls drainNext().
    void this.runCycle(turn);
  }

  // ---------------------------------------------------------------------------
  // Cycle execution (single turn)
  // ---------------------------------------------------------------------------

  /**
   * Run one full cycle for the given turn, with mutex + watchdog + epoch.
   *
   * This is the critical section. One turn at a time.
   *
   * Steps:
   *   1. Acquire mutex (set tickInFlight = true).
   *   2. Capture epoch (myEpoch = ++cycleEpoch).
   *   3. Arm watchdog.
   *   4. Run the cycle runner (processInput wrapper in DecisionMakingService).
   *   5. In finally: disarm watchdog, release mutex (tickInFlight = false), drain next.
   */
  private async runCycle(turn: InboundTurn): Promise<void> {
    if (!this.cycleRunner || !this.shrugEmitter) {
      this.logger.error('CycleGuard: no cycleRunner registered — dropping turn silently (bug).');
      return;
    }

    // Acquire mutex.
    this.tickInFlight = true;
    this.inFlightTurn = turn;
    this.cycleStartedAt = Date.now();

    // Capture epoch. This is the ownership token for this cycle.
    const myEpoch = ++this.cycleEpoch;

    // Arm watchdog.
    this.armWatchdog(turn, myEpoch);

    let success = false;
    try {
      success = await this.cycleRunner(turn, myEpoch);
    } catch (err) {
      this.logger.error(`CycleGuard: cycle runner threw for turn ${turn.turnId}: ${err}`);
      // Do not re-throw — the cycle runner already handled forceIdle + logging.
      // The mutex must be released unconditionally.
    } finally {
      // ── Step 5: Release watchdog, release mutex, drain next. ──────────────
      this.disarmWatchdog();
      this.tickInFlight = false;
      this.inFlightTurn = null;

      // Epoch check: only update breaker/probe if this epoch is still current.
      // (If watchdog fired, epoch was incremented and this finally runs in the zombie.)
      if (myEpoch === this.cycleEpoch) {
        // Normal completion: update circuit breaker state.
        if (success) {
          this.onSuccessfulCompletion();
        }
        // (Failure is handled in the watchdog handler, not here.)
        this.completed$.next({ turnId: turn.turnId, epochAtCompletion: myEpoch });
      }
      // Always drain next — even if we are the zombie, the mutex is now free.
      // If myEpoch !== cycleEpoch, the watchdog already incremented epoch and
      // drained next; this drain call will see tickInFlight === false and an
      // empty queue (if watchdog already kicked off the next cycle). Idempotent.
      void Promise.resolve().then(() => this.drainNext());
    }
  }

  // ---------------------------------------------------------------------------
  // Watchdog
  // ---------------------------------------------------------------------------

  /**
   * Arm the whole-cycle watchdog.
   * Called immediately after acquiring the mutex.
   * Captures `turn` and `myEpoch` for the recovery handler.
   */
  private armWatchdog(turn: InboundTurn, myEpoch: number): void {
    if (this.watchdogHandle !== null) {
      clearTimeout(this.watchdogHandle);
    }
    this.watchdogHandle = setTimeout(() => {
      void this.handleWatchdogFire(turn, myEpoch);
    }, WATCHDOG_T_MAX_MS);
  }

  /**
   * Disarm the watchdog. Called in the cycle's finally block.
   */
  private disarmWatchdog(): void {
    if (this.watchdogHandle !== null) {
      clearTimeout(this.watchdogHandle);
      this.watchdogHandle = null;
    }
  }

  /**
   * Watchdog recovery — 6-step sequence (spec §3.4).
   *
   * 1. executorEngine.forceIdle()
   * 2. Force tickInFlight = false
   * 3. Increment cycleEpoch
   * 4. Emit honest SHRUG addressed to the wedged turn's originator
   * 5. Log CYCLE_WATCHDOG_KILL
   * 6. Drain next
   */
  private async handleWatchdogFire(turn: InboundTurn, capturedEpoch: number): Promise<void> {
    const elapsedMs = Date.now() - this.cycleStartedAt;

    // Check the captured epoch is still current. If the cycle already completed
    // normally (race between watchdog and finally), skip recovery.
    if (capturedEpoch !== this.cycleEpoch) {
      this.logger.debug(
        `Watchdog fired for turn ${turn.turnId} but epoch changed (${capturedEpoch} → ${this.cycleEpoch}); cycle completed normally — skipping recovery.`,
      );
      return;
    }

    const wedgedState = this.executorEngine
      ? String(this.executorEngine.getState())
      : 'UNKNOWN';

    this.logger.warn(
      `WATCHDOG KILL: turn ${turn.turnId}, elapsed=${elapsedMs}ms, state=${wedgedState}, epoch=${capturedEpoch}`,
    );

    // Step 1: FSM reset FIRST (executor-only → mutex held forever; mutex-only → :438 throw).
    if (this.executorEngine) {
      try {
        this.executorEngine.forceIdle();
      } catch (err) {
        this.logger.warn(`Watchdog forceIdle() failed: ${err}`);
      }
    }

    // Step 2: Force-release mutex.
    this.tickInFlight = false;
    this.inFlightTurn = null;

    // Step 3: Increment epoch — neutralizes the zombie.
    // Any late-resolving cycle that checks `myEpoch === this.cycleEpoch` will see
    // a stale epoch and emit/mutate nothing.
    this.cycleEpoch++;

    // Step 4: Emit honest SHRUG addressed to the wedged turn.
    const shrugMessage =
      "I got stuck thinking about that one and had to let it go. Could you ask me again?";
    if (this.shrugEmitter) {
      try {
        // Pass the NEW epoch so the emitter's own epoch check passes.
        this.shrugEmitter(turn.turnId, shrugMessage, this.cycleEpoch);
      } catch (err) {
        this.logger.warn(`Watchdog shrugEmitter failed: ${err}`);
      }
    }

    // Step 5: Log CYCLE_WATCHDOG_KILL.
    const killEvent: WatchdogKillEvent = {
      turnId: turn.turnId,
      wedgedState,
      elapsedMs,
      cycleEpoch: this.cycleEpoch,
    };
    this.watchdogKill$.next(killEvent);
    this.logEvent('CYCLE_WATCHDOG_KILL', {
      turnId: turn.turnId,
      wedgedState,
      elapsedMs,
      cycleEpoch: this.cycleEpoch,
    });

    // Update circuit breaker.
    this.consecutiveKills++;
    if (this.consecutiveKills >= BREAKER_KILL_THRESHOLD && !this.isDegradedMode) {
      this.enterDegradedMode();
    }

    // Step 6: Drain next.
    void Promise.resolve().then(() => this.drainNext());
  }

  // ---------------------------------------------------------------------------
  // Circuit breaker
  // ---------------------------------------------------------------------------

  private enterDegradedMode(): void {
    this.isDegradedMode = true;
    this.consecutiveProbeSuccesses = 0;
    this.isProbing = false;

    this.logger.warn(
      `CIRCUIT BREAKER TRIPPED: ${this.consecutiveKills} consecutive kills → entering degraded mode.`,
    );
    this.breakerState$.next({ type: 'ENTER', consecutiveKills: this.consecutiveKills });
    this.logEvent('CYCLE_DEGRADED_MODE_ENTER', { consecutiveKills: this.consecutiveKills });

    // Start probe timer.
    if (this.probeHandle !== null) {
      clearInterval(this.probeHandle);
    }
    this.probeHandle = setInterval(() => {
      void this.runProbe();
    }, BREAKER_PROBE_INTERVAL_MS);
  }

  private exitDegradedMode(): void {
    this.isDegradedMode = false;
    this.consecutiveKills = 0;
    this.consecutiveProbeSuccesses = 0;
    this.isProbing = false;

    if (this.probeHandle !== null) {
      clearInterval(this.probeHandle);
      this.probeHandle = null;
    }

    this.logger.log('CIRCUIT BREAKER RESET: 2 consecutive successful probes → exiting degraded mode.');
    this.breakerState$.next({ type: 'EXIT', consecutiveKills: 0 });
    this.logEvent('CYCLE_DEGRADED_MODE_EXIT', { consecutiveProbeSuccesses: this.consecutiveProbeSuccesses });
  }

  /**
   * Run a single probe cycle to test LLM availability.
   * One turn is promoted to full TYPE_2 under the normal watchdog.
   * 2 consecutive successes → exit degraded mode.
   */
  private async runProbe(): Promise<void> {
    if (this.isProbing || this.tickInFlight) {
      return; // Don't stack probes.
    }
    if (!this.isDegradedMode) {
      return; // Mode exited already.
    }

    this.isProbing = true;
    const probeTurn: InboundTurn = {
      turnId: `probe-${Date.now()}`,
      isGuardian: false,
      receivedAt: Date.now(),
      enqueuedAt: Date.now(),
      text: '[circuit-breaker probe]',
    };

    // Temporarily lift degraded mode so the full cycle runs.
    let success = false;
    this.tickInFlight = true;
    const myEpoch = ++this.cycleEpoch;
    this.armWatchdog(probeTurn, myEpoch);
    this.inFlightTurn = probeTurn;
    this.cycleStartedAt = Date.now();

    try {
      if (this.cycleRunner) {
        success = await this.cycleRunner(probeTurn, myEpoch);
      }
    } catch {
      success = false;
    } finally {
      this.disarmWatchdog();
      this.tickInFlight = false;
      this.inFlightTurn = null;
      this.isProbing = false;

      if (myEpoch === this.cycleEpoch) {
        if (success) {
          this.consecutiveProbeSuccesses++;
          this.logger.log(
            `Probe success ${this.consecutiveProbeSuccesses}/${BREAKER_PROBE_SUCCESS_THRESHOLD}`,
          );
          if (this.consecutiveProbeSuccesses >= BREAKER_PROBE_SUCCESS_THRESHOLD) {
            this.exitDegradedMode();
            // Resume draining queued turns.
            void Promise.resolve().then(() => this.drainNext());
          }
        } else {
          this.consecutiveProbeSuccesses = 0;
          this.logger.warn('Probe failed — staying in degraded mode.');
        }
      }
    }
  }

  /** Called from the cycle runner's finally block on a non-watchdog completion. */
  private onSuccessfulCompletion(): void {
    if (this.consecutiveKills > 0) {
      this.consecutiveKills = 0;
      this.logger.debug('Cycle completed successfully — consecutive kill counter reset.');
    }
  }

  // ---------------------------------------------------------------------------
  // Decline emission
  // ---------------------------------------------------------------------------

  /**
   * Emit an honest addressed decline for an evicted turn.
   *
   * CANON Standard 4 (Theater Prohibition): never silent. The message is
   * exactly as specified.
   */
  private emitDecline(
    turn: InboundTurn,
    queueDepthAtEviction: number,
    waitedMs: number,
  ): void {
    const message =
      "I'm a bit overwhelmed right now — too many things at once. Ask me again in a moment and I'll get to it.";

    const event: TurnDeclinedEvent = {
      turnId: turn.turnId,
      reason: 'BACKPRESSURE',
      message,
      queueDepthAtEviction,
      waitedMs,
    };

    this.declined$.next(event);
    this.logEvent('CYCLE_BACKPRESSURE_DECLINE', {
      turnId: turn.turnId,
      userId: (turn as any).userId ?? null,
      queueDepthAtEviction,
      waitedMs,
    });

    this.logger.warn(
      `BACKPRESSURE DECLINE: turn ${turn.turnId}, queueDepth=${queueDepthAtEviction}, waited=${waitedMs}ms`,
    );
  }

  /**
   * Emit a degraded SHRUG for a turn processed in degraded mode.
   * Reuses the same SHRUG message and path as lesion mode.
   */
  private emitDegradedShrug(turn: InboundTurn): void {
    const message =
      "I got stuck thinking about that one and had to let it go. Could you ask me again?";

    if (this.shrugEmitter) {
      try {
        this.shrugEmitter(turn.turnId, message, this.cycleEpoch);
      } catch (err) {
        this.logger.warn(`Degraded shrug emitter failed: ${err}`);
      }
    }

    this.logger.debug(`Degraded mode SHRUG emitted for turn ${turn.turnId}`);
  }

  // ---------------------------------------------------------------------------
  // Epoch check helper (exported for use in DecisionMakingService)
  // ---------------------------------------------------------------------------

  /**
   * Check whether the given epoch still matches the current cycle epoch.
   *
   * This is the zombie fence used at every state-mutating / emit operation
   * in the :1058–:1377 tail of processInput(). If this returns false, the
   * caller must abort silently — it is a zombie.
   */
  isEpochCurrent(myEpoch: number): boolean {
    return myEpoch === this.cycleEpoch;
  }

  // ---------------------------------------------------------------------------
  // Stats (for monitoring / tests)
  // ---------------------------------------------------------------------------

  getQueueStats(): {
    guardianLane: number;
    normalLane: number;
    total: number;
    tickInFlight: boolean;
    cycleEpoch: number;
    consecutiveKills: number;
    isDegradedMode: boolean;
  } {
    return {
      guardianLane: this.guardianLane.length,
      normalLane: this.normalLane.length,
      total: this.queueDepth,
      tickInFlight: this.tickInFlight,
      cycleEpoch: this.cycleEpoch,
      consecutiveKills: this.consecutiveKills,
      isDegradedMode: this.isDegradedMode,
    };
  }

  // ---------------------------------------------------------------------------
  // WS4 Ticket 6 — Queue-position notification seam (additive only)
  // ---------------------------------------------------------------------------

  /**
   * Emit a queue-position snapshot to all subscribers.
   *
   * Called after every admit (enqueue) and after every drain (popNext).
   * Only emits when at least one turn is waiting — an empty queue means no one
   * needs a position update.
   *
   * CANON (Theater Prohibition): positions are computed from the LIVE queue at
   * call time. Never cached, never speculative. Guardian-lane preemption means
   * a non-guardian's position can shift between an enqueue and drain emit.
   *
   * ADDITIVE: this method only reads queue state and emits on an observable.
   * It does NOT touch mutex, watchdog, epoch, or any cycle logic.
   */
  private emitQueuePositions(): void {
    const total = this.guardianLane.length + this.normalLane.length;
    if (total === 0) {
      // Nothing is waiting — no notification needed.
      return;
    }

    // Build ordered list: guardian lane first (FIFO within lane), then normal.
    const combined: InboundTurn[] = [...this.guardianLane, ...this.normalLane];
    const positions = combined.map((turn, index) => ({
      turnId: turn.turnId,
      userId: turn.userId,
      socketId: turn.socketId,
      position: index + 1, // 1-based
    }));

    this.queuePositions$.next({ positions });
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  destroy(): void {
    this.disarmWatchdog();
    if (this.probeHandle !== null) {
      clearInterval(this.probeHandle);
      this.probeHandle = null;
    }
    this.declined$.complete();
    this.watchdogKill$.complete();
    this.completed$.complete();
    this.breakerState$.complete();
    this.queuePositions$.complete();
  }

  // ---------------------------------------------------------------------------
  // Internal event logging
  // ---------------------------------------------------------------------------

  private logEvent(eventType: string, payload: Record<string, unknown>): void {
    if (!this.eventLogger) return;
    try {
      // Use a minimal stub drive snapshot — the real one is not available here.
      // The event logger accepts null-ish snapshots gracefully.
      const stubSnapshot = {
        pressureVector: {},
        totalPressure: 0,
        timestamp: new Date(),
        tickNumber: 0,
        driveDeltas: {},
        ruleMatchResult: { ruleId: null, eventType, matched: false },
        sessionId: 'concurrency-guard',
      } as unknown as DriveSnapshot;

      this.eventLogger.log(eventType, payload, stubSnapshot, 'concurrency-guard');
    } catch (err) {
      this.logger.warn(`CycleGuard event logging failed: ${err}`);
    }
  }
}
