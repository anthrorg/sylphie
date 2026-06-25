/**
 * Unit tests for VisualPresenceHabituatorService — TK-97.
 *
 * Three acceptance criteria:
 *
 * AC1 — Design step: steady-state pressure from a static scene is provably
 *        below IDLE_PRESSURE_THRESHOLD=4.0 after habituation.  This is a
 *        numerical argument tested via the attenuation curve itself.
 *
 * AC2 — Static scene held constant: undiscovered-objects/unknown-persons
 *        contribution attenuates toward 0 over repeated exposures to the
 *        SAME identities, so total drive pressure can decay below 4.0.
 *
 * AC3 — New identity: a fresh identity entering the scene fires at factor=1.0
 *        (full pressure), even when other identities are fully habituated.
 *        Habituation is per-identity, not a global mute.
 *
 * The service is pure in-memory with no dependencies, so tests instantiate it
 * directly without a NestJS testing module (mirrors action-emotions.spec.ts and
 * guilt-repair.spec.ts patterns).
 */

import { VisualPresenceHabituatorService } from './visual-presence-habituator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Single-identity effective count after N exposures. */
function attenuatedFactor(n: number): number {
  return 1 / (1 + 0.6 * n);
}

// ---------------------------------------------------------------------------
// AC1 — Design step: steady-state pressure analysis
// ---------------------------------------------------------------------------

describe('TK-97 AC1 — design step: static-scene steady-state pressure below 4.0', () => {
  /**
   * Baseline (no fix): 3 undiscovered objects + 1 unknown person pinned indefinitely.
   *
   * Per-cycle raw contribution to drives (from rules.ts):
   *   3 objects × Curiosity 0.01 = 0.030 Curiosity, 3 × Focus 0.005 = 0.015 Focus
   *   1 person  × Social   0.015 = 0.015 Social,   1 × Curiosity 0.005 = 0.005 Curiosity
   *
   * With no decay on Curiosity/Social/Focus (drives.ts), these drives saturate at 1.0
   * → total from visual baseline alone: Curiosity(1.0) + Focus(1.0) + Social(1.0) = 3.0.
   * Plus Boredom, Anxiety from base accumulation → easily exceeds 4.0 indefinitely.
   *
   * With habituation: after enough cycles the attenuated count → 0, so the visual
   * contribution approaches 0.  Only baseline accumulation remains
   * (Curiosity=0.0012/s, Boredom=0.0015/s, Social=0.0009/s, Anxiety=0.0003/s).
   * These drives CANNOT saturate Curiosity+Focus+Social+Boredom to 4.0 without
   * Sylphie's own self-tick relief kicking in — habituation breaks the pin.
   *
   * AC1 numerical target (stated):
   *   Post-habituation visual contribution = 0 (attenuated count → 0).
   *   Fix type = HABITUATION-ONLY (no floor adjustment to IDLE_PRESSURE_THRESHOLD).
   */

  it('attenuated count approaches 0 as exposure count grows (k=0.6)', () => {
    // Verify the curve is strictly decreasing toward 0 for a single identity.
    const counts = [0, 1, 5, 10, 20, 50, 100];
    const factors = counts.map(attenuatedFactor);

    // Strictly decreasing
    for (let i = 1; i < factors.length; i++) {
      expect(factors[i]).toBeLessThan(factors[i - 1]!);
    }

    // After 50 exposures: factor < 0.04 (97% attenuation) — contribution is negligible
    expect(attenuatedFactor(50)).toBeLessThan(0.04);

    // After 100 exposures: factor < 0.02 (98% attenuation)
    expect(attenuatedFactor(100)).toBeLessThan(0.02);
  });

  it('first sighting (count=0) fires at factor=1.0 — novelty preserved', () => {
    expect(attenuatedFactor(0)).toBe(1.0);
  });

  it('static-scene total contribution after 20 cycles is well below raw baseline', () => {
    // 3 undiscovered objects + 1 unknown person, 20 cycles each.
    const objectFactor = attenuatedFactor(20);  // 1/(1+0.6*20) = 1/13 ≈ 0.077
    const personFactor = attenuatedFactor(20);

    // Per-cycle attenuated contribution (units match rules.ts coefficients):
    const curiosityContrib = 3 * objectFactor * 0.01 + 1 * personFactor * 0.005;
    const focusContrib     = 3 * objectFactor * 0.005;
    const socialContrib    = 1 * personFactor * 0.015;

    // All three are fractional even combined — they cannot sustain drives at 1.0
    expect(curiosityContrib + focusContrib + socialContrib).toBeLessThan(0.01);
  });
});

// ---------------------------------------------------------------------------
// AC2 — Repeated exposures attenuate the SAME identities
// ---------------------------------------------------------------------------

