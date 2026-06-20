/**
 * WS5.5.3 regression — consolidation carries visualContext provenance from
 * episode.source (§2.12, TK-83). Pins the two load-bearing lines:
 *   - deriveConsolidationProvenance: :97-107 (source-based dispatch)
 *   - convertToSemantic visualContext spread: :206
 *
 * Two acceptance criteria:
 *   AC-1: source='perception' + visualContext (sceneLabels + caption) produces
 *         provenance from visualContext, NOT INFERENCE, AND visualContext is
 *         carried onto the conversion.
 *   AC-2: source='conversation' → LLM_GENERATED; no text-episode regression.
 */

import type {
  Episode,
  VisualContext,
  DriveSnapshot,
  EpisodeSource,
} from '@sylphie/shared';
import { ConsolidationService } from './consolidation.service';
import type { IEpisodicMemoryService } from '../interfaces/decision-making.interfaces';

const episodicMemoryStub = {
  getRecentEpisodes: () => [],
} as unknown as IEpisodicMemoryService;

const driveSnapshot = { sessionId: 'ws5-5-test' } as unknown as DriveSnapshot;

function makeEpisode(source: EpisodeSource, visualContext?: VisualContext): Episode {
  return {
    id: `ep-ws5-${source}`,
    source,
    visualContext,
    timestamp: new Date(),
    driveSnapshot,
    inputSummary: 'Camera sees a mug on the desk',
    actionTaken: 'observe_scene',
    predictionIds: [],
    ageWeight: 0.9,
    encodingDepth: 'NORMAL',
    contextFingerprint: 'fp',
  } as Episode;
}

describe('WS5.5.3 — §2.12 consolidation provenance from episode.source', () => {
  const svc = new ConsolidationService(episodicMemoryStub, null);

  // AC-1a: perception + sceneLabels → SENSOR, NOT INFERENCE
  it('AC-1a: perception + sceneLabels → provenance=SENSOR, not INFERENCE (consolidation.service.ts:100)', () => {
    const vc: VisualContext = { sceneLabels: ['mug', 'desk'] };
    const conv = svc.convertToSemantic(makeEpisode('perception', vc));
    expect(conv.provenance).toBe('SENSOR');
    expect(conv.provenance).not.toBe('INFERENCE');
  });

  // AC-1b: perception + caption only → LLM_GENERATED, NOT INFERENCE
  it('AC-1b: perception + caption only → provenance=LLM_GENERATED, not INFERENCE (consolidation.service.ts:101)', () => {
    const vc: VisualContext = {
      caption: { text: 'a mug on a desk', provenanceSource: 'LLM_GENERATED' },
    };
    const conv = svc.convertToSemantic(makeEpisode('perception', vc));
    expect(conv.provenance).toBe('LLM_GENERATED');
    expect(conv.provenance).not.toBe('INFERENCE');
  });

  // AC-1c: visualContext is carried onto the SemanticConversion (consolidation.service.ts:206)
  it('AC-1c: visualContext survives onto conversion.visualContext (consolidation.service.ts:206)', () => {
    const vc: VisualContext = {
      sceneLabels: ['mug'],
      caption: { text: 'a mug', provenanceSource: 'LLM_GENERATED' },
    };
    const conv = svc.convertToSemantic(makeEpisode('perception', vc));
    expect(conv.visualContext).toEqual(vc);
  });

  // AC-2: conversation → LLM_GENERATED (no text-episode regression)
  it('AC-2: conversation → provenance=LLM_GENERATED, no regression (consolidation.service.ts:104)', () => {
    const conv = svc.convertToSemantic(makeEpisode('conversation'));
    expect(conv.provenance).toBe('LLM_GENERATED');
    expect(conv.visualContext).toBeUndefined();
  });
});
