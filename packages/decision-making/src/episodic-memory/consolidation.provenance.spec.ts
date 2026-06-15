/**
 * Wave 3 / chunk C5 (§2.12) — consolidation derives honest provenance from
 * `episode.source` and carries `visualContext` through to the SemanticConversion.
 *
 * CANON Std-2 (provenance-required): a perception-derived episodic memory (scene
 * labels, a VLM caption) must NOT be consolidated under the old hardcoded
 * `EXTRACTION_PROVENANCE = 'INFERENCE'` blanket. These regressions pin:
 *   1. perception + sceneLabels  → SENSOR (NOT 'INFERENCE')
 *   2. perception + caption only → LLM_GENERATED (the caption's own provenance)
 *   3. conversation              → LLM_GENERATED
 *   4. legacy                    → INFERENCE (honest "unknown modality" floor)
 *   5. visualContext survives consolidation onto the conversion + is absent for
 *      non-perception episodes.
 *   6. the derived provenance also propagates onto each extracted relationship.
 *
 * No `:Candidate` routing is asserted: this service produces SemanticConversion
 * *records only* and never mints a groundable WKG node (the cycle result is
 * consumed for event-logging/counts), so the C5 candidate-routing requirement is
 * a documented no-op here. See the C5 report.
 *
 * Lives in the decision-making jest root and imports the service directly +
 * shared types via @sylphie/shared (dependency direction stays decision-making
 * → shared).
 */

import type {
  Episode,
  VisualContext,
  DriveSnapshot,
  EpisodeSource,
} from '@sylphie/shared';
import { ConsolidationService } from './consolidation.service';
import type {
  IEpisodicMemoryService,
} from '../interfaces/decision-making.interfaces';

// Minimal episodic-memory stub — convertToSemantic does not touch it.
const episodicMemoryStub = {
  getRecentEpisodes: () => [],
} as unknown as IEpisodicMemoryService;

// A DriveSnapshot is only read for event emission, not by convertToSemantic.
const driveSnapshot = { sessionId: 'test-session' } as unknown as DriveSnapshot;

function makeEpisode(
  source: EpisodeSource,
  visualContext?: VisualContext,
): Episode {
  return {
    id: `ep-${source}-${Math.random().toString(36).slice(2)}`,
    source,
    visualContext,
    timestamp: new Date(),
    driveSnapshot,
    inputSummary: 'A Dog ran across the Park',
    actionTaken: 'observe_scene',
    predictionIds: [],
    ageWeight: 0.9,
    encodingDepth: 'NORMAL',
    contextFingerprint: 'fp',
  } as Episode;
}

describe('C5 §2.12 — consolidation provenance derived from episode.source', () => {
  const svc = new ConsolidationService(episodicMemoryStub, null);

  it('perception + sceneLabels → SENSOR (NOT the old INFERENCE blanket)', () => {
    const vc: VisualContext = { sceneLabels: ['dog', 'park bench'] };
    const conv = svc.convertToSemantic(makeEpisode('perception', vc));

    expect(conv.provenance).toBe('SENSOR');
    expect(conv.provenance).not.toBe('INFERENCE');
  });

  it('perception + caption only → LLM_GENERATED (caption provenance)', () => {
    const vc: VisualContext = {
      caption: { text: 'a dog in a park', provenanceSource: 'LLM_GENERATED' },
    };
    const conv = svc.convertToSemantic(makeEpisode('perception', vc));

    expect(conv.provenance).toBe('LLM_GENERATED');
    expect(conv.provenance).not.toBe('INFERENCE');
  });

  it('perception with neither scene labels nor caption → SENSOR (seen, not inferred)', () => {
    const conv = svc.convertToSemantic(makeEpisode('perception', { faceCount: 1 }));
    expect(conv.provenance).toBe('SENSOR');
  });

  it('conversation → LLM_GENERATED', () => {
    const conv = svc.convertToSemantic(makeEpisode('conversation'));
    expect(conv.provenance).toBe('LLM_GENERATED');
  });

  it('legacy → INFERENCE (honest unknown-modality floor)', () => {
    const conv = svc.convertToSemantic(makeEpisode('legacy'));
    expect(conv.provenance).toBe('INFERENCE');
  });

  it('visualContext survives consolidation onto the conversion (perception)', () => {
    const vc: VisualContext = {
      sceneLabels: ['dog'],
      caption: { text: 'a dog', provenanceSource: 'LLM_GENERATED' },
      personIds: { ids: ['p1'], provenanceSource: 'INFERENCE' },
      faceCount: 1,
    };
    const conv = svc.convertToSemantic(makeEpisode('perception', vc));
    expect(conv.visualContext).toEqual(vc);
  });

  it('visualContext is absent for non-perception episodes', () => {
    const conv = svc.convertToSemantic(makeEpisode('conversation'));
    expect(conv.visualContext).toBeUndefined();
  });

  it('derived provenance propagates onto every extracted relationship', () => {
    const vc: VisualContext = { sceneLabels: ['dog'] };
    const conv = svc.convertToSemantic(makeEpisode('perception', vc));

    expect(conv.relationships.length).toBeGreaterThan(0);
    for (const rel of conv.relationships) {
      expect(rel.provenance).toBe('SENSOR');
    }
  });
});
