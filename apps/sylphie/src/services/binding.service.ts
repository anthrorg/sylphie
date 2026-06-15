import { Injectable, Logger, Optional } from '@nestjs/common';

/**
 * BindingService — P1 #1: the A.5 multi-signal persistence scorer, ported from
 * the dormant Python reference (`persistence_check_service.py`) into a stateless
 * NestJS service keyed on `SceneEntity.id`.
 *
 * It replaces VWM's single-signal cosine LIMIT-1 re-identification with a
 * weighted multi-signal score (embedding / spatial / color / size / label),
 * Piaget dynamic weights that shift by confirmation count, an ambiguity band,
 * and a Piaget-R2 surprise flag.
 *
 * ── atlas ratification (2026-06-14), the load-bearing corrections ────────────
 *  1. **Sentinel-for-no-data renormalization (make-or-break).** The Python
 *     scorers return 0.0 for *both* "no data" and "real dissimilarity". Porting
 *     that literally craters day-one re-ID: with only embedding+label having
 *     data (Timescale stores no bbox/colors/size until P3), a PERFECT match
 *     scores embedding*0.45 + label*0.05 = 0.50 — below the 0.75 threshold, a
 *     regression below today's single-signal cosine. Fix: a scorer returns
 *     `null` when it has NO DATA (drop from the renorm denominator), distinct
 *     from a real 0.0. The weighted score renormalizes over only the AVAILABLE
 *     signals. Day-one this collapses to renorm(embedding, label) → a perfect
 *     known match = 1.0, embedding-only = 0.90, i.e. ≥ today's baseline, never
 *     weaker. The full `_NEW`/`_KNOWN` profiles are shipped verbatim, so when P3
 *     adds the bbox/color columns the dropped signals re-engage automatically —
 *     P3 is a DATA change, not a code change.
 *  2. **OPEN-9 is net-new here, not a port.** The Python has no renorm (its
 *     OPEN-9 test is a strict xfail) and `recency_window_hours` was dead config.
 *     A cross-session candidate (last seen > recency window ago) has no reliable
 *     in-frame location, so its box-derived signals (spatial, size) are dropped
 *     and the remainder renormalized — the same mechanic as (1). atlas ruling:
 *     drop BOTH spatial and size (both box-derived), giving a clean 1.0 for a
 *     perfect cross-session embedding+color+label match (vs the plan's stale
 *     drop-spatial-only ≈0.88 figure). Day-one this is moot (no box data at all);
 *     it becomes load-bearing at P3.
 *  3. **Person stays on the FaceSnapshot path** — this service scores OBJECTS
 *     only. The caller invokes it only for `entity.label !== 'person'`.
 *  4. **surprise_flag is PRESSURE-only** and maps `confirmation_count →
 *     sighting_count`. This service only COMPUTES it; the VWM caller LOGS it and
 *     does NOT forward it to any drive event — its consumer is Fork C (P4).
 *     Emitting to a non-existent consumer now would violate the theater gate.
 *
 * The service is PURE/STATELESS: the caller fetches candidate rows and passes
 * them in; no DB or graph access lives here (so no isolation/provenance hazard —
 * atlas §5).
 */

// ---------------------------------------------------------------------------
// Weight profiles (ported VERBATIM from persistence_check_service.py:84-102)
// ---------------------------------------------------------------------------

export type SignalKey = 'embedding' | 'spatial' | 'color' | 'size' | 'label_raw';

export const NEW_WEIGHTS: Readonly<Record<SignalKey, number>> = {
  spatial: 0.5,
  embedding: 0.25,
  color: 0.15,
  size: 0.05,
  label_raw: 0.05,
};

export const KNOWN_WEIGHTS: Readonly<Record<SignalKey, number>> = {
  embedding: 0.45,
  color: 0.25,
  spatial: 0.15,
  size: 0.1,
  label_raw: 0.05,
};

/** Confirmation-count thresholds defining the weight-profile transition. */
export const NEW_THRESHOLD = 5;
export const KNOWN_THRESHOLD = 10;

/** Thresholds — ported from PersistenceCheckConfig defaults (config.py:218-252). */
export interface BindingConfig {
  /** Score ≥ this declares a definitive match. */
  matchThreshold: number;
  /** Score in [ambiguity, match) is ambiguous (guardian-disambiguable). */
  ambiguityThreshold: number;
  /** A well-known object with embedding distance > this raises surprise. */
  surpriseThreshold: number;
  /** Candidates last seen longer ago than this are "cross-session" (OPEN-9). */
  recencyWindowHours: number;
}

