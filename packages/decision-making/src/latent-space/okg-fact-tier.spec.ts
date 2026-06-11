/**
 * WS4 Ticket 5 (§1, §6 A2/A3) — OKG self-fact guardian-aware tiering.
 *
 * Promotes the A2/A3 assertions from the deleted orphan harness
 * (test/unit/ws4-t5-writefact-tiering.ts) into a proper jest spec. We test the
 * PURE tier-derivation core (`deriveOkgFactTier` in @sylphie/shared) that
 * PersonModelService.writeFact now delegates to — the (confidence,
 * provenance_type) decision keyed off (source, isGuardian), never identity.
 *
 * This lives in the decision-making jest root (the repo's only jest root) and
 * imports the function via @sylphie/shared, so the dependency direction stays
 * correct (app → shared, decision-making → shared; never decision-making → app).
 */

import { deriveOkgFactTier } from '@sylphie/shared';

// Suppress verbose logs.
jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return { ...actual, verboseFor: () => () => {} };
});

describe('WS4-T5 §1 — deriveOkgFactTier (OKG self-fact tiering)', () => {
  it('A3 — guardian self-fact → 0.90 / GUARDIAN', () => {
    expect(deriveOkgFactTier('self_reported', true)).toEqual({
      confidence: 0.9,
      provenanceType: 'GUARDIAN',
    });
  });

  it('A2 — non-guardian self-fact → 0.60 / SELF_REPORTED', () => {
    expect(deriveOkgFactTier('self_reported', false)).toEqual({
      confidence: 0.6,
      provenanceType: 'SELF_REPORTED',
    });
  });

  it('observed fact (guardian) → 0.60 / OBSERVED — guardian never lifts non-self-report', () => {
    expect(deriveOkgFactTier('observed', true)).toEqual({
      confidence: 0.6,
      provenanceType: 'OBSERVED',
    });
  });

  it('observed fact (non-guardian) → 0.60 / OBSERVED', () => {
    expect(deriveOkgFactTier('observed', false)).toEqual({
      confidence: 0.6,
      provenanceType: 'OBSERVED',
    });
  });

  it('inferred fact → 0.60 / INFERENCE (guardian and non-guardian alike)', () => {
    expect(deriveOkgFactTier('inferred', true)).toEqual({
      confidence: 0.6,
      provenanceType: 'INFERENCE',
    });
    expect(deriveOkgFactTier('inferred', false)).toEqual({
      confidence: 0.6,
      provenanceType: 'INFERENCE',
    });
  });

  it('Std-3 ceiling — only a guardian SELF-report may exceed 0.60', () => {
    // Exhaustive: 0.90 appears in exactly one cell of the (source × isGuardian) table.
    const cells = [
      deriveOkgFactTier('self_reported', true),
      deriveOkgFactTier('self_reported', false),
      deriveOkgFactTier('observed', true),
      deriveOkgFactTier('observed', false),
      deriveOkgFactTier('inferred', true),
      deriveOkgFactTier('inferred', false),
    ];
    const above060 = cells.filter((c) => c.confidence > 0.6);
    expect(above060).toEqual([{ confidence: 0.9, provenanceType: 'GUARDIAN' }]);
  });

  it('Std-5 guard — tiering is identity-blind: isGuardian flag alone decides', () => {
    // The function has no access to a userId; a caller whose userId is literally
    // "guardian" but who is NOT guardian-verified gets the non-guardian tier,
    // because the only guardian signal is the boolean flag.
    expect(deriveOkgFactTier('self_reported', false).provenanceType).toBe('SELF_REPORTED');
    expect(deriveOkgFactTier('self_reported', false).confidence).toBe(0.6);
  });

  it('unknown source string falls through to the INFERENCE/0.60 floor', () => {
    expect(deriveOkgFactTier('something_else', true)).toEqual({
      confidence: 0.6,
      provenanceType: 'INFERENCE',
    });
  });
});
