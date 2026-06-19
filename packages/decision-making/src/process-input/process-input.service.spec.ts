/**
 * Unit tests for ProcessInputService.categorizeFrame — P4.2 / TK-21.
 *
 * A sceneNudge cycle is stamped frame.raw['system_trigger']=true in
 * runCycleForTurn (decision-making.service.ts). categorizeFrame branches on
 * that stamp FIRST so a vision-triggered cycle (no human text/audio) classifies
 * as SYSTEM_TRIGGER — distinct from a co-present VISUAL_INPUT frame carrying
 * human text/audio — routing deliberation + P1.5 recall correctly.
 *
 * categorizeFrame is private, so it is exercised through the public processInput,
 * which returns inputCategory (same indirection as fingerprint.spec.ts).
 *
 * Acceptance criteria covered here:
 *   AC1 — sceneNudge frame stamped system_trigger=true → SYSTEM_TRIGGER
 *   AC2 — normal video-only frame (no stamp) → VISUAL_INPUT (no regression)
 *
 * AC3 (trigger independent of drive pressure: a sceneNudge turn on a drive-cold
 * backend still enqueues and runs a SYSTEM_TRIGGER cycle) is covered in
 * scene-nudge-system-trigger.spec.ts at the CycleGuard wiring level.
 */

import { ProcessInputService } from './process-input.service';
import {
  EMBEDDING_DIM,
  DRIVE_INDEX_ORDER,
  type SensoryFrame,
  type DriveSnapshot,
  type DriveName,
} from '@sylphie/shared';

jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return { ...actual, verboseFor: () => () => {} };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService(): ProcessInputService {
  // All constructor deps are @Optional — null is sufficient for categorization
  // (no episodic memory / retriever / registry is touched on this path).
  return new ProcessInputService(null, null, null);
}

/** Minimal DriveSnapshot — only pressureVector is read on this path. */
function makeSnapshot(dominant: DriveName = DRIVE_INDEX_ORDER[0]): DriveSnapshot {
  const pressureVector: Record<string, number> = {};
  for (const d of DRIVE_INDEX_ORDER) pressureVector[d] = 0;
  pressureVector[dominant] = 1;
  return { pressureVector } as unknown as DriveSnapshot;
}

function zeros(): number[] {
  return new Array(EMBEDDING_DIM).fill(0);
}

/** A frame with the given active modalities and raw map. */
function makeFrame(active: string[], raw: Record<string, unknown>): SensoryFrame {
  return {
    timestamp: 1,
    fused_embedding: zeros(),
    modality_embeddings: {},
    active_modalities: active,
    raw,
  };
}

async function categoryOf(svc: ProcessInputService, frame: SensoryFrame): Promise<string> {
  const result = await svc.processInput(frame, makeSnapshot());
  return result.inputCategory;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProcessInputService.categorizeFrame — SYSTEM_TRIGGER (P4.2 / TK-21)', () => {
  it('AC1: a sceneNudge frame stamped system_trigger=true → SYSTEM_TRIGGER (not VISUAL_INPUT)', async () => {
    const svc = makeService();
    // A sceneNudge frame rides the same video/scene modalities a visual frame
    // does — the system_trigger stamp is what must override the classification.
    const frame = makeFrame(['video', 'scene'], {
      video: { detections: [] },
      system_trigger: true,
    });
    expect(await categoryOf(svc, frame)).toBe('SYSTEM_TRIGGER');
  });

  it('AC1: the stamp overrides even a single video modality (would otherwise be VISUAL_INPUT)', async () => {
    const svc = makeService();
    const frame = makeFrame(['video'], { video: { detections: [] }, system_trigger: true });
    expect(await categoryOf(svc, frame)).toBe('SYSTEM_TRIGGER');
  });

  it('AC2: a normal video-only frame (no stamp, not a sceneNudge) → VISUAL_INPUT (no regression)', async () => {
    const svc = makeService();
    const frame = makeFrame(['video'], { video: { detections: [] } });
    expect(await categoryOf(svc, frame)).toBe('VISUAL_INPUT');
  });

  it('AC2: a multimodal frame without the stamp still classifies normally (no regression)', async () => {
    const svc = makeService();
    const frame = makeFrame(['video', 'audio'], { video: { detections: [] } });
    expect(await categoryOf(svc, frame)).toBe('MULTIMODAL_INPUT');
  });

  it('an absent system_trigger key is treated as not-a-trigger', async () => {
    const svc = makeService();
    const frame = makeFrame(['text'], { text: 'hello' });
    expect(await categoryOf(svc, frame)).toBe('TEXT_INPUT');
  });

  it('a falsy/non-true system_trigger value does NOT trigger SYSTEM_TRIGGER', async () => {
    const svc = makeService();
    // Defensive: only the literal `true` stamp (written by runCycleForTurn)
    // reclassifies — a leftover falsy value must not hijack a real visual frame.
    const frame = makeFrame(['video'], { video: { detections: [] }, system_trigger: false });
    expect(await categoryOf(svc, frame)).toBe('VISUAL_INPUT');
  });
});
