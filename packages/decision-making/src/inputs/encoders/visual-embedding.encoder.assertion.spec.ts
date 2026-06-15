/**
 * P3.1 fail-loud assertion test for VisualEmbeddingEncoder.
 *
 * The JL projection was DELETED because OBJECT_EMBEDDING_DIM === EMBEDDING_DIM
 * (both 768 at P3.1). If a future backbone makes them diverge, the encoder must
 * REFUSE to construct rather than silently feed a wrong-length unit vector into
 * fusion. This file mocks @sylphie/shared with DIVERGING dims (OBJECT=1024,
 * fused=768) at the FILE level — a per-test re-mock is shadowed by a co-located
 * top-level jest.mock, so the mismatch case gets its own file.
 */

// File-level mock with a DIM MISMATCH (object 1024 != fused 768). Hoisted by
// jest above the import below, so the encoder evaluates against these dims.
jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return {
    ...actual,
    verboseFor: () => () => {},
    OBJECT_EMBEDDING_DIM: 1024,
    EMBEDDING_DIM: 768,
  };
});

import { VisualEmbeddingEncoder } from './visual-embedding.encoder';
import { ModalityRegistryService } from '../registry/modality-registry.service';

describe('VisualEmbeddingEncoder — fail-loud dim assertion (P3.1)', () => {
  it('the constructor THROWS when OBJECT_EMBEDDING_DIM != EMBEDDING_DIM', () => {
    expect(() => new VisualEmbeddingEncoder(new ModalityRegistryService())).toThrow(
      /OBJECT_EMBEDDING_DIM === EMBEDDING_DIM/,
    );
  });

  it('the thrown message names BOTH offending dims (actionable diagnostics)', () => {
    expect(() => new VisualEmbeddingEncoder(new ModalityRegistryService())).toThrow(
      /OBJECT_EMBEDDING_DIM=1024.*EMBEDDING_DIM=768/,
    );
  });
});
