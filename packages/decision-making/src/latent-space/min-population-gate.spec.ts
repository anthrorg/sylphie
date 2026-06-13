/**
 * WS1 follow-up #3 — MIN-POPULATION TRUST GATE regression spec.
 *
 * INVARIANT under test: a SINGLE over-general pattern in the hot layer must NOT
 * yield a trusted Type 1 match while its modality is below the population floor
 * and the pattern has not earned trust through repeated confirmed use. This is
 * the exact confabulation mechanism the gate exists to prevent — a fresh-boot
 * lone pattern firing a confident GROUNDED reflex against nonsense.
 *
 * The runner-up margin alone does NOT cover this case: with exactly one candidate
 * of a modality there is no runner-up, so the margin check is trivially satisfied
 * and the lone pattern wins. The min-population gate is the structural backstop.
 *
 * These tests exercise the REAL LatentSpaceService.searchByModality /
 * searchMultiModal — no copies. TimescaleService is passed as undefined so the
 * service runs hot-layer-only (no DB), exactly the in-memory path the prod search
 * hits per turn.
 */

import { LatentSpaceService, type NewPattern } from './latent-space.service';
import { EMBEDDING_DIM } from '@sylphie/shared';

// Suppress verbose logs.
jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return { ...actual, verboseFor: () => () => {} };
});

/**
 * Build a unit-norm embedding pointing mostly along `axis` with a little spread,
 * so two embeddings built from nearby axes are highly similar (cosine ~> 0.80)
 * without being identical. Deterministic.
 */
function embeddingAlong(axis: number, jitter = 0): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[axis % EMBEDDING_DIM] = 1;
  v[(axis + 1) % EMBEDDING_DIM] = 0.95;
  if (jitter) v[(axis + 2) % EMBEDDING_DIM] = jitter;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

function newPattern(embedding: number[], overrides: Partial<NewPattern> = {}): NewPattern {
  return {
    modality: 'text',
    stimulusEmbedding: embedding,
    responseText: 'cached reflex response',
    confidence: 0.9,
    entityIds: [],
    ...overrides,
  };
}

describe('WS1-followup-3 — min-population trust gate', () => {
  let svc: LatentSpaceService;

  beforeEach(() => {
    // TimescaleService undefined → in-memory hot-layer-only. This is the path the
    // prod per-turn search runs; the gate lives entirely in searchByModality.
    svc = new LatentSpaceService(undefined as never);
  });

  it('REGRESSION: a single fresh over-general pattern does NOT yield a trusted match', async () => {
    // Seed exactly ONE text pattern (a lone, untested, over-general reflex) with
    // useCount 0 (the write() default). The query is highly similar (same axis).
    const stored = embeddingAlong(10);
    await svc.write(newPattern(stored));
    expect(svc.hotLayerSize).toBe(1);

    const query = embeddingAlong(10, 0.02); // cosine well above the 0.80 threshold
    const match = svc.searchByModality('text', query);

    // The lone fresh pattern would clear threshold AND trivially satisfy the
    // runner-up margin (no runner-up) — yet the population gate must reject it.
    expect(match).toBeNull();
  });

  it('multi-modal search returns null for a single fresh pattern (routes to deliberation)', async () => {
    await svc.write(newPattern(embeddingAlong(20)));
    const result = svc.searchMultiModal({ text: embeddingAlong(20, 0.02) });
    // No trusted text match → searchMultiModal yields no hit at all (text-required
    // rule). Downstream this means NO latent Type 1 candidate is injected, so the
    // input falls through to honest deliberation rather than a confident reflex.
    expect(result).toBeNull();
  });

  it('a single pattern that has EARNED trust (useCount ≥ floor) DOES match', async () => {
    const stored = embeddingAlong(30);
    const id = await svc.write(newPattern(stored));
    // Simulate a battle-tested reflex: confirmed-used enough times to clear the floor.
    svc.recordUse(id);
    svc.recordUse(id);
    svc.recordUse(id);

    const match = svc.searchByModality('text', embeddingAlong(30, 0.02));
    expect(match).not.toBeNull();
    expect(match!.pattern.id).toBe(id);
  });

  it('once the modality is populous enough, fresh single-match discrimination resumes', async () => {
    // Seed MIN_MODALITY_POPULATION (3) distinct text patterns on far-apart axes so
    // exactly one is the clear winner for a given query (others score low → the
    // runner-up margin is satisfied by a real margin, not by absence of a runner-up).
    await svc.write(newPattern(embeddingAlong(40)));
    await svc.write(newPattern(embeddingAlong(120)));
    await svc.write(newPattern(embeddingAlong(300)));
    expect(svc.hotLayerSize).toBe(3);

    // Query close to the first pattern's axis: it wins by a wide margin over the
    // far-apart others, and the population floor has lifted (>=3 patterns).
    const match = svc.searchByModality('text', embeddingAlong(40, 0.02));
    expect(match).not.toBeNull();
  });

  it('below floor, a genuinely close runner-up does not rescue an unproven winner', async () => {
    // Two near-identical fresh patterns (population 2 < floor 3), both useCount 0.
    // Even though there IS a runner-up here, the winner is unproven and the layer
    // is below floor, so the gate still rejects — sparse + unproven = no trust.
    await svc.write(newPattern(embeddingAlong(50)));
    await svc.write(newPattern(embeddingAlong(50, 0.5))); // close but distinct
    expect(svc.hotLayerSize).toBe(2);

    const match = svc.searchByModality('text', embeddingAlong(50, 0.02));
    expect(match).toBeNull();
  });
});
