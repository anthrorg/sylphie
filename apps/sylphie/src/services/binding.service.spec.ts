/**
 * P1 #1 — BindingService (A.5 multi-signal scorer port).
 *
 * Mirrors the Python goldens (test_persistence_scorer.py) and pins atlas's two
 * load-bearing corrections:
 *   • day-one renorm-over-available-signals prevents the 0.50 crater (a PERFECT
 *     known match with only embedding+label available scores 1.0, not 0.50);
 *   • OPEN-9 cross-session drops the box-derived signals (spatial+size) and
 *     renormalizes (drop-both → 1.0, superseding the plan's stale ≈0.88
 *     drop-spatial-only figure).
 */

import {
  BindingService,
  DEFAULT_BINDING_CONFIG,
  computeMatchScore,
  interpolateWeights,
  scoreColor,
  scoreEmbedding,
  scoreLabelRaw,
  scoreSize,
  scoreSpatial,
  NEW_WEIGHTS,
  KNOWN_WEIGHTS,
  type BindingCandidate,
  type BindingObservation,
} from './binding.service';

// ---------------------------------------------------------------------------
// Individual scorers — number when data present, null when absent
// ---------------------------------------------------------------------------

describe('scoreEmbedding', () => {
  it('identical → 1.0, orthogonal → 0.0', () => {
    expect(scoreEmbedding([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0, 10);
    expect(scoreEmbedding([1, 0], [0, 1])).toBeCloseTo(0.0, 10);
  });
  it('returns null (no data) on absent/empty/length-mismatch/degenerate', () => {
    expect(scoreEmbedding(null, [1, 2])).toBeNull();
    expect(scoreEmbedding([1, 2], null)).toBeNull();
    expect(scoreEmbedding([], [1, 2])).toBeNull();
    expect(scoreEmbedding([1, 2, 3], [1, 2])).toBeNull(); // length mismatch
    expect(scoreEmbedding([0, 0, 0], [1, 2, 3])).toBeNull(); // zero magnitude
  });
});

describe('scoreSpatial (IoU)', () => {
  it('identical box → 1.0, disjoint → 0', () => {
    expect(scoreSpatial([0, 0, 10, 10], [0, 0, 10, 10])).toBeCloseTo(1.0, 10);
    expect(scoreSpatial([0, 0, 10, 10], [100, 100, 110, 110])).toBe(0);
  });
  it('null when either box absent', () => {
    expect(scoreSpatial(null, [0, 0, 1, 1])).toBeNull();
    expect(scoreSpatial([0, 0, 1, 1], undefined)).toBeNull();
  });
});

describe('scoreColor (Jaccard over 4×4×4 bins)', () => {
  it('identical → 1.0, disjoint → 0', () => {
    expect(scoreColor([[200, 50, 50]], [[200, 50, 50]])).toBeCloseTo(1.0, 10);
    expect(scoreColor([[200, 50, 50]], [[10, 200, 10]])).toBe(0);
  });
  it('null when either list absent/empty', () => {
    expect(scoreColor(null, [[1, 1, 1]])).toBeNull();
    expect(scoreColor([], [[1, 1, 1]])).toBeNull();
  });
});

describe('scoreSize', () => {
  it('same size → 1.0, half-area → 0.5', () => {
    expect(scoreSize([0, 0, 10, 10], [0, 0, 10, 10])).toBeCloseTo(1.0, 10);
    // areas 100 vs 50 → 0.5
    expect(scoreSize([0, 0, 10, 10], [0, 0, 10, 5])).toBeCloseTo(0.5, 10);
  });
  it('null when either box absent', () => {
    expect(scoreSize(null, [0, 0, 1, 1])).toBeNull();
  });
});

describe('scoreLabelRaw', () => {
  it('match → 1.0, mismatch → 0.0, absent → null', () => {
    expect(scoreLabelRaw('cup', 'cup')).toBe(1.0);
    expect(scoreLabelRaw('cup', 'mug')).toBe(0.0);
    expect(scoreLabelRaw(null, 'cup')).toBeNull();
    expect(scoreLabelRaw('cup', undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Weight interpolation (ported verbatim)
// ---------------------------------------------------------------------------

describe('interpolateWeights', () => {
  it('new (count<5) is spatial-dominant; known (count>=10) is embedding-dominant', () => {
    expect(interpolateWeights(0).spatial).toBeCloseTo(0.5, 10);
    expect(interpolateWeights(4).spatial).toBeCloseTo(0.5, 10);
    expect(interpolateWeights(10).embedding).toBeCloseTo(0.45, 10);
    expect(interpolateWeights(50).embedding).toBeCloseTo(0.45, 10);
  });
  it('interpolated profile (5<=count<10) sums to 1.0 and lies between', () => {
    const w = interpolateWeights(7);
    const sum = (Object.values(w) as number[]).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
    // t = (7-5)/5 = 0.4
    expect(w.spatial).toBeCloseTo(NEW_WEIGHTS.spatial * 0.6 + KNOWN_WEIGHTS.spatial * 0.4, 10);
  });
});

// ---------------------------------------------------------------------------
// computeMatchScore — the day-one renorm crater-avoidance (atlas #1)
// ---------------------------------------------------------------------------

describe('computeMatchScore — day-one (only embedding+label available)', () => {
  const E = [1, 0, 0, 0];
  const obs: BindingObservation = { embedding: E, labelRaw: 'cup' };

  it('PERFECT known match renormalizes to 1.0, NOT the un-renormalized 0.50', () => {
    const cand: BindingCandidate = {
      nodeId: 'n', embedding: E, labelRaw: 'cup', confirmationCount: 10,
    };
    // Without renorm: emb 0.45 + label 0.05 = 0.50 (the crater, below 0.75).
    // With renorm over {embedding,label}: 0.50/0.50 = 1.0.
    expect(computeMatchScore(obs, cand, 10)).toBeCloseTo(1.0, 10);
  });

  it('embedding-perfect but label-mismatch known match → 0.90 (still > 0.75)', () => {
    const cand: BindingCandidate = {
      nodeId: 'n', embedding: E, labelRaw: 'mug', confirmationCount: 10,
    };
    // renorm: 0.45*1 + 0.05*0 over denom 0.50 = 0.90
    expect(computeMatchScore(obs, cand, 10)).toBeCloseTo(0.9, 10);
  });

  it('new object (count 0) perfect emb+label still renorms to 1.0', () => {
    const cand: BindingCandidate = {
      nodeId: 'n', embedding: E, labelRaw: 'cup', confirmationCount: 0,
    };
    // renorm over NEW {embedding 0.25, label 0.05} → 0.30/0.30 = 1.0
    expect(computeMatchScore(obs, cand, 0)).toBeCloseTo(1.0, 10);
  });

  it('no signal with data → 0 (cannot match)', () => {
    const cand: BindingCandidate = { nodeId: 'n', embedding: null, confirmationCount: 10 };
    expect(computeMatchScore({ embedding: null }, cand, 10)).toBe(0);
  });

  it('embedding is the anchor: a candidate with no comparable embedding never matches on label alone', () => {
    // label agrees, but the candidate embedding is absent → no visual identity.
    const cand: BindingCandidate = {
      nodeId: 'n', embedding: null, labelRaw: 'cup', confirmationCount: 10,
    };
    expect(computeMatchScore(obs, cand, 10)).toBe(0);
  });

  it('orthogonal embedding with matching label is NOT a false merge', () => {
    const cand: BindingCandidate = {
      nodeId: 'n', embedding: [0, 1, 0, 0], labelRaw: 'cup', confirmationCount: 10,
    };
    // embedding cos 0 → renorm(0*0.45, label 1*0.05)/0.50 = 0.10, far below 0.75
    expect(computeMatchScore(obs, cand, 10)).toBeCloseTo(0.1, 10);
  });
});

// ---------------------------------------------------------------------------
// computeMatchScore — OPEN-9 cross-session drop+renorm (atlas #2)
// ---------------------------------------------------------------------------

describe('computeMatchScore — OPEN-9 cross-session (full props, as-if-P3)', () => {
  const E = [1, 0, 0, 0];
  // Observation and candidate share identity (emb/color/label) but the stored
  // box is in a DIFFERENT location (non-overlapping) — a cross-session sighting.
  const obs: BindingObservation = {
    embedding: E, bbox: [0, 0, 10, 10], dominantColors: [[200, 50, 50]], labelRaw: 'cup',
  };
  const cand: BindingCandidate = {
    nodeId: 'n', embedding: E, bbox: [100, 100, 110, 110],
    dominantColors: [[200, 50, 50]], labelRaw: 'cup', confirmationCount: 10,
  };

  it('WITHOUT the cross-session drop, the misleading spatial-0 drags it to 0.85', () => {
    // emb 0.45*1 + spatial 0.15*0 + color 0.25*1 + size 0.10*1 + label 0.05*1 = 0.85
    expect(computeMatchScore(obs, cand, 10, { crossSession: false })).toBeCloseTo(0.85, 10);
  });

  it('WITH the cross-session drop (spatial+size), renorm lifts a true match to 1.0', () => {
    // drop spatial+size → renorm {emb 0.45, color 0.25, label 0.05}/0.75 = 1.0
    expect(computeMatchScore(obs, cand, 10, { crossSession: true })).toBeCloseTo(1.0, 10);
  });
});

// ---------------------------------------------------------------------------
// P3.A — all 5 signals live (bbox + colors now carry data)
// ---------------------------------------------------------------------------

describe('computeMatchScore — P3.A: 5 signals engaged (bbox + colors present)', () => {
  const E = [1, 0, 0, 0];

  it('(i) same-session candidate WITH bbox+colors scores over all 5 signals', () => {
    // Normalized boxes (atlas BLOCKER-2): identical box → spatial IoU 1, size 1.
    const obs: BindingObservation = {
      embedding: E,
      bbox: [0.1, 0.1, 0.3, 0.3],
      dominantColors: [[200, 50, 50]],
      labelRaw: 'cup',
    };
    const cand: BindingCandidate = {
      nodeId: 'n',
      embedding: E,
      bbox: [0.1, 0.1, 0.3, 0.3],
      dominantColors: [[200, 50, 50]],
      labelRaw: 'cup',
      confirmationCount: 10,
    };
    // KNOWN weights all engage (emb .45 + color .25 + spatial .15 + size .10 +
    // label .05 = 1.0), every scorer perfect → renorm over the full 1.0 → 1.0.
    // The point: NONE of the 5 signals is dropped (no null), so all 5 are live.
    expect(computeMatchScore(obs, cand, 10, { crossSession: false })).toBeCloseTo(
      1.0,
      10,
    );
    // And every individual scorer returns a NUMBER (data), not null.
    expect(scoreEmbedding(obs.embedding, cand.embedding)).not.toBeNull();
    expect(scoreSpatial(obs.bbox, cand.bbox)).not.toBeNull();
    expect(scoreColor(obs.dominantColors, cand.dominantColors)).not.toBeNull();
    expect(scoreSize(obs.bbox, cand.bbox)).not.toBeNull();
    expect(scoreLabelRaw(obs.labelRaw, cand.labelRaw)).not.toBeNull();
  });

  it('(ii) CROSS-session candidate drops spatial+size but KEEPS color (session-invariant)', () => {
    // Same identity (emb/color/label) but a DIFFERENT stored box. Cross-session
    // drops the box-derived signals (spatial, size); color survives because it
    // is session-invariant → renorm over {embedding, color, label}.
    const obs: BindingObservation = {
      embedding: E,
      bbox: [0.1, 0.1, 0.3, 0.3],
      dominantColors: [[200, 50, 50]],
      labelRaw: 'cup',
    };
    const cand: BindingCandidate = {
      nodeId: 'n',
      embedding: E,
      bbox: [0.7, 0.7, 0.9, 0.9], // non-overlapping
      dominantColors: [[200, 50, 50]],
      labelRaw: 'cup',
      confirmationCount: 10,
    };
    // KNOWN: emb .45 + color .25 + label .05 = 0.75, all perfect → 0.75/0.75 = 1.0.
    // (If color had been dropped too, denom would be 0.50 — but it MUST survive.)
    expect(computeMatchScore(obs, cand, 10, { crossSession: true })).toBeCloseTo(
      1.0,
      10,
    );
    // Prove color is the load-bearing survivor: with color absent on BOTH sides,
    // a cross-session match collapses to {embedding,label} (still 1.0 here only
    // because emb+label are perfect — but the denom differs, confirming color
    // genuinely participated above).
    const noColor = computeMatchScore(
      { ...obs, dominantColors: null },
      { ...cand, dominantColors: null },
      10,
      { crossSession: true },
    );
    expect(noColor).toBeCloseTo(1.0, 10); // emb+label perfect → still 1.0
    // But a label MISMATCH cross-session shows color carrying weight: WITH color
    // (emb 1, color 1, label 0)/0.75 = 0.933; WITHOUT color (emb 1, label 0)/0.50
    // = 0.90 → color materially lifts the score, i.e. it was kept.
    const withColorLabelMiss = computeMatchScore(
      { ...obs, labelRaw: 'mug' },
      cand,
      10,
      { crossSession: true },
    );
    const noColorLabelMiss = computeMatchScore(
      { ...obs, labelRaw: 'mug', dominantColors: null },
      { ...cand, dominantColors: null },
      10,
      { crossSession: true },
    );
    expect(withColorLabelMiss).toBeGreaterThan(noColorLabelMiss);
    expect(withColorLabelMiss).toBeCloseTo((0.45 + 0.25) / 0.75, 10);
    expect(noColorLabelMiss).toBeCloseTo(0.45 / 0.5, 10);
  });

  it('(iii) legacy candidate with all-null new fields → {embedding,label} only, perfect match still ≥ threshold (no regression)', () => {
    // A pre-P3.A row: bbox + colors are null. The observation may carry them, but
    // a scorer needs BOTH sides → spatial/color/size drop. Renorm collapses to
    // {embedding, label} exactly as day-one, so a perfect match is unregressed.
    const obs: BindingObservation = {
      embedding: E,
      bbox: [0.1, 0.1, 0.3, 0.3],
      dominantColors: [[200, 50, 50]],
      labelRaw: 'cup',
    };
    const legacy: BindingCandidate = {
      nodeId: 'legacy',
      embedding: E,
      bbox: null,
      dominantColors: null,
      labelRaw: 'cup',
      confirmationCount: 10,
    };
    const score = computeMatchScore(obs, legacy, 10);
    // renorm over {embedding .45, label .05} = 0.50/0.50 = 1.0 ≥ 0.75 threshold.
    expect(score).toBeCloseTo(1.0, 10);
    expect(score).toBeGreaterThanOrEqual(DEFAULT_BINDING_CONFIG.matchThreshold);

    // Through the full service: a legacy perfect match is a confident re-ID.
    const svc = new BindingService(DEFAULT_BINDING_CONFIG);
    const r = svc.findMatch(obs, [legacy], 1_000_000_000_000);
    expect(r.matchedNodeId).toBe('legacy');
    expect(r.confidence).toBeGreaterThanOrEqual(
      DEFAULT_BINDING_CONFIG.matchThreshold,
    );
  });
});

// ---------------------------------------------------------------------------
// BindingService.findMatch — classify + ambiguity band + surprise
// ---------------------------------------------------------------------------

describe('BindingService.findMatch', () => {
  const svc = new BindingService(DEFAULT_BINDING_CONFIG);
  const NOW = 1_000_000_000_000;
  const E = [1, 0];
  const obs: BindingObservation = { embedding: E, labelRaw: 'cup' };

  it('known object → confident match on the WEIGHTED score', () => {
    const cand: BindingCandidate = {
      nodeId: 'mug-1', embedding: E, labelRaw: 'cup', confirmationCount: 10,
    };
    const r = svc.findMatch(obs, [cand], NOW);
    expect(r.matchedNodeId).toBe('mug-1');
    expect(r.matchType).toBe('embedding');
    expect(r.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it('near-identical candidate fires the ambiguous (0.45–0.75) branch, no false match', () => {
    // cosine 0.7 to E, label mismatch → 0.90*0.7 = 0.63 ∈ [0.45, 0.75)
    const v = [0.7, Math.sqrt(0.51)];
    const cand: BindingCandidate = {
      nodeId: 'amb-1', embedding: v, labelRaw: 'mug', confirmationCount: 10,
    };
    const r = svc.findMatch(obs, [cand], NOW);
    expect(r.matchedNodeId).toBeNull();
    expect(r.confidence).toBeGreaterThanOrEqual(0.45);
    expect(r.confidence).toBeLessThan(0.75);
    expect(r.ambiguousCandidates).toContain('amb-1');
  });

  it('surprise_flag fires for a well-known object with a large embedding distance', () => {
    // cosine 0.5 → distance 0.5 > surpriseThreshold 0.3; count 10 ≥ 5
    const v = [0.5, Math.sqrt(0.75)];
    const cand: BindingCandidate = {
      nodeId: 's-1', embedding: v, labelRaw: 'cup', confirmationCount: 10,
    };
    const r = svc.findMatch(obs, [cand], NOW);
    expect(r.surpriseFlag).toBe(true);
  });

  it('no surprise_flag when confirmation_count < 5', () => {
    const v = [0.5, Math.sqrt(0.75)];
    const cand: BindingCandidate = {
      nodeId: 's-2', embedding: v, labelRaw: 'cup', confirmationCount: 3,
    };
    expect(svc.findMatch(obs, [cand], NOW).surpriseFlag).toBe(false);
  });

  it('OPEN-9: a cross-session candidate (last seen > 24h ago) re-IDs with higher confidence than the same in-session one', () => {
    const full: BindingObservation = {
      embedding: E, bbox: [0, 0, 10, 10], dominantColors: [[200, 50, 50]], labelRaw: 'cup',
    };
    const base = {
      nodeId: 'x', embedding: E, bbox: [100, 100, 110, 110] as [number, number, number, number],
      dominantColors: [[200, 50, 50]] as Array<[number, number, number]>,
      labelRaw: 'cup', confirmationCount: 10,
    };
    const inSession = svc.findMatch(full, [{ ...base, lastSeenAtMs: NOW - 3600 * 1000 }], NOW);
    const crossSession = svc.findMatch(full, [{ ...base, lastSeenAtMs: NOW - 25 * 3600 * 1000 }], NOW);
    expect(inSession.confidence).toBeCloseTo(0.85, 6); // spatial-0 kept
    expect(crossSession.confidence).toBeCloseTo(1.0, 6); // spatial+size dropped
    expect(crossSession.matchedNodeId).toBe('x');
  });

  it('empty candidate set → no match', () => {
    const r = svc.findMatch(obs, [], NOW);
    expect(r.matchedNodeId).toBeNull();
    expect(r.matchType).toBe('none');
  });
});
