/**
 * TK-19 — P4-POC: sceneNudge turn -> SYSTEM_TRIGGER end-to-end feasibility.
 *
 * READ-ONLY SPIKE (no production code change). De-risks Fork C by proving, against
 * the LIVE decision path (real TickSamplerService.sample + real SensoryFusionService
 * + real SceneEncoder + real ProcessInputService.categorizeFrame, reached via the
 * public processInput), that:
 *
 *   1. CARRIER SURVIVES sample(): a `system_trigger` marker placed on the frame
 *      survives the real sample() (EWMA blend + rolling-window push) and is
 *      readable on `frame.raw['system_trigger']`, WITH the scene data intact in
 *      `frame.raw['scene']`. Two carrier variants are proven:
 *        (a) stamped POST-sample on `frame.raw` — the RECOMMENDED path, identical
 *            to the existing `frame.raw['turn_id']` precedent
 *            (decision-making.service.ts:367-369), and
 *        (b) written to a tick-sampler slot PRE-sample — flows through fuse()'s
 *            "values with no encoder" pass-through (sensory-fusion.ts:154-158).
 *
 *   2. categorizeFrame CAN BRANCH on it -> SYSTEM_TRIGGER WITHOUT DROPPING SCENE:
 *      the proposed one-line branch (a `system_trigger === true` check placed
 *      FIRST in categorizeFrame) returns the already-valid SYSTEM_TRIGGER category,
 *      while the REAL extractEntities still extracts the scene's confirmed-object
 *      labels — proving scene data is not dropped by the early categorize return.
 *
 * ──────────────────────────── CONVERSION CONTRACT ────────────────────────────
 * Carrier:    frame.raw['system_trigger'] : true
 * Stamp site: runCycleForTurn (decision-making.service.ts), immediately AFTER
 *             `const frame = await this.tickSampler.sample();` — the SAME site as
 *             the existing `frame.raw['turn_id']` stamp, but UNCONDITIONAL when
 *             `turn.sceneNudge` is true (NOT gated on currentTurnContext?.turnId,
 *             because a sceneNudge turn nulls currentTurnContext at :349-350 and so
 *             carries no turnId).
 * Read site:  categorizeFrame (process-input.service.ts) — a `system_trigger ===
 *             true` check as the FIRST branch (before GUARDIAN/MULTIMODAL/VISUAL),
 *             returning the already-valid 'SYSTEM_TRIGGER' InputCategory (:50).
 * Survival:   sample() returns `{ ...rawFrame, fused_embedding: [...] }`
 *             (tick-sampler.ts:294-297) — only fused_embedding is replaced; `raw`
 *             is carried BY REFERENCE (shallow spread, no deep copy), so a post-
 *             sample stamp is trivially readable and the EWMA blend cannot touch it.
 * No-drop:    extractEntities reads frame.raw['scene'] independently of category
 *             (process-input.service.ts:284), so an early SYSTEM_TRIGGER return
 *             drops no scene data. Only effect: a scene+video nudge frame
 *             categorizes SYSTEM_TRIGGER instead of MULTIMODAL_INPUT — the intended
 *             dominance of the nudge bit.
 * Non-goals (confirmed unnecessary): NO processInput signature change, NO new
 *             'scene' modality, NO new InputCategory enum value.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { ProcessInputService, type InputCategory } from './process-input.service';
import { TickSamplerService } from '../inputs/sampling/tick-sampler';
import { SensoryFusionService } from '../inputs/fusion/sensory-fusion';
import { ModalityRegistryService } from '../inputs/registry/modality-registry.service';
import { SceneEncoder } from '../inputs/encoders/scene.encoder';
import {
  DRIVE_INDEX_ORDER,
  SceneEventType,
  type SceneSnapshot,
  type SensoryFrame,
  type DriveSnapshot,
  type DriveName,
} from '@sylphie/shared';

jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return { ...actual, verboseFor: () => () => {} };
});

// ---------------------------------------------------------------------------
// Constants mirrored from the proposed production contract (documented above).
// ---------------------------------------------------------------------------

/** The carrier key stamped on frame.raw to promote a sceneNudge to SYSTEM_TRIGGER. */
const SYSTEM_TRIGGER_KEY = 'system_trigger';

