/**
 * MoodBleedMonitorService — Hostile-Interlocutor Mood-Bleed Attractor Alert.
 *
 * WS4 Ticket 8 (spec: wiki/ws4-t8-mood-bleed-monitor-spec.md)
 *
 * Detects the HOSTILE_INTERLOCUTOR_MOOD_BLEED pattern: a single speaker whose
 * turns are measurably and disproportionately elevating Sylphie's negative
 * affect drives (Anxiety, Sadness, Guilt) relative to all other speakers and
 * relative to ambient baseline drift.
 *
 * Architecture:
 * - Tick-driven observer: subscribes to driveStateReader.driveState$ (1 Hz).
 * - Turn-window bracketing: onCycleStart()/onCycleEnd() hooks called by
 *   DecisionMakingService (additive, exception-isolated). Brackets attributed
 *   to originator when non-null; null-originator (self-ticks) are excluded.
 * - Baseline EWMA: updated only during idle (no open bracket); half-life 300
 *   ticks. Captures ambient drive drift so genuine hostile contribution can
 *   be isolated from background noise.
 * - Per-speaker rolling windows: last 20 closed brackets per speaker,
 *   bounded LRU across 32 speakers.
 * - Hysteresis FSM per speaker: INACTIVE -> PENDING -> ACTIVE, with 2-of-2
 *   consecutive evals to fire, 10-min re-alert cooldown, and deactivation at
 *   0.7 × threshold contrast or stale window.
 *
 * CANON alignment:
 * - Pure observer: zero write paths to Drive Engine or WKG.
 * - No per-person drive state: per-speaker stats about ONE global trajectory.
 * - Observability only: alert is logging/TimescaleDB event, no actuation.
 * - T3 protects ordinary sad-venting (Sadness-only never qualifies).
 * - Guardian: no exemption; severity capped at WARNING (honest and useful).
 */

