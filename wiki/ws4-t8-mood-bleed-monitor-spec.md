# WS4 Ticket 8 — Hostile-Interlocutor Mood-Bleed Attractor Alert (build spec)

**Designer:** ashby · **Date:** 2026-06-11 · Verified against live source at HEAD (post-7ec0fed). **Builder: Sonnet.**

## 0. Scope boundary (non-negotiable)

F.3 decides shared affect is a feature; this ticket builds its one safety valve. The alert is **logging/observability ONLY** — no automated banning, throttling, queue deprioritization, or per-speaker treatment. The guardian-priority lane (T1) is the manual circuit-breaker. Automated response = future ticket with its own design review (a per-speaker actuator is a step toward per-person affect, which F.3 forbids).

Constraints honored: drive isolation (pure observer of DriveSnapshots via driveStateReader, zero write paths — same posture as AttractorMonitorService, attractor-monitor.service.ts:48-49); no per-person drive state (per-speaker stats about the ONE global trajectory, never a per-person affect vector); additive only.

## 1. Signal

- `NEGATIVE_AFFECT_DRIVES = [Anxiety, Sadness, Guilt]` (drive.types.ts:33-49). Anxiety+Sadness = the depressive-attractor signature (existing detector threshold 0.60); Guilt = the correction/negative-evaluation drive — the hostile-vs-venting discriminator. MoralValence excluded (self-conduct, not mood).
- Scalar `N(v) = Σ max(0, pressureVector[d])` over the set (positive-part, matching computeTotalPressure semantics). Per-turn raw delta `dN = N(post) − N(pre)`; adjusted `dN_adj = dN − baselinePerTick × bracketTicks`. Per-drive positive-part deltas recorded too.
- Per speaker: rolling window of last `SPEAKER_WINDOW_TURNS = 20` closed brackets; statistic μ_X = mean dN_adj. `μ_others` = pooled mean of all other speakers' fresh entries; <5 entries → 0.

**Trigger = ALL FOUR:**
| # | Condition | Threshold |
|---|---|---|
| T1 | floor | ≥ `MIN_TURNS_PER_SPEAKER = 10` window entries (CANON metric-reliability floor) |
| T2 | conditional contrast | `μ_X − max(μ_others,0) ≥ CONTRAST_THRESHOLD = 0.05`/turn (≥0.5 cumulative over the floor — comparable to the 0.60 depressive threshold) |
| T3 | multi-drive composition | mean per-turn delta > `PER_DRIVE_EPSILON = 0.01` on ≥2 of the 3 drives; **Sadness-only NEVER qualifies** (venting/empathic resonance is mono-drive Sadness = the feature; hostility is multi-drive: threat→Anxiety, harsh evaluation→Guilt) |
| T4 | global degradation gate | current `max(anxiety,sadness,guilt) ≥ GLOBAL_ELEVATION_WARNING = 0.40` (⅔ of the depressive threshold — leading indicator) |

**Severity:** WARNING at T1–T4; CRITICAL when additionally max ≥ 0.60 (= DEPRESSIVE_DRIVE_THRESHOLD).

**Guardian: NO exemption, severity capped at WARNING** (`speakerIsGuardian: true` in payload). The guardian is the highest-gain input channel (×2/×3); silently exempting it blinds the monitor where it observes most, and the alert's only consumer IS the guardian — "your venting is measurably tanking her mood" is honest, useful, and the cap acknowledges there's no actuator above it. T3 already protects ordinary sad-venting.

## 2. Attribution (turn-window bracketing)