// ---------------------------------------------------------------------------
// Live wiring helpers — real services, no mocks of the path under test.
// ---------------------------------------------------------------------------

/**
 * Build a TickSamplerService backed by the REAL fusion + registry + scene encoder.
 * Only the `scene` modality is registered so the fused frame is driven entirely by
 * scene — isolating the carrier/no-drop mechanism from unrelated modalities.
 */
function buildLiveSampler(): TickSamplerService {
  const registry = new ModalityRegistryService();
  const sceneEncoder = new SceneEncoder(registry);
  sceneEncoder.onModuleInit(); // self-registers 'scene' with the registry
  const fusion = new SensoryFusionService(registry);
  return new TickSamplerService(fusion, registry);
}

/** ProcessInputService with all (@Optional) deps null — exercises categorize/extract. */
function buildProcessInput(): ProcessInputService {
  return new ProcessInputService(null, null, null);
}

/** Minimal DriveSnapshot — processInput only reads pressureVector. */
function makeSnapshot(dominant: DriveName = DRIVE_INDEX_ORDER[0]): DriveSnapshot {
  const pressureVector: Record<string, number> = {};
  for (const d of DRIVE_INDEX_ORDER) pressureVector[d] = 0;
  pressureVector[dominant] = 1;
  return { pressureVector } as unknown as DriveSnapshot;
}

/** A SceneSnapshot with one confirmed 'cup' object — a salient, calm scene. */
function makeSceneWithConfirmedCup(): SceneSnapshot {
  return {
    timestamp: 1,
    frameSequence: 1,
    objects: [
      {
        trackId: 1,
        state: 'confirmed',
        label: 'cup',
        confidence: 0.9,
        bbox: [10, 10, 50, 50],
        framesSeen: 5,
        framesLost: 0,
        firstSeenAt: null,
        lastSeenAt: null,
        embedding: null,
      },
    ],
    events: [
      {
        type: SceneEventType.OBJECT_APPEARED,
        trackId: 1,
        label: 'cup',
        confidence: 0.9,
        bbox: [10, 10, 50, 50],
        timestamp: 1,
      },
    ],
    summary: {
      totalTracks: 1,
      confirmedCount: 1,
      lostCount: 0,
      newCount: 1,
      frameSequence: 1,
    },
  };
}

/**
 * The PROPOSED categorizeFrame branch, applied as a thin wrapper over the REAL
 * categorization. This mirrors the documented contract exactly — a
 * `system_trigger === true` check placed FIRST — so the spike proves the branch
 * is sufficient WITHOUT mutating production. The fallthrough delegates to the
 * real ProcessInputService via its public processInput (which calls the real
 * private categorizeFrame), so everything below the new branch is live code.
 */
function proposedCategorize(
  svc: ProcessInputService,
  frame: SensoryFrame,
  snapshot: DriveSnapshot,
): Promise<{ category: InputCategory; entities: readonly string[] }> {
  // Proposed FIRST branch — the one-line promotion.
  if (frame.raw[SYSTEM_TRIGGER_KEY] === true) {
    // Still run the real processInput so we can assert scene entities survive the
    // promotion (extractEntities is category-independent — process-input.service.ts:284).
    return svc
      .processInput(frame, snapshot)
      .then((r) => ({ category: 'SYSTEM_TRIGGER' as InputCategory, entities: r.entities }));
  }
  return svc
    .processInput(frame, snapshot)
    .then((r) => ({ category: r.inputCategory, entities: r.entities }));
}

// ---------------------------------------------------------------------------
// Spike
// ---------------------------------------------------------------------------

