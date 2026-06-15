/**
 * P1.5 — vision-only recall gate (cortex-ratified).
 *
 * The original searchMultiModal REQUIRED a text match, so a vision-only frame
 * (no user text) could never recall a previously-seen scene — even though a
 * visual_embedding pattern was written for it. P1.5 splits the gate on whether
 * text was PRESENT (not whether it matched):
 *   • text present + matched   → hit       (unchanged)
 *   • text present + unmatched → discard   (unchanged stale-replay guard)
 *   • text absent + visual_embedding-anchored → hit   (NEW: vision-only recall)
 *   • text absent + no visual anchor → discard         (audio/drive self-tick guard)
 *
 * The no-confabulation property is inherited from searchByModality's existing
 * 0.80 cosine + min-population + runner-up + zero-vector guards — no new recall
 * threshold is added (cortex ruling).
 */

import { LatentSpaceService } from './latent-space.service';

interface SeedEntry {
  id: string;
  modality: string;
  embedding: number[];
  responseText: string;
  procedureId: string | null;
  confidence: number;
  useCount: number;
  entityIds: string[];
  knowledgeGrounding: unknown;
  groundingPersonId: string | null;
}

function entry(over: Partial<SeedEntry>): SeedEntry {
  return {
    id: 'e',
    modality: 'visual_embedding',
    embedding: [1, 0, 0, 0, 0, 0, 0, 0],
    responseText: 'cached response',
    procedureId: null,
    confidence: 0.5,
    // useCount ≥ MIN_TRUSTED_USECOUNT(3) so a single seeded pattern clears the
    // min-population trust gate (a fresh useCount-0 pattern would be rejected).
    useCount: 5,
    entityIds: [],
    knowledgeGrounding: null,
    groundingPersonId: null,
    ...over,
  };
}

function svcWith(entries: SeedEntry[]): LatentSpaceService {
  const svc = new LatentSpaceService(null as never);
  (svc as unknown as { hotLayer: SeedEntry[] }).hotLayer = entries;
  return svc;
}

// SEEN self-matches (cosine 1.0 ≥ 0.80); UNSEEN is orthogonal (cosine 0 < 0.80).
const SEEN = [1, 0, 0, 0, 0, 0, 0, 0];
const UNSEEN = [0, 1, 0, 0, 0, 0, 0, 0];

describe('searchMultiModal — P1.5 vision-only recall gate', () => {
  it('a vision-only frame RECALLS a previously-seen scene (no text needed)', () => {
    const svc = svcWith([
      entry({ id: 'v', modality: 'visual_embedding', embedding: SEEN }),
    ]);
    const r = svc.searchMultiModal({ visual_embedding: SEEN });
    expect(r).not.toBeNull();
    expect(r!.bestMatch.modality).toBe('visual_embedding');
    expect(r!.bestMatch.similarity).toBeGreaterThanOrEqual(0.8);
  });

  it('a vision-only frame for an UNSEEN scene returns null (no confabulation)', () => {
    const svc = svcWith([
      entry({ id: 'v', modality: 'visual_embedding', embedding: SEEN }),
    ]);
    expect(svc.searchMultiModal({ visual_embedding: UNSEEN })).toBeNull();
  });

  it('text path is unchanged: a matched text frame still hits', () => {
    const svc = svcWith([
      entry({ id: 't', modality: 'text', embedding: SEEN }),
      entry({ id: 'v', modality: 'visual_embedding', embedding: SEEN }),
    ]);
    const hit = svc.searchMultiModal({ text: SEEN, visual_embedding: SEEN });
    expect(hit).not.toBeNull();
  });

  it('text path is unchanged: text PRESENT but unmatched still discards (stale-replay guard)', () => {
    const svc = svcWith([
      entry({ id: 't', modality: 'text', embedding: SEEN }),
      entry({ id: 'v', modality: 'visual_embedding', embedding: SEEN }),
    ]);
    // text offered but orthogonal → no text match → discard, even though visual matched.
    expect(svc.searchMultiModal({ text: UNSEEN, visual_embedding: SEEN })).toBeNull();
  });

  it('a no-text frame with only a non-visual (audio) match still returns null (stale-replay guard)', () => {
    const svc = svcWith([
      entry({ id: 'a', modality: 'audio', embedding: SEEN }),
    ]);
    expect(svc.searchMultiModal({ audio: SEEN })).toBeNull();
  });
});
