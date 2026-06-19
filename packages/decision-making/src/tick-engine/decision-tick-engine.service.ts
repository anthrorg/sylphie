/**
 * DecisionTickEngine — Self-initiated tick loop for the cognitive decision cycle.
 *
 * Extracted from DecisionMakingService (EP7-A, TK-31). Owns the timer, the
 * self-tick in-flight mutex, and all lifecycle/constant state for the
 * background tick loop. Behavior is byte-identical to the original inline code.
 *
 * Two trigger paths:
 *   1. Timer ticks (every intervalMs): fire when drive pressure is sufficient.
 *   2. Event ticks (immediate, via onNewInput / onSceneChange hooks): handled
 *      by routing directly into CycleGuard from startTickLoop.
 *
 * Logger name is deliberately set to DecisionMakingService so that log lines
 * remain byte-identical to the pre-extraction golden (AC3).
 */

import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  ExecutorState,
  DriveName,
  verboseFor,
  type SensoryFrame,
} from '@sylphie/shared';
import { DRIVE_STATE_READER, type IDriveStateReader } from '@sylphie/drive-engine';
import type { IExecutorEngine, ITensorInferenceService } from '../interfaces/decision-making.interfaces';
import {
  EXECUTOR_ENGINE,
  TENSOR_INFERENCE_SERVICE,
  MOOD_BLEED_MONITOR_SERVICE,
} from '../decision-making.tokens';
import { CycleGuardService } from '../concurrency/cycle-guard.service';
import { TickSamplerService } from '../inputs/sampling/tick-sampler';
import { SensoryStreamLoggerService } from '../logging/sensory-stream-logger.service';
import { MoodBleedMonitorService } from '../monitoring/mood-bleed-monitor.service';
import { WkgContextService } from '../wkg/wkg-context.service';
import type { InboundTurn } from '../concurrency/inbound-turn';

// Must match the source module so that emitted log lines are byte-identical.
const LOGGER_CONTEXT = 'DecisionMakingService';

const vlog = verboseFor('Cortex');

/**
 * Callbacks provided by DecisionMakingService so the tick engine can call back
 * into the parent without creating a circular injection dependency.
 */
export interface TickEngineCallbacks {
  /** Run one cognitive cycle for a sampled sensory frame. */
  processInput(frame: SensoryFrame): Promise<void>;
}

@Injectable()
export class DecisionTickEngineService {
  // Logger context matches the original so log lines are byte-identical (AC3).
  private readonly logger = new Logger(LOGGER_CONTEXT);

  /** Handle for the background timer tick. null when not running. */
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Whether a self-initiated tick cycle is currently in-flight.
   *
   * WS4 Ticket 1: for queue-admitted turns, CycleGuard manages this flag.
   * For self-initiated ticks (timer path), onTick manages it directly.
   * The self-tick check reads from CycleGuard to avoid split-brain: both
   * the queue path and self-tick path must see the same mutex state.
   *
   * @deprecated Direct field reads from onTick() use cycleGuard instead.
   *   Kept as a local flag only for the self-tick path.
   */
  private selfTickInFlight = false;

  /** Default background timer interval in milliseconds. */
  static readonly DEFAULT_TICK_MS = 200;

  /**
   * Minimum total drive pressure required to trigger a self-initiated cycle.
   * Initial drive state has total pressure 0.0 (all drives start at zero).
   * Self-initiated cycles should only fire when pressure has genuinely built
   * up beyond baseline (e.g., boredom accumulating over time).
   */
  private static readonly IDLE_PRESSURE_THRESHOLD = 4.0;

  /**
   * Minimum interval between self-initiated ticks in milliseconds.
   * Even when pressure exceeds the threshold, self-initiated ticks are
   * rate-limited to prevent log spam. Event-driven ticks (from real input)
   * are NOT rate-limited.
   */
  private static readonly SELF_INITIATE_COOLDOWN_MS = 10_000;

  /** Timestamp of the last self-initiated tick. */
  private lastSelfInitiatedAt = 0;

  /** Callbacks into DecisionMakingService — wired after construction via wire(). */
  private callbacks: TickEngineCallbacks | null = null;

  constructor(
    private readonly tickSampler: TickSamplerService,
    private readonly cycleGuard: CycleGuardService,

    @Inject(DRIVE_STATE_READER)
    private readonly driveStateReader: IDriveStateReader,

    @Inject(EXECUTOR_ENGINE)
    private readonly executorEngine: IExecutorEngine,

    private readonly streamLogger: SensoryStreamLoggerService,
    private readonly wkgContext: WkgContextService,

    // Optional so the loop degrades gracefully if the tensor sidecar is absent.
    @Optional()
    @Inject(TENSOR_INFERENCE_SERVICE)
    private readonly tensorInference: ITensorInferenceService | null,

    // Optional so the loop degrades gracefully if mood-bleed monitoring is absent.
    @Optional()
    @Inject(MOOD_BLEED_MONITOR_SERVICE)
    private readonly moodBleedMonitor: MoodBleedMonitorService | null,
  ) {}