export const DEFAULT_BINDING_CONFIG: BindingConfig = {
  matchThreshold: 0.75,
  ambiguityThreshold: 0.45,
  surpriseThreshold: 0.3,
  recencyWindowHours: 24.0,
};

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Axis-aligned box as [xMin, yMin, xMax, yMax] (VWM's TrackedObjectDTO.bbox). */
export type Bbox = [number, number, number, number];

/** A perception observation to re-identify (the current confirmed sighting). */
export interface BindingObservation {
  embedding: number[] | null;
  bbox?: Bbox | null;
  dominantColors?: Array<[number, number, number]> | null;
  labelRaw?: string | null;
}

/** A stored candidate node fetched by the caller (e.g. visual_object_embeddings row). */
export interface BindingCandidate {
  nodeId: string;
  embedding: number[] | null;
  bbox?: Bbox | null;
  dominantColors?: Array<[number, number, number]> | null;
  labelRaw?: string | null;
  /** sighting_count (maps to A.5 confirmation_count). */
  confirmationCount: number;
  /** epoch ms of last sighting; used for the OPEN-9 cross-session predicate. */
  lastSeenAtMs?: number | null;
}

export interface BindingResult {
  matchedNodeId: string | null;
  confidence: number;
  matchType: 'embedding' | 'none';
  surpriseFlag: boolean;
  ambiguousCandidates: string[];
}

// ---------------------------------------------------------------------------
// Weight interpolation (ported from _interpolate_weights:110-153)
// ---------------------------------------------------------------------------

export function interpolateWeights(
  confirmationCount: number,
): Record<SignalKey, number> {
  if (confirmationCount < NEW_THRESHOLD) return { ...NEW_WEIGHTS };
  if (confirmationCount >= KNOWN_THRESHOLD) return { ...KNOWN_WEIGHTS };
  const t =
    (confirmationCount - NEW_THRESHOLD) / (KNOWN_THRESHOLD - NEW_THRESHOLD);
  const out = {} as Record<SignalKey, number>;
  (Object.keys(NEW_WEIGHTS) as SignalKey[]).forEach((k) => {
    out[k] = NEW_WEIGHTS[k] * (1 - t) + KNOWN_WEIGHTS[k] * t;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Individual scorers — each returns a number when it HAS DATA, or `null` when
// the signal is unavailable (atlas correction #1: null ≠ a real 0.0).
// ---------------------------------------------------------------------------

/** Cosine similarity in [0,1]; `null` if either embedding is absent/empty/degenerate. */
export function scoreEmbedding(
  a: number[] | null | undefined,
  b: number[] | null | undefined,
): number | null {
  if (!a || !b || a.length === 0 || b.length === 0) return null;
  if (a.length !== b.length) return null;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  magA = Math.sqrt(magA);
  magB = Math.sqrt(magB);
  if (magA === 0 || magB === 0) return null;
  return Math.max(0, Math.min(1, dot / (magA * magB)));
}

/** IoU in [0,1]; `null` if either box is absent. */
export function scoreSpatial(
  obs: Bbox | null | undefined,
  node: Bbox | null | undefined,
): number | null {
  if (!obs || !node) return null;
  const xL = Math.max(obs[0], node[0]);
  const yT = Math.max(obs[1], node[1]);
  const xR = Math.min(obs[2], node[2]);
  const yB = Math.min(obs[3], node[3]);
  const iw = xR - xL;
  const ih = yB - yT;
  if (iw <= 0 || ih <= 0) return 0;
  const inter = iw * ih;
  const obsArea = (obs[2] - obs[0]) * (obs[3] - obs[1]);
  const nodeArea = (node[2] - node[0]) * (node[3] - node[1]);
  const union = obsArea + nodeArea - inter;
  if (union <= 0) return 0;
  return Math.max(0, Math.min(1, inter / union));
}

/** Coarse 4×4×4-bin Jaccard color similarity; `null` if either list is absent/empty. */
export function scoreColor(
  obs: Array<[number, number, number]> | null | undefined,
  node: Array<[number, number, number]> | null | undefined,
): number | null {
  if (!obs || !node || obs.length === 0 || node.length === 0) return null;
  const bin = (c: [number, number, number]): string =>
    `${Math.floor(c[0] / 64)},${Math.floor(c[1] / 64)},${Math.floor(c[2] / 64)}`;
  const obsBins = new Set(obs.map(bin));
  const nodeBins = new Set(node.map(bin));
  let shared = 0;
  obsBins.forEach((b) => {
    if (nodeBins.has(b)) shared += 1;
  });
  const union = new Set([...obsBins, ...nodeBins]).size;
  return union > 0 ? shared / union : 0;
}

/** Area ratio min/max in [0,1]; `null` if either box is absent or zero-area. */
export function scoreSize(
  obs: Bbox | null | undefined,
  node: Bbox | null | undefined,
): number | null {
  if (!obs || !node) return null;
  const obsArea = (obs[2] - obs[0]) * (obs[3] - obs[1]);
  const nodeArea = (node[2] - node[0]) * (node[3] - node[1]);
  if (obsArea <= 0 || nodeArea <= 0) return null;
  return Math.min(obsArea, nodeArea) / Math.max(obsArea, nodeArea);
}

/** Soft label bonus: 1.0 exact match / 0.0 mismatch; `null` if either label absent. */
export function scoreLabelRaw(
  obs: string | null | undefined,
  node: string | null | undefined,
): number | null {
  if (!obs || !node) return null;
  return obs === node ? 1.0 : 0.0;
}

// ---------------------------------------------------------------------------
// Multi-modal scoring — renormalized over AVAILABLE signals (atlas #1/#2)
// ---------------------------------------------------------------------------

/**
 * Weighted multi-signal match score in [0,1], renormalized over the signals
 * that actually have data. A scorer returning `null` (no data) is dropped from
 * the denominator — so structural absences (day-one: spatial/color/size) and
 * OPEN-9 cross-session drops never silently drag a genuine match below
 * threshold.
 *
 * @param opts.crossSession when true, force-drop the box-derived signals
 *   (spatial, size) per OPEN-9 — a cross-session candidate has no reliable
 *   in-frame location even if a stored box exists (P3).
 */
export function computeMatchScore(
  observation: BindingObservation,
  candidate: BindingCandidate,
  confirmationCount: number,
  opts: { crossSession?: boolean } = {},
): number {
  const weights = interpolateWeights(confirmationCount);

  const scores: Record<SignalKey, number | null> = {
    embedding: scoreEmbedding(observation.embedding, candidate.embedding),
    spatial: scoreSpatial(observation.bbox, candidate.bbox),
    color: scoreColor(observation.dominantColors, candidate.dominantColors),
    size: scoreSize(observation.bbox, candidate.bbox),
    label_raw: scoreLabelRaw(observation.labelRaw, candidate.labelRaw),
  };

  // Embedding is the ANCHOR identity signal. If we cannot compare embeddings
  // (missing/degenerate/dim-mismatch on either side), this candidate is not a
  // visual match — never let a non-visual signal (e.g. a label that happens to
  // agree) renormalize up into a false merge. The retrieval already requires a
  // stored embedding, so this only fires on a corrupt/degenerate vector.
  if (scores.embedding === null) return 0;

  if (opts.crossSession) {
    // OPEN-9: box-derived signals are meaningless across sessions → drop both.
    scores.spatial = null;
    scores.size = null;
  }

  let weighted = 0;
  let denom = 0;
  (Object.keys(scores) as SignalKey[]).forEach((k) => {
    const s = scores[k];
    if (s !== null) {
      weighted += weights[k] * s;
      denom += weights[k];
    }
  });

  // No signal had data → no basis for a match.
  return denom > 0 ? weighted / denom : 0;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class BindingService {
  private readonly logger = new Logger(BindingService.name);
  private readonly config: BindingConfig;

  // @Optional so NestJS DI (which can't resolve the interface token) injects
  // undefined and we fall back to the default; tests pass an explicit config.
  constructor(@Optional() config?: BindingConfig) {
    this.config = config ?? DEFAULT_BINDING_CONFIG;
  }

  /**
   * Score candidates against an observation, sort, and classify (mirrors the
   * Python PersistenceCheckService.find_match). Pure: the caller supplies the
   * candidate rows (no DB access here).
   *
   * @param nowMs current time in epoch ms, used only for the OPEN-9
   *   cross-session predicate (pass Date.now() from the caller so this stays
   *   testable/deterministic).
   */
  findMatch(
    observation: BindingObservation,
    candidates: BindingCandidate[],
    nowMs: number,
  ): BindingResult {
    if (!observation.embedding || candidates.length === 0) {
      return {
        matchedNodeId: null,
        confidence: 0,
        matchType: 'none',
        surpriseFlag: false,
        ambiguousCandidates: [],
      };
    }

    const windowMs = this.config.recencyWindowHours * 3600 * 1000;
    const scored = candidates.map((c) => {
      const crossSession =
        typeof c.lastSeenAtMs === 'number' && nowMs - c.lastSeenAtMs > windowMs;
      const score = computeMatchScore(observation, c, c.confirmationCount, {
        crossSession,
      });
      return { candidate: c, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];

    // Ambiguous = the rest scoring in [ambiguity, match).
    const ambiguousRest = scored
      .slice(1)
      .filter(
        (s) =>
          s.score >= this.config.ambiguityThreshold &&
          s.score < this.config.matchThreshold,
      )
      .map((s) => s.candidate.nodeId);

    // Surprise (Piaget R2): a well-known object produced an unexpected embedding.
    let surpriseFlag = false;
    if (best.candidate.confirmationCount >= 5) {
      const sim = scoreEmbedding(observation.embedding, best.candidate.embedding);
      if (sim !== null && 1.0 - sim > this.config.surpriseThreshold) {
        surpriseFlag = true;
      }
    }

    if (best.score >= this.config.matchThreshold) {
      return {
        matchedNodeId: best.candidate.nodeId,
        confidence: best.score,
        matchType: 'embedding',
        surpriseFlag,
        ambiguousCandidates: ambiguousRest,
      };
    }

    if (best.score >= this.config.ambiguityThreshold) {
      // Best is ambiguous, not a confident match → guardian-disambiguable.
      return {
        matchedNodeId: null,
        confidence: best.score,
        matchType: 'none',
        surpriseFlag,
        ambiguousCandidates: [best.candidate.nodeId, ...ambiguousRest],
      };
    }

    return {
      matchedNodeId: null,
      confidence: best.score,
      matchType: 'none',
      surpriseFlag: false,
      ambiguousCandidates: [],
    };
  }
}
