/**
 * Property test — versioned fingerprint migration (P1 #3 + HR1, plan §6 "§400").
 *
 * INVARIANT: every v(N) fingerprint is a clean versioned MISS under v(N+1) — a
 * cross-version collision is cryptographically impossible because EMBEDDING_VERSION
 * leads the SHA-256 preimage. This protects the batch-atomic migration: when #0
 * adds the visual_embedding modality and #3 widens the slice (one version bump),
 * pre-existing episodes become a clean one-time recall MISS, NEVER a corrupted HIT
 * that mis-keys an old fingerprint against the new 7-modality fused vector.
 *
 * Plan path is `test/property/fingerprint-migration.spec.ts`; co-located under
 * src/ because this package's jest `roots` is `<rootDir>/src` (no test/ root).
 *
 * The fingerprint preimage is the documented contract:
 *   `${version}::${category}::${quantized2dp(FULL fused vector)}::${dominantDrive}`
 * It is bound to the real code by fingerprint.spec.ts (the "binds the preimage
 * reimplementation to the real code" test); here we exercise the cross-version
 * property at scale over random vectors, categories and drives.
 */

import { createHash } from 'crypto';
import { EMBEDDING_DIM, EMBEDDING_VERSION } from '@sylphie/shared';

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fingerprint(
  version: number,
  category: string,
  fused: number[],
  dominantDrive: string,
): string {
  const quantized = fused.map((v) => Math.round(v * 100) / 100);
  const preimage = `${version}::${category}::${quantized.join(',')}::${dominantDrive}`;
  return createHash('sha256').update(preimage).digest('hex');
}

const CATEGORIES = ['TEXT_INPUT', 'VISUAL_INPUT', 'MULTIMODAL_INPUT', 'SYSTEM_TRIGGER', 'UNKNOWN'];
const DRIVES = ['curiosity', 'social', 'anxiety', 'fatigue', 'satisfaction'];

describe('Fingerprint migration — versioned cross-version isolation (property)', () => {
  it('every v(N) fingerprint is a clean MISS under v(N+1) — never a cross-version HIT', () => {
    const rng = mulberry32(0xfeed);
    const N = 500;

    const vNCurrent = new Set<string>();
    const vNplus1 = new Set<string>();

    for (let i = 0; i < N; i++) {
      const fused = new Array(EMBEDDING_DIM);
      for (let d = 0; d < EMBEDDING_DIM; d++) fused[d] = rng() * 2 - 1;
      const category = CATEGORIES[Math.floor(rng() * CATEGORIES.length)];
      const drive = DRIVES[Math.floor(rng() * DRIVES.length)];

      // SAME content, only the version differs.
      vNCurrent.add(fingerprint(EMBEDDING_VERSION, category, fused, drive));
      vNplus1.add(fingerprint(EMBEDDING_VERSION + 1, category, fused, drive));
    }

    // No fingerprint produced under the current version can ever appear in the
    // next version's set for the SAME underlying content — clean versioned miss.
    for (const fp of vNCurrent) {
      expect(vNplus1.has(fp)).toBe(false);
    }
  });

  it('a v1 (legacy) fingerprint never collides with a current-version fingerprint of identical content', () => {
    // Read through a runtime indirection so TS does not narrow EMBEDDING_VERSION
    // to a literal (which would make a `=== 1` comparison a no-overlap error and
    // hard-code the version into the test). The current version IS > 1 by the
    // batch-atomic bump; assert the property holds for that.
    const currentVersion: number = EMBEDDING_VERSION;
    expect(currentVersion).toBeGreaterThan(1);

    const rng = mulberry32(0xc0ffee);
    for (let i = 0; i < 200; i++) {
      const fused = new Array(EMBEDDING_DIM);
      for (let d = 0; d < EMBEDDING_DIM; d++) fused[d] = rng() * 2 - 1;
      const category = CATEGORIES[Math.floor(rng() * CATEGORIES.length)];
      const drive = DRIVES[Math.floor(rng() * DRIVES.length)];

      const legacyV1 = fingerprint(1, category, fused, drive);
      const current = fingerprint(currentVersion, category, fused, drive);
      // Legacy v1 ≠ current — a legacy fingerprint is a clean versioned MISS,
      // never a cross-version HIT.
      expect(legacyV1).not.toBe(current);
    }
  });
});