  /**
   * Wire in the DecisionMakingService callbacks.
   * Must be called from DecisionMakingService.onModuleInit() before startTickLoop().
   */
  wire(callbacks: TickEngineCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * Expose selfTickInFlight so DecisionMakingService can pass it to CycleGuard
   * as the isExternallyBusy predicate.
   */
  isSelfTickInFlight(): boolean {
    return this.selfTickInFlight;
  }

  /**
   * Start the tick engine.
   *
   * Two trigger paths:
   *
   * 1. **Timer ticks** (background, every intervalMs): Check whether drive
   *    pressure alone warrants a self-initiated cycle. This is how Sylphie
   *    acts without external input — boredom, curiosity, social drive build
   *    up and eventually trigger action.
   *
   * 2. **Event ticks** (immediate, via `nudge()`): Called by the TickSampler
   *    when event-driven input arrives (text, audio). Bypasses the timer
   *    wait and runs the cycle immediately. This eliminates the up-to-200ms
   *    latency that would otherwise be perceptible on reactive input.
   *
   * Both paths funnel through the same `onTick()` method with the same
   * non-overlapping guard. If a cycle is in-flight when either trigger fires,
   * the trigger is ignored — the in-flight cycle will see the new data on
   * its next iteration.
   *
   * @param intervalMs - Background timer interval in ms. Defaults to 200ms (5Hz).
   */
  startTickLoop(intervalMs: number = DecisionTickEngineService.DEFAULT_TICK_MS): void {
    if (this.tickInterval !== null) {
      this.logger.warn('Tick loop already running; ignoring duplicate start.');
      return;
    }

    this.logger.log(
      `Starting tick engine: timer=${intervalMs}ms, event-driven=immediate`,
    );

    // Background timer for self-initiated cycles.
    this.tickInterval = setInterval(() => {
      void this.onTick(false);
    }, intervalMs);

    // Subscribe to event-driven input notifications from the TickSampler.
    // WS4 Ticket 1: route event-driven inputs through the CycleGuard queue
    // instead of directly calling onTick(). This replaces the silent drop at
    // :290 with an ordered, bounded FIFO queue. Self-initiated 200ms ticks still
    // call onTick(false) directly — they have no originator and bypass the queue
    // per spec §5 N4.
    this.tickSampler.onNewInput(() => {
      // NOTE (WS4 Ticket 2): this callback is now a safety net for non-text
      // event-driven modalities (currently none — only 'text' is event-driven).
      // Normal chat text no longer reaches here: it is enqueued by
      // CommunicationService.intakeTurn() via enqueueTurn(), which carries the
      // per-turn text on the InboundTurn. If a future modality is event-driven,
      // this callback should be updated to carry appropriate per-turn data.
      //
      // For now, if this fires, use the tickSampler's current text slot (if any)
      // as a fallback so legacy behavior is preserved.
      const turn: InboundTurn = {
        turnId: randomUUID(),
        isGuardian: false,
        receivedAt: Date.now(),
        enqueuedAt: Date.now(),
        text: '', // No per-turn text — this path is a fallback for future modalities
      };
      this.cycleGuard.enqueue(turn);
    });

    // WS5 T1.0 — scene-change cycle nudge. A confirmed-object scene change
    // (decided + deduped at the perception gateway) enqueues an originator-less,
    // non-guardian, empty-text turn so a cognitive cycle RUNS on the frame
    // carrying that scene. Without this, a salient-but-CALM visual frame on a
    // drive-cold backend never reaches the cycle: the self-tick is gated at
    // IDLE_PRESSURE_THRESHOLD (4.0) and `scene` is deliberately NOT a globally
    // event-driven modality (that would fire a cycle per frame ~15fps). The
    // sceneNudge turn drains exactly like a self-tick (scene read from the slot
    // via sample()), carries NO originator (currentTurnContext stays null →
    // speakerIsGuardian structurally absent, T0.9), and writes NOTHING to drives
    // (the trigger keys on an exogenous scene change; no perception→drive→
    // perception loop is closed — ashby/finding-I).
    this.tickSampler.onSceneChange(() => {
      const turn: InboundTurn = {
        turnId: randomUUID(),
        isGuardian: false, // exogenous scene change — never guardian-prioritized
        receivedAt: Date.now(),
        enqueuedAt: Date.now(),
        text: '', // no human text — the scene rides the tick-sampler slot
        sceneNudge: true, // T0.9: runCycleForTurn leaves currentTurnContext null
      };
      this.cycleGuard.enqueue(turn);
    });
  }

  /**
   * Stop the tick engine.
   * Safe to call even if not running.
   */
  stopTickLoop(): void {
    if (this.tickInterval !== null) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
      this.logger.log('Tick engine stopped.');
    }
  }