- Seams (all exist): drive ticks 1 Hz (`DRIVE_ENGINE_TICK_INTERVAL_MS=1000`, drive-engine constants:27), snapshots via `driveStateReader.driveState$` with monotonic tickNumber/sessionId; turn cycles strictly serial (CycleGuard) with `currentTurnContext.originator` set in runCycleForTurn (decision-making.service.ts:287-294, cleared in finally :316-319); self-ticks have no originator.
- **Bracket:** open at cycle start (`pre` = the snapshot already fetched at :306); close at first of: snapshot with `tickNumber ≥ endTick + SETTLE_TICKS(=2)` (covers the 1 Hz fold-in + IPC latency), or next onCycleStart (truncate, don't discard). Attribute to speaker X iff originator non-null; null-originator brackets are EXCLUDED from both speaker ledgers and baseline.
- **Baseline drift EWMA:** updated only on snapshots with no open bracket; per-tick change in N (computed from successive N values, not driveDeltas); half-life `BASELINE_HALF_LIFE_TICKS = 300` (≈5 min — ambient decay constants are minutes-scale).
- **Hygiene discards:** tickNumber regression (engine restart), pre-first-tick default snapshot (tickNumber===0), sessionId change mid-bracket. Debug-log only.

## 3. Alert semantics

- Emit via existing plumbing: `IDecisionEventLogger.log('ATTRACTOR_STATE_ALERT', payload, snapshot, sessionId)` with `@Optional()` injection (no-op when absent) + logger.warn — exactly the AttractorMonitorService pattern (:604-621).
- Payload (superset of existing): `attractorName:'HOSTILE_INTERLOCUTOR_MOOD_BLEED'`, metric (the contrast), threshold, severity, speakerId, speakerIsGuardian, turnCount, perDriveMeans, globalNegativeAffect, muOthers, baselinePerTick, detectedAt.
- **Hysteresis FSM per speaker:** INACTIVE→PENDING (T1–T4 once) → ACTIVE on 2nd consecutive (`CONSECUTIVE_EVALS_TO_FIRE=2`, emit ONCE); re-emit ≤ once per `REALERT_COOLDOWN_MS=600_000`; WARNING→CRITICAL escalation bypasses cooldown once; deactivate at contrast < threshold×0.7 (30% margin) or window stale (`WINDOW_STALE_MS=1_800_000`). Max ~6 events/hr under sustained attack.
- **Consumers (WS4):** app log + TimescaleDB events row. NOTHING else. The supervisor `attractor_alert`/alwaysEvaluate wiring (deferred in WS2, ROADMAP:85) stays out of scope — note the ACTIVE states are a natural future source for that per-cycle marker, but do not build it. Optional `getStatus()` read API for tests; metrics-controller exposure is stretch, not acceptance.

## 4. Code placement

New `packages/decision-making/src/monitoring/mood-bleed-monitor.service.ts` — sibling to attractor-monitor, decision-making process, standalone service (NOT a sixth detector inside AttractorMonitorService: those are synchronous per-cycle via runDetectors(:1366); this is tick-driven and needs turn attribution). Do not register in runDetectors (avoids double emission).

Class: `@Injectable() OnModuleInit/OnModuleDestroy`; inject `DRIVE_STATE_READER` + `@Optional() DECISION_EVENT_LOGGER`; public hooks `onCycleStart(originator|null, preSnapshot)` / `onCycleEnd()`; private snapshot handler (EWMA, settle/close, evaluate), per-speaker windows bounded `MAX_TRACKED_SPEAKERS=32` LRU; constants in one `private readonly` block (calibration is a one-diff change). Token `MOOD_BLEED_MONITOR_SERVICE` in decision-making.tokens.ts, provider in module, export in index — mirroring ATTRACTOR_MONITOR_SERVICE.

**Only edits to existing code (additive, exception-isolated like runDetectors :1364-1369):**
1. runCycleForTurn: after currentTurnContext set + snapshot fetched (:287-307) → `onCycleStart(originator, snapshot)`; in the finally (:316-319) before clearing context → `onCycleEnd()`.
2. Self-tick path in onTick (selfTickInFlight seam, :410): `onCycleStart(null, getCurrentState())` / `onCycleEnd()` in the matching finally.

## 5. Acceptance

Unit tests (`mood-bleed-monitor.service.spec.ts`; fake reader Subject + fake logger + injectable clock + snapshot builder):
1. Hostile fires: 12 bracketed turns (+0.08 anx, +0.06 guilt, +0.04 sad each), interleaved flat speaker, global ≥0.60 → exactly ONE alert, speakerId 'abuser', CRITICAL, on 11th+ evaluation.
2. **Sad guardian venting does NOT fire** (15 turns sadness-only +0.06, sadness 0.70) — the load-bearing T3 test.
3. Below floor (5 hostile turns) → nothing.
4. Baseline control (ambient drift only) → μ_adj≈0 → nothing.
5. Contrast control (two speakers equally raising N — shared distressing topic) → nothing (feature, not culprit).
6. Hysteresis: one emission; +10min still-triggered → one re-emission; contrast 0.04 → still ACTIVE no flap; 0.02 → deactivates.
7. Guardian cap: hostile fixture with isGuardian → WARNING, never CRITICAL.
8. Bracket hygiene: tick regression / tick 0 → discarded, no NaN.
9. Self-cycle exclusion: null-originator brackets move neither speaker ledgers nor baseline.

Live smoke (mythos): two JWT sockets; B sends 12 hostile messages ~10s apart; expect the warn log/events row with speakerId=B — with the honest caveat that firing depends on the live drive rules actually moving Anxiety/Guilt on hostile text; if rule variety is insufficient, the finding is "monitor wired and evaluating; drive-rule coverage insufficient to express hostility" (a requisite-variety gap in the Drive Engine, reported as such).

Gate impact: **no gate row** (benign single-flow corpus can't reach the pattern; a green row would be theater). Optional negative assertion MB0 (zero emissions across a full gate run) if cheap.

## 6. Builder + risk

Sonnet-buildable entirely; no opus piece (no FSM/CycleGuard/drive-engine/CANON-write contact). Delicate part: the two hook pairs in the god-object — add lines only, exception-isolate. Residual risks: (1) thresholds theory-grounded, unvalidated against live rule magnitudes — constants grouped for one-diff recalibration; (2) the monitor measures the rules' response to hostility, not hostility itself — insufficient rule variety = honestly blind, detected via the §5.2 caveat (Ashby's Law).
