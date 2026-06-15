/**
 * Wave 3 / C6 — DROPPED-MODALITY AUDIT regression spec.
 *
 * INVARIANT under test: writeMultiModal still skips the 'drives' and 'faces'
 * modalities (a separate person-scoped index is deferred to a later wave), but
 * the skip is now AUDITED, not silent (CANON Std-1 — no silent stubs). Supplied
 * drive/face embeddings are counted as dropped and surfaced via
 * getDroppedModalityWriteCounts(), while conversational modalities still write.
 *
 * Exercises the REAL LatentSpaceService.writeMultiModal — TimescaleService is
 * undefined so the service runs hot-layer-only (no DB), the in-memory path.
 */

import { LatentSpaceService, type MultiModalWriteOpts } from './latent-space.service';
import { EMBEDDING_DIM } from '@sylphie/shared';

// Suppress verbose logs.
jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return { ...actual, verboseFor: () => () => {} };
});

function unitEmbedding(axis = 0): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[axis % EMBEDDING_DIM] = 1;
  return v;
}

const OPTS: MultiModalWriteOpts = { confidence: 0.9, entityIds: [] } as MultiModalWriteOpts;

describe('Wave 3 C6 — dropped-modality audit', () => {
  let svc: LatentSpaceService;

  beforeEach(() => {
    svc = new LatentSpaceService(undefined as never);
  });

  it('drops drives/faces but writes conversational modalities', async () => {
    const ids = await svc.writeMultiModal(
      { text: unitEmbedding(0), drives: unitEmbedding(1), faces: unitEmbedding(2) },
      'cached reflex response',
      OPTS,
    );

    // Only the 'text' modality produced a pattern id.
    expect(ids).toHaveLength(1);
  });

  it('counts each dropped drive/face write (Std-1 — not silent)', async () => {
    await svc.writeMultiModal(
      { text: unitEmbedding(0), drives: unitEmbedding(1), faces: unitEmbedding(2) },
      'r1',
      OPTS,
    );

    expect(svc.getDroppedModalityWriteCounts()).toEqual({ drives: 1, faces: 1 });
  });

  it('accumulates dropped counts across calls', async () => {
    await svc.writeMultiModal({ drives: unitEmbedding(1) }, 'r1', OPTS);
    await svc.writeMultiModal({ drives: unitEmbedding(1), faces: unitEmbedding(2) }, 'r2', OPTS);

    expect(svc.getDroppedModalityWriteCounts()).toEqual({ drives: 2, faces: 1 });
  });

  it('reports no drops when only conversational modalities are written', async () => {
    await svc.writeMultiModal({ text: unitEmbedding(0) }, 'r1', OPTS);

    expect(svc.getDroppedModalityWriteCounts()).toEqual({});
  });
});