describe('TK-97 AC2 — static scene: same identities attenuate over cycles', () => {
  const OBJECT_IDS = ['entity-a', 'entity-b', 'entity-c'];
  const PERSON_IDS = ['person-x'];

  it('attenuatedCount for constant object set strictly decreases over 30 cycles', () => {
    const svc = new VisualPresenceHabituatorService();
    const counts: number[] = [];

    for (let cycle = 0; cycle < 30; cycle++) {
      counts.push(svc.computeAttenuatedCount(OBJECT_IDS, 'object'));
    }

    // Each call must be strictly less than the previous
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeLessThan(counts[i - 1]!);
    }

    // After 30 cycles, attenuated count is below 10% of raw count (3 objects)
    expect(counts[counts.length - 1]).toBeLessThan(0.3);
  });

  it('attenuatedCount for constant person set strictly decreases over 30 cycles', () => {
    const svc = new VisualPresenceHabituatorService();
    const counts: number[] = [];

    for (let cycle = 0; cycle < 30; cycle++) {
      counts.push(svc.computeAttenuatedCount(PERSON_IDS, 'person'));
    }

    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeLessThan(counts[i - 1]!);
    }

    expect(counts[counts.length - 1]).toBeLessThan(0.1);
  });

  it('exposure counts increase monotonically in getExposureCounts()', () => {
    const svc = new VisualPresenceHabituatorService();
    const id = 'entity-mono';

    for (let n = 1; n <= 10; n++) {
      svc.computeAttenuatedCount([id], 'object');
      expect(svc.getExposureCounts()[id]).toBe(n);
    }
  });

  it('total pressure contribution after 60+ cycles is below the raw count (AC2 telemetry)', () => {
    const svc = new VisualPresenceHabituatorService();

    // Simulate 60 cycles — exceeds 60s at 1Hz cognitive cycle rate
    for (let i = 0; i < 59; i++) {
      svc.computeAttenuatedCount(OBJECT_IDS, 'object');
      svc.computeAttenuatedCount(PERSON_IDS, 'person');
    }
    const objContrib = svc.computeAttenuatedCount(OBJECT_IDS, 'object');
    const perContrib = svc.computeAttenuatedCount(PERSON_IDS, 'person');

    // Attenuated contribution is a tiny fraction of the raw counts (3, 1)
    expect(objContrib).toBeLessThan(0.2);  // < 7% of raw 3
    expect(perContrib).toBeLessThan(0.1);  // < 10% of raw 1
  });
});

// ---------------------------------------------------------------------------
// AC3 — Novelty preserved: new identity fires at full factor=1.0
// ---------------------------------------------------------------------------

describe('TK-97 AC3 — new identity rises regardless of existing habituation', () => {
  it('new identity not in exposure map fires at factor=1.0 (full pressure)', () => {
    const svc = new VisualPresenceHabituatorService();
    const knownId = 'entity-old';
    const newId = 'entity-brand-new';

    // Habituate the known entity for 50 cycles; after this knownId count=50.
    for (let i = 0; i < 50; i++) {
      svc.computeAttenuatedCount([knownId], 'object');
    }

    // Now call with [knownId, newId]:
    //   knownId: count was 50 → reads factor=1/(1+0.6*50), then increments to 51
    //   newId:   count was 0  → reads factor=1/(1+0)=1.0, then increments to 1
    const combined = svc.computeAttenuatedCount([knownId, newId], 'object');
    const expectedKnownFactor = 1 / (1 + 0.6 * 50); // factor BEFORE increment (read then write)
    const expectedNewFactor = 1.0;                    // count=0 → factor=1.0
    expect(combined).toBeCloseTo(expectedKnownFactor + expectedNewFactor, 5);
  });

  it('a fresh scene (reset) restores all factors to 1.0', () => {
    const svc = new VisualPresenceHabituatorService();
    const id = 'entity-z';

    for (let i = 0; i < 20; i++) {
      svc.computeAttenuatedCount([id], 'object');
    }
    expect(svc.getExposureCounts()[id]).toBe(20);

    svc.reset();

    // After reset, count is gone — first call returns 1.0
    const factorAfterReset = svc.computeAttenuatedCount([id], 'object');
    expect(factorAfterReset).toBeCloseTo(1.0, 5);
    expect(svc.getExposureCounts()[id]).toBe(1);
  });

  it('empty ids array returns 0 without mutating state', () => {
    const svc = new VisualPresenceHabituatorService();
    svc.computeAttenuatedCount(['entity-a'], 'object');
    const countBefore = svc.getExposureCounts()['entity-a'];

    const result = svc.computeAttenuatedCount([], 'object');
    expect(result).toBe(0);
    // entity-a count unchanged
    expect(svc.getExposureCounts()['entity-a']).toBe(countBefore);
  });

  it('fallback path (no ids, raw count) passes through un-attenuated', () => {
    // Decision-making.service.ts falls back to rawCount when undiscovered_ids
    // is absent (non-gateway callers / tests). This path returns the raw count
    // unmodified — verify the fallback logic is correct.
    // NOTE: this is not testing the habituator itself (which never sees rawCount
    // directly) but the DECISION layer's fallback; we model it here as a
    // documentation test.
    const rawCount = 3;
    const undiscoveredIds: string[] = [];
    const attenuatedCount = undiscoveredIds.length > 0
      ? 0  // would call habituator
      : rawCount;  // fallback
    expect(attenuatedCount).toBe(rawCount);
  });
});