import { Injectable, Logger, Optional, Inject, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { DriveName } from '@sylphie/shared';
import type { DriveSnapshot } from '@sylphie/shared';
import { DRIVE_STATE_READER, type IDriveStateReader } from '@sylphie/drive-engine';
import { DECISION_EVENT_LOGGER } from '../decision-making.tokens';
import type { IDecisionEventLogger } from '../interfaces/decision-making.interfaces';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** FSM states per speaker. */
type SpeakerFsmState = 'INACTIVE' | 'PENDING' | 'ACTIVE';

/** One closed bracket (one turn's contribution). */
interface BracketEntry {
  /** Adjusted per-turn dN (total minus baseline contribution). */
  readonly dNAdj: number;
  /** Per-drive positive-part deltas for the three negative-affect drives. */
  readonly perDrive: Readonly<Record<NegativeDrive, number>>;
  /** Wall-clock close time (used for staleness check). */
  readonly closedAt: number;
}

/** Per-speaker tracking state. */
interface SpeakerState {
  /** Last 20 closed brackets (rolling, newest last). */
  readonly window: BracketEntry[];
  /** FSM state for hysteresis. */
  fsmState: SpeakerFsmState;
  /** Consecutive evaluations above threshold (for PENDING->ACTIVE transition). */
  consecutiveAbove: number;
  /** Timestamp of the last alert emission (ms). */
  lastAlertAt: number;
  /** Whether the last alert was CRITICAL (for escalation bypass). */
  lastAlertWasCritical: boolean;
  /** LRU eviction timestamp: last time this speaker had a bracket closed. */
  lastActivityAt: number;
}

/** The three negative-affect drives tracked by this monitor. */
type NegativeDrive = DriveName.Anxiety | DriveName.Sadness | DriveName.Guilt;

// ---------------------------------------------------------------------------
// MoodBleedMonitorService
// ---------------------------------------------------------------------------

@Injectable()
export class MoodBleedMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MoodBleedMonitorService.name);

  // ── Constants (all calibration lives here — one-diff recalibration) ────────
  private readonly constants = {
    /** Number of drive-tick snapshots to wait after turn end before closing bracket. */
    SETTLE_TICKS: 2,

    /** EWMA half-life for baseline drift estimation (ticks ≈ seconds at 1 Hz). */
    BASELINE_HALF_LIFE_TICKS: 300,

    /** Maximum per-speaker rolling window size (turn brackets). */
    SPEAKER_WINDOW_TURNS: 20,

    /** Maximum number of concurrently tracked speakers (LRU eviction beyond this). */
    MAX_TRACKED_SPEAKERS: 32,

    /** Minimum window entries before T1 is satisfied. */
    MIN_TURNS_PER_SPEAKER: 10,

    /** T2: minimum μ_X − max(μ_others, 0) to satisfy contrast condition. */
    CONTRAST_THRESHOLD: 0.05,

    /** T3: per-drive mean delta must exceed this on ≥2 drives. */
    PER_DRIVE_EPSILON: 0.01,

    /** T4: any negative-affect drive must be ≥ this for the global gate. */
    GLOBAL_ELEVATION_WARNING: 0.40,

    /** Severity upgrade to CRITICAL at this drive level. */
    CRITICAL_THRESHOLD: 0.60,

    /** Number of consecutive evaluations above threshold before firing. */
    CONSECUTIVE_EVALS_TO_FIRE: 2,

    /** Minimum ms between re-alerts for the same speaker. */
    REALERT_COOLDOWN_MS: 600_000,   // 10 minutes

    /** Deactivation hysteresis factor (contrast must drop below threshold × factor). */
    DEACTIVATION_FACTOR: 0.7,

    /** Mark a speaker's window as stale if no bracket closed within this ms. */
    WINDOW_STALE_MS: 1_800_000,     // 30 minutes

    /** Minimum number of "other" speaker entries for μ_others to be non-zero. */
    MIN_OTHERS_ENTRIES: 5,
  } as const;

  // ── Negative-affect drive set ──────────────────────────────────────────────
  private readonly NEGATIVE_AFFECT_DRIVES: readonly NegativeDrive[] = [
    DriveName.Anxiety,
    DriveName.Sadness,
    DriveName.Guilt,
  ];

  // ── Baseline EWMA ─────────────────────────────────────────────────────────
  /** EWMA per-tick baseline change in N. Initialised to 0. */
  private baselinePerTick = 0;
  /** N value from the previous snapshot (used to compute per-tick dN). */
  private prevN: number | null = null;
  /** EWMA smoothing factor α = 1 − 2^(−1/half_life). Pre-computed. */
  private readonly ewmaAlpha: number;

  // ── Open bracket state ────────────────────────────────────────────────────
  /** Non-null when a turn cycle is open. */
  private openBracket: {
    speakerId: string | null;  // null = self-tick (excluded)
    isGuardian: boolean;
    preSnapshot: DriveSnapshot;
    endTick: number;           // tickNumber at cycle end
  } | null = null;

  /** Whether onCycleEnd() has been called (bracket end signalled). */
  private bracketEndSignalled = false;

  // ── Per-speaker ledgers (LRU map — insertion order = recency) ─────────────
  private readonly speakers = new Map<string, SpeakerState>();

  // ── Drive-state subscription ───────────────────────────────────────────────
  private driveSubscription: Subscription | null = null;

  // ── Injectable clock (override in tests) ──────────────────────────────────
  private nowFn: () => number = () => Date.now();

  constructor(
    @Inject(DRIVE_STATE_READER)
    private readonly driveStateReader: IDriveStateReader,

    @Optional() @Inject(DECISION_EVENT_LOGGER)
    private readonly eventLogger: IDecisionEventLogger | null,
  ) {
    // α = 1 − 2^(−1/H); for H=300, α ≈ 0.00231
    this.ewmaAlpha = 1 - Math.pow(2, -1 / this.constants.BASELINE_HALF_LIFE_TICKS);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  onModuleInit(): void {
    this.driveSubscription = this.driveStateReader.driveState$.subscribe(
      (snapshot) => {
        try {
          this.onSnapshot(snapshot);
        } catch (err) {
          this.logger.warn(`MoodBleedMonitor snapshot handler error: ${err}`);
        }
      },
    );
  }

  onModuleDestroy(): void {
    this.driveSubscription?.unsubscribe();
    this.driveSubscription = null;
  }

  // ---------------------------------------------------------------------------
  // Public hooks — called by DecisionMakingService (exception-isolated)
  // ---------------------------------------------------------------------------

  /**
   * Called at the start of each decision cycle (queue-admitted turn or self-tick).
   *
   * @param originator - The speaker identity; null for self-initiated ticks.
   * @param preSnapshot - Drive snapshot already fetched at cycle start.
   */
  onCycleStart(originator: { userId: string; socketId?: string; isGuardian: boolean } | null, preSnapshot: DriveSnapshot): void {
    // If a previous bracket is still open (shouldn't happen — cycles are serial
    // via CycleGuard — but be safe), truncate it: close without emitting a
    // null-originator exclusion and start fresh.
    if (this.openBracket !== null) {
      // Bracket truncated by next turn start — do NOT add to ledger (no dN
      // settled yet), but do update baseline if null-originator.
      this.openBracket = null;
      this.bracketEndSignalled = false;
    }

    const speakerId = originator?.userId ?? null;
    const isGuardian = originator?.isGuardian ?? false;

    this.openBracket = {
      speakerId,
      isGuardian,
      preSnapshot,
      endTick: -1,  // will be set by onCycleEnd()
    };
    this.bracketEndSignalled = false;
  }

  /**
   * Called at the end of each decision cycle (in the finally block).
   * Records the endTick so the snapshot handler can close the bracket
   * after SETTLE_TICKS.
   */
  onCycleEnd(): void {
    if (this.openBracket === null) return;
    const snapshot = this.driveStateReader.getCurrentState();
    this.openBracket.endTick = snapshot.tickNumber;
    this.bracketEndSignalled = true;
  }

  // ---------------------------------------------------------------------------
  // Injectable clock (for deterministic tests)
  // ---------------------------------------------------------------------------

  /** Override Date.now() in tests for deterministic hysteresis timing. */
  setClockFn(fn: () => number): void {
    this.nowFn = fn;
  }

  // ---------------------------------------------------------------------------
  // Read API
  // ---------------------------------------------------------------------------

  /**
   * Point-in-time status for each tracked speaker (read-only, for tests and
   * optional future metrics-controller exposure).
   */
  getStatus(): Array<{
    speakerId: string;
    windowEntries: number;
    fsmState: SpeakerFsmState;
    lastAlertAt: number;
  }> {
    const result: Array<{
      speakerId: string;
      windowEntries: number;
      fsmState: SpeakerFsmState;
      lastAlertAt: number;
    }> = [];

    for (const [speakerId, state] of this.speakers) {
      result.push({
        speakerId,
        windowEntries: state.window.length,
        fsmState: state.fsmState,
        lastAlertAt: state.lastAlertAt,
      });
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Snapshot handler (tick-driven)
  // ---------------------------------------------------------------------------

  private onSnapshot(snapshot: DriveSnapshot): void {
    // Hygiene: discard tick-0 default snapshot (pre-first-tick sentinel).
    if (snapshot.tickNumber === 0) {
      this.logger.debug('MoodBleedMonitor: discarding tick-0 snapshot (pre-first-tick default)');
      return;
    }

    // Hygiene: detect tick regression (engine restart between snapshots).
    if (this.prevN !== null && snapshot.tickNumber < this._lastTickNumber) {
      this.logger.debug(`MoodBleedMonitor: tick regression ${snapshot.tickNumber} < ${this._lastTickNumber}; discarding`);
      this._lastTickNumber = snapshot.tickNumber;
      this.prevN = null;
      return;
    }
    this._lastTickNumber = snapshot.tickNumber;

    const currentN = this.computeN(snapshot);

    // ── Try to close an open bracket ─────────────────────────────────────────
    if (
      this.openBracket !== null &&
      this.bracketEndSignalled &&
      this.openBracket.endTick >= 0 &&
      snapshot.tickNumber >= this.openBracket.endTick + this.constants.SETTLE_TICKS
    ) {
      this.closeBracket(snapshot, currentN);
    }

    // ── Baseline EWMA update (idle-only) ─────────────────────────────────────
    // Only update when there is no open bracket (idle ticks).
    if (this.openBracket === null && this.prevN !== null) {
      const tickDeltaN = currentN - this.prevN;
      this.baselinePerTick =
        this.ewmaAlpha * tickDeltaN + (1 - this.ewmaAlpha) * this.baselinePerTick;
    }

    this.prevN = currentN;
  }

  /** Last seen tickNumber (for regression detection). */
  private _lastTickNumber = -1;

  // ---------------------------------------------------------------------------
  // Bracket close
  // ---------------------------------------------------------------------------

  private closeBracket(postSnapshot: DriveSnapshot, postN: number): void {
    // Safe: we checked openBracket !== null before calling.
    const bracket = this.openBracket!;
    this.openBracket = null;
    this.bracketEndSignalled = false;

    // Hygiene: discard null-originator brackets (self-ticks).
    if (bracket.speakerId === null) {
      return;
    }

    // Hygiene: sessionId change mid-bracket means a Drive Engine restart.
    if (postSnapshot.sessionId !== bracket.preSnapshot.sessionId) {
      this.logger.debug('MoodBleedMonitor: sessionId changed mid-bracket; discarding');
      return;
    }

    const preN = this.computeN(bracket.preSnapshot);
    const bracketTicks = Math.max(
      1,
      postSnapshot.tickNumber - bracket.preSnapshot.tickNumber,
    );
    const rawDN = postN - preN;
    const dNAdj = rawDN - this.baselinePerTick * bracketTicks;

    // Per-drive positive-part deltas.
    const perDrive: Record<NegativeDrive, number> = {
      [DriveName.Anxiety]: 0,
      [DriveName.Sadness]: 0,
      [DriveName.Guilt]: 0,
    };
    for (const drive of this.NEGATIVE_AFFECT_DRIVES) {
      const pre = bracket.preSnapshot.pressureVector[drive];
      const post = postSnapshot.pressureVector[drive];
      perDrive[drive] = Math.max(0, post - pre);
    }

    // Hygiene: NaN guard (could arise from corrupt snapshot).
    if (isNaN(dNAdj) || isNaN(perDrive[DriveName.Anxiety]) || isNaN(perDrive[DriveName.Sadness]) || isNaN(perDrive[DriveName.Guilt])) {
      this.logger.debug('MoodBleedMonitor: NaN in bracket computation; discarding');
      return;
    }

    const entry: BracketEntry = {
      dNAdj,
      perDrive,
      closedAt: this.nowFn(),
    };

    this.addEntryToSpeaker(bracket.speakerId, entry, bracket.isGuardian, postSnapshot);
  }

  // ---------------------------------------------------------------------------
  // Speaker ledger management + evaluation
  // ---------------------------------------------------------------------------

  private addEntryToSpeaker(
    speakerId: string,
    entry: BracketEntry,
    isGuardian: boolean,
    snapshot: DriveSnapshot,
  ): void {
    // LRU: evict least-recently-active speaker if at capacity.
    if (!this.speakers.has(speakerId) && this.speakers.size >= this.constants.MAX_TRACKED_SPEAKERS) {
      this.evictLeastRecentSpeaker();
    }

    if (!this.speakers.has(speakerId)) {
      this.speakers.set(speakerId, {
        window: [],
        fsmState: 'INACTIVE',
        consecutiveAbove: 0,
        lastAlertAt: 0,
        lastAlertWasCritical: false,
        lastActivityAt: this.nowFn(),
      });
    }

    const state = this.speakers.get(speakerId)!;
    state.lastActivityAt = this.nowFn();
    state.window.push(entry);
    if (state.window.length > this.constants.SPEAKER_WINDOW_TURNS) {
      state.window.shift();
    }

    this.evaluateSpeaker(speakerId, state, isGuardian, snapshot);
  }

  private evictLeastRecentSpeaker(): void {
    let oldestId: string | null = null;
    let oldestTime = Infinity;
    for (const [id, st] of this.speakers) {
      if (st.lastActivityAt < oldestTime) {
        oldestTime = st.lastActivityAt;
        oldestId = id;
      }
    }
    if (oldestId !== null) {
      this.speakers.delete(oldestId);
    }
  }

  // ---------------------------------------------------------------------------
  // Trigger evaluation (T1–T4 + FSM)
  // ---------------------------------------------------------------------------

  private evaluateSpeaker(
    speakerId: string,
    state: SpeakerState,
    isGuardian: boolean,
    snapshot: DriveSnapshot,
  ): void {
    const now = this.nowFn();

    // ── Staleness check — deactivate if window is stale ──────────────────────
    const windowAge = state.window.length > 0
      ? now - state.window[state.window.length - 1].closedAt
      : Infinity;
    if (state.fsmState !== 'INACTIVE' && windowAge > this.constants.WINDOW_STALE_MS) {
      state.fsmState = 'INACTIVE';
      state.consecutiveAbove = 0;
      return;
    }

    // ── T1: floor ─────────────────────────────────────────────────────────────
    if (state.window.length < this.constants.MIN_TURNS_PER_SPEAKER) {
      // Below floor: reset consecutive counter but stay in FSM state
      state.consecutiveAbove = 0;
      return;
    }

    // ── Compute μ_X ──────────────────────────────────────────────────────────
    const muX = mean(state.window.map(e => e.dNAdj));

    // ── Compute μ_others ──────────────────────────────────────────────────────
    const muOthers = this.computeMuOthers(speakerId);

    // ── T2: conditional contrast ──────────────────────────────────────────────
    const contrast = muX - Math.max(muOthers, 0);
    const t2 = contrast >= this.constants.CONTRAST_THRESHOLD;

    // ── T3: multi-drive composition (Sadness-only NEVER qualifies) ───────────
    const perDriveMeans: Record<NegativeDrive, number> = {
      [DriveName.Anxiety]: mean(state.window.map(e => e.perDrive[DriveName.Anxiety])),
      [DriveName.Sadness]: mean(state.window.map(e => e.perDrive[DriveName.Sadness])),
      [DriveName.Guilt]: mean(state.window.map(e => e.perDrive[DriveName.Guilt])),
    };

    const drivesAboveEpsilon = this.NEGATIVE_AFFECT_DRIVES.filter(
      d => perDriveMeans[d] > this.constants.PER_DRIVE_EPSILON,
    );
    // Multi-drive: ≥2 drives above epsilon; Sadness-only (exactly 1 drive,
    // and that drive is Sadness) must not qualify.
    const sadnessOnly =
      drivesAboveEpsilon.length === 1 &&
      drivesAboveEpsilon[0] === DriveName.Sadness;
    const t3 = drivesAboveEpsilon.length >= 2 && !sadnessOnly;

    // ── T4: global degradation gate ───────────────────────────────────────────
    const maxNegativeDrive = Math.max(
      snapshot.pressureVector[DriveName.Anxiety],
      snapshot.pressureVector[DriveName.Sadness],
      snapshot.pressureVector[DriveName.Guilt],
    );
    const globalNegativeAffect = maxNegativeDrive;
    const t4 = maxNegativeDrive >= this.constants.GLOBAL_ELEVATION_WARNING;

    const allTriggered = t2 && t3 && t4;

    // ── Deactivation check (FSM ACTIVE) ──────────────────────────────────────
    if (state.fsmState === 'ACTIVE') {
      const deactivationThreshold = this.constants.CONTRAST_THRESHOLD * this.constants.DEACTIVATION_FACTOR;
      if (contrast < deactivationThreshold || windowAge > this.constants.WINDOW_STALE_MS) {
        state.fsmState = 'INACTIVE';
        state.consecutiveAbove = 0;
        return;
      }
    }

    // ── FSM transitions ───────────────────────────────────────────────────────
    if (!allTriggered) {
      // Below threshold: if PENDING, reset counter; if ACTIVE, handled above.
      if (state.fsmState === 'PENDING') {
        state.consecutiveAbove = 0;
        state.fsmState = 'INACTIVE';
      }
      return;
    }

    // All triggers satisfied.
    state.consecutiveAbove += 1;

    if (state.fsmState === 'INACTIVE') {
      state.fsmState = 'PENDING';
    }

    if (state.fsmState === 'PENDING' && state.consecutiveAbove >= this.constants.CONSECUTIVE_EVALS_TO_FIRE) {
      // Transition PENDING -> ACTIVE: emit exactly once.
      state.fsmState = 'ACTIVE';
      state.lastAlertAt = now;
      state.lastAlertWasCritical = maxNegativeDrive >= this.constants.CRITICAL_THRESHOLD;
      this.emitAlert(speakerId, isGuardian, contrast, perDriveMeans, globalNegativeAffect, muOthers, snapshot);
      return;
    }

    if (state.fsmState === 'ACTIVE') {
      // Re-emit under two conditions: cooldown elapsed, or WARNING->CRITICAL escalation.
      const isCritical = maxNegativeDrive >= this.constants.CRITICAL_THRESHOLD;
      const cooldownElapsed = now - state.lastAlertAt >= this.constants.REALERT_COOLDOWN_MS;
      const escalating = isCritical && !state.lastAlertWasCritical;

      if (cooldownElapsed || escalating) {
        state.lastAlertAt = now;
        state.lastAlertWasCritical = isCritical;
        this.emitAlert(speakerId, isGuardian, contrast, perDriveMeans, globalNegativeAffect, muOthers, snapshot);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // μ_others computation
  // ---------------------------------------------------------------------------

  private computeMuOthers(excludeSpeakerId: string): number {
    const allEntries: number[] = [];
    for (const [id, st] of this.speakers) {
      if (id === excludeSpeakerId) continue;
      for (const entry of st.window) {
        allEntries.push(entry.dNAdj);
      }
    }
    if (allEntries.length < this.constants.MIN_OTHERS_ENTRIES) return 0;
    return mean(allEntries);
  }

  // ---------------------------------------------------------------------------
  // Alert emission
  // ---------------------------------------------------------------------------

  private emitAlert(
    speakerId: string,
    isGuardian: boolean,
    contrast: number,
    perDriveMeans: Record<NegativeDrive, number>,
    globalNegativeAffect: number,
    muOthers: number,
    snapshot: DriveSnapshot,
  ): void {
    // Severity: CRITICAL at globalNegativeAffect ≥ 0.60; guardian capped at WARNING.
    const rawSeverity: 'WARNING' | 'CRITICAL' =
      globalNegativeAffect >= this.constants.CRITICAL_THRESHOLD ? 'CRITICAL' : 'WARNING';
    const severity: 'WARNING' | 'CRITICAL' = isGuardian ? 'WARNING' : rawSeverity;

    this.logger.warn(
      `[HOSTILE_INTERLOCUTOR_MOOD_BLEED] speaker=${speakerId} severity=${severity} ` +
      `contrast=${contrast.toFixed(4)} threshold=${this.constants.CONTRAST_THRESHOLD} ` +
      `global=${globalNegativeAffect.toFixed(4)} guardian=${isGuardian}`,
    );

    if (this.eventLogger) {
      this.eventLogger.log(
        'ATTRACTOR_STATE_ALERT',
        {
          attractorName: 'HOSTILE_INTERLOCUTOR_MOOD_BLEED',
          metric: contrast,
          threshold: this.constants.CONTRAST_THRESHOLD,
          severity,
          speakerId,
          speakerIsGuardian: isGuardian,
          turnCount: this.speakers.get(speakerId)?.window.length ?? 0,
          perDriveMeans: {
            [DriveName.Anxiety]: perDriveMeans[DriveName.Anxiety],
            [DriveName.Sadness]: perDriveMeans[DriveName.Sadness],
            [DriveName.Guilt]: perDriveMeans[DriveName.Guilt],
          },
          globalNegativeAffect,
          muOthers,
          baselinePerTick: this.baselinePerTick,
          detectedAt: new Date().toISOString(),
        },
        snapshot,
        snapshot.sessionId,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // N(v) — scalar negative-affect index
  // ---------------------------------------------------------------------------

  private computeN(snapshot: DriveSnapshot): number {
    let total = 0;
    for (const drive of this.NEGATIVE_AFFECT_DRIVES) {
      const val = snapshot.pressureVector[drive];
      if (val > 0) total += val;
    }
    return total;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