describe('TK-19 POC — sceneNudge -> SYSTEM_TRIGGER carrier feasibility (live path)', () => {
  it('(a) RECOMMENDED: a post-sample frame.raw stamp survives the REAL sample() with scene intact', async () => {
    const sampler = buildLiveSampler();
    sampler.updateScene(makeSceneWithConfirmedCup());

    // Live sample() — EWMA blend + rolling-window push (exactly the runCycleForTurn path).
    const frame = await sampler.sample();

    // Stamp the carrier POST-sample, identical to the frame.raw['turn_id'] precedent.
    (frame.raw as Record<string, unknown>)[SYSTEM_TRIGGER_KEY] = true;

    // Carrier is readable...
    expect(frame.raw[SYSTEM_TRIGGER_KEY]).toBe(true);
    // ...AND the scene data the nudge exists to deliver is still present.
    expect(frame.raw['scene']).toBeDefined();
    expect((frame.raw['scene'] as SceneSnapshot).objects[0].label).toBe('cup');
    expect(frame.active_modalities).toContain('scene');
  });

  it('(b) ALTERNATIVE: a pre-sample tick-sampler slot also survives fuse()+sample() into frame.raw', async () => {
    const sampler = buildLiveSampler();
    sampler.updateScene(makeSceneWithConfirmedCup());
    // 'system_trigger' has no encoder -> fuse() passes it through (sensory-fusion.ts:154-158).
    sampler.update(SYSTEM_TRIGGER_KEY, true);

    const frame = await sampler.sample();

    expect(frame.raw[SYSTEM_TRIGGER_KEY]).toBe(true);
    expect(frame.raw['scene']).toBeDefined();
    expect((frame.raw['scene'] as SceneSnapshot).objects[0].label).toBe('cup');
  });

  it('the carrier survives the EWMA blend across multiple ticks (re-stamped per cycle)', async () => {
    const sampler = buildLiveSampler();
    sampler.updateScene(makeSceneWithConfirmedCup());

    // First tick initializes the EWMA accumulator; second blends — neither touches raw.
    await sampler.sample();
    const frame = await sampler.sample();
    (frame.raw as Record<string, unknown>)[SYSTEM_TRIGGER_KEY] = true;

    expect(frame.raw[SYSTEM_TRIGGER_KEY]).toBe(true);
    expect(frame.raw['scene']).toBeDefined();
  });

  it('the proposed categorizeFrame branch returns SYSTEM_TRIGGER WITHOUT dropping scene entities', async () => {
    const sampler = buildLiveSampler();
    const processInput = buildProcessInput();
    sampler.updateScene(makeSceneWithConfirmedCup());

    const frame = await sampler.sample();
    (frame.raw as Record<string, unknown>)[SYSTEM_TRIGGER_KEY] = true;

    const { category, entities } = await proposedCategorize(processInput, frame, makeSnapshot());

    // Promotion: the nudge bit dominates -> SYSTEM_TRIGGER (a valid InputCategory).
    expect(category).toBe('SYSTEM_TRIGGER');
    // No-drop: the REAL extractEntities still surfaced the confirmed scene object.
    expect(entities).toContain('cup');
  });

  it('regression guard: WITHOUT the marker, the SAME scene frame is categorized by the real path unchanged (no false promotion)', async () => {
    const sampler = buildLiveSampler();
    const processInput = buildProcessInput();
    sampler.updateScene(makeSceneWithConfirmedCup());

    const frame = await sampler.sample(); // no system_trigger stamp

    const { category, entities } = await proposedCategorize(processInput, frame, makeSnapshot());

    // The promotion fires ONLY when the carrier is present. Without it, the real
    // categorizeFrame is untouched: a lone 'scene' modality matches none of the
    // text/audio/video branches today, so it stays UNKNOWN — proving the marker,
    // not the scene presence, is what drives the SYSTEM_TRIGGER promotion.
    expect(category).toBe('UNKNOWN');
    expect(category).not.toBe('SYSTEM_TRIGGER');
    expect(entities).toContain('cup'); // scene entities extracted regardless of category
  });
});