  /**
   * Single tick — used for self-initiated (timer) ticks only.
   *
   * WS4 Ticket 1: event-driven ticks no longer call this method. They are
   * intercepted by the tickSampler.onNewInput callback, which routes to
   * CycleGuard.enqueue(). Self-initiated (timer) ticks remain on this path
   * per spec §5 N4 — they bypass the inbound queue (no originator).
   *
   * @param eventDriven - always false in the current call path (kept for compat).
   */
  async onTick(eventDriven: boolean): Promise<void> {
    // Non-overlapping guard. CycleGuard manages tickInFlight for queue-admitted
    // turns; for self-ticks we read the combined flag (CycleGuard OR selfTickInFlight)
    // to stay out of the way of both queue cycles and other self-ticks.
    const isAnyTickInFlight = this.selfTickInFlight || this.cycleGuard.getQueueStats().tickInFlight;
    if (isAnyTickInFlight) {
      vlog('tick skipped (in-flight guard)', { eventDriven });
      return;
    }

    if (this.executorEngine.getState() !== ExecutorState.IDLE) {
      vlog('tick skipped (executor not IDLE)', { state: this.executorEngine.getState(), eventDriven });
      return;
    }

    // ── Tensor training on EVERY tick ────────────────────────────────────
    // Every moment is training data. Even when the decision loop filters
    // this tick out (low pressure, no input), the tensor model needs to
    // learn: "in this state, the correct action is NO_ACTION." Without
    // this, the model only sees conversation turns and never learns when
    // to stay quiet.
    if (this.tensorInference?.isAvailable()) {
      try {
        const frame = await this.tickSampler.peek();
        const snapshot = this.driveStateReader.getCurrentState();
        this.tensorInference.submitTraining(
          frame,
          snapshot,
          'NO_ACTION',
          'IDLE',
        );
      } catch {
        // Silent — tensor training is never critical path
      }
    }

    // Timer ticks: only run if there's new input OR drive pressure is high enough.
    // WS4 Ticket 1: if there's new input it was already handled by CycleGuard
    // (the onNewInput callback enqueued it). A self-tick must NOT re-process
    // already-queued input or it would run a second cycle for the same text.
    if (!eventDriven) {
      if (this.tickSampler.hasNewInput()) {
        // Input is already queued in CycleGuard — skip the self-tick.
        vlog('self-tick skipped (input already queued by CycleGuard)', {});
        return;
      } else {
        const snapshot = this.driveStateReader.getCurrentState();
        if (snapshot.totalPressure < DecisionTickEngineService.IDLE_PRESSURE_THRESHOLD) {
          return; // Low pressure, no input — nothing to do.
        }
        // Suppress self-initiated ticks within 30s of last user input.
        // The user may still be thinking; avoid generating unprompted responses.
        const now = Date.now();
        const msSinceLastInput = now - this.tickSampler.getLastInputTimestamp();
        if (msSinceLastInput < 30_000) {
          return;
        }
        // Rate-limit self-initiated ticks to prevent log spam.
        if (now - this.lastSelfInitiatedAt < DecisionTickEngineService.SELF_INITIATE_COOLDOWN_MS) {
          return;
        }
        this.lastSelfInitiatedAt = now;

        // ── Autonomous boredom research ─────────────────────────────────
        // When boredom is high and there's no user input, pick a low-confidence
        // entity from the WKG and inject a synthetic research request. This
        // gives Sylphie something to do — she autonomously learns about topics
        // she knows little about, relieving boredom and curiosity.
        const boredom = snapshot.pressureVector[DriveName.Boredom] ?? 0;
        const curiosity = snapshot.pressureVector[DriveName.Curiosity] ?? 0;
        if (boredom > 0.6 || curiosity > 0.7) {
          const researchTarget = await this.pickResearchTarget();
          if (researchTarget) {
            vlog('autonomous research triggered', {
              boredom: +boredom.toFixed(3),
              curiosity: +curiosity.toFixed(3),
              target: researchTarget,
            });
            this.logger.log(
              `Autonomous research: boredom=${boredom.toFixed(2)}, curiosity=${curiosity.toFixed(2)} → researching "${researchTarget}"`,
            );
            // Inject synthetic text that will trigger the RESEARCH_ENTITY procedure
            // via the deliberation pipeline's COMMAND intent detection.
            this.tickSampler.injectSyntheticText(
              `I want to learn about ${researchTarget}`,
            );
          }
        }

        vlog('self-initiated tick', { pressure: +snapshot.totalPressure.toFixed(3), msSinceLastInput, boredom: +boredom.toFixed(3) });
        this.logger.debug(
          `Self-initiated tick: pressure=${snapshot.totalPressure.toFixed(3)}`,
        );
      }
    }

    // Self-initiated tick: acquire the local selfTickInFlight mutex.
    // This does NOT touch CycleGuard's tickInFlight — they are independent
    // but both are checked by the in-flight guard above.
    this.selfTickInFlight = true;
    try {
      // ── Sensory frame sampling ──────────────────────────────────────────────
      // The text encoder has its own timeout guard (DEFAULT_EMBED_TIMEOUT_MS =
      // 3000ms) and catches all failures gracefully — ECONNRESET (e.g. dead
      // Ollama or cassette lesion for chat-only) returns immediately with a zero
      // vector, and a truly hung endpoint is cut off by the timer. There is no
      // need to skip embedding here based on LLM chat availability; the encoder
      // degrades on its own. Keeping the embed path active under lesion is also
      // required for CANON §The Lesion Test: Type 1 latent-space reflexes must
      // survive LLM removal, which requires real embeddings.
      const frame = await this.tickSampler.sample();

      const rawText = frame.raw['text'] as string | undefined;
      vlog('tick sampled frame', {
        eventDriven,
        modalities: frame.active_modalities,
        textContent: rawText ? rawText.substring(0, 120) : null,
        embeddingNorm: +Math.sqrt(frame.fused_embedding.reduce((s, v) => s + v * v, 0)).toFixed(4),
      });

      // Persist the encoded frame to the sensory_ticks hypertable.
      // Fire-and-forget — never blocks the decision cycle.
      const snapshot = this.driveStateReader.getCurrentState();
      this.streamLogger.logFrame(frame, snapshot, snapshot.sessionId);

      // WS4 Ticket 8: Notify mood-bleed monitor of self-tick cycle start.
      // originator=null excludes self-ticks from speaker ledgers and baseline.
      // Exception-isolated: a monitor failure must never break a self-tick.
      try {
        this.moodBleedMonitor?.onCycleStart(null, snapshot);
      } catch (monitorErr) {
        this.logger.warn(`MoodBleedMonitor.onCycleStart (self-tick) failed: ${monitorErr}`);
      }

      // Self-ticks pass no epoch — they bypass CycleGuard and are never zombied.
      // wire() must be called before startTickLoop() — guard defensively so a
      // mis-ordered init fails loudly rather than silently dropping the frame.
      if (!this.callbacks) throw new Error('DecisionTickEngineService.wire() was not called before tick.');
      await this.callbacks.processInput(frame);
    } catch (err) {
      this.logger.error(`Tick cycle failed: ${err}`);
    } finally {
      // WS4 Ticket 8: Notify mood-bleed monitor of cycle end.
      // Exception-isolated: monitor failure must not prevent reset of selfTickInFlight.
      try {
        this.moodBleedMonitor?.onCycleEnd();
      } catch (monitorErr) {
        this.logger.warn(`MoodBleedMonitor.onCycleEnd (self-tick) failed: ${monitorErr}`);
      }
      this.selfTickInFlight = false;
      // Pre-fix (WS4 T3 pre-fix): notify CycleGuard that the self-tick is done
      // so any turns queued during this self-tick can resume draining.
      // Without this, a queue turn arriving mid-self-tick would be held by
      // drainNext()'s isExternallyBusy check and never re-triggered.
      this.cycleGuard.notifyExternalComplete();
    }
  }

  /**
   * Pick a low-confidence WKG entity label to research autonomously.
   * Returns null when nothing qualifies or on error.
   */
  private async pickResearchTarget(): Promise<string | null> {
    try {
      const entities = await this.wkgContext.queryEntities('*');
      if (entities.length === 0) return null;

      // Prefer entities with lower confidence (less well-known).
      // Filter out very generic labels and structural nodes.
      const candidates = entities
        .filter((e) =>
          e.nodeType === 'Entity' &&
          e.label.length > 2 &&
          e.confidence < 0.60,
        )
        .sort((a, b) => a.confidence - b.confidence)
        .slice(0, 10);

      if (candidates.length === 0) return null;

      // Pick randomly from top candidates.
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      return pick.label;
    } catch (err) {
      this.logger.warn(`pickResearchTarget failed: ${err}`);
      return null;
    }
  }
}
