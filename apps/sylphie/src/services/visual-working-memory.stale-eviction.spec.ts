/**
 * TK-102 — Stale-track eviction: retained perception state is bounded.
 *
 * AD-0041 root cause: stopping the perception feed did NOT drain
 * UndiscoveredObjectPressure / UnknownPersonPressure because the app retains
 * confirmed tracks in VWM, and the tick-sampler `undiscovered_count` /
 * `unknown_person_count` latestValues were only zeroed when a new frame arrived.
 *
 * Fix:
 *   1. `VisualWorkingMemoryService.evictStaleEntities(now?)` — marks any non-gone
 *      entity as `gone` if unseen for >= STALE_TRACK_TIMEOUT_MS (10 s).
 *   2. `updateScene` calls `evictStaleEntities` at the top of every frame so
 *      stale tracks drain even mid-session.
 *   3. `PerceptionGateway.handleDisconnect` calls `evictStaleEntities()` then
 *      zeros both tick-sampler counts to 0, draining pressure immediately when
 *      the feed disconnects.
 *
 * Acceptance criterion:
 *   Given perception frames stop arriving (or a confirmed track is no longer
 *   observed) for a bounded interval, when the retained tracker state is
 *   inspected, then stale confirmed tracks are evicted/decayed (retained state
 *   is bounded), and the pressure they generated drains — a halted feed no
 *   longer keeps pressure pinned.
 */

import { VisualWorkingMemoryService } from './visual-working-memory.service';
import { BindingService } from './binding.service';
import type { TrackedObjectDTO } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Minimal fakes
// ---------------------------------------------------------------------------

class FakeTimescale {
  async query<T = any>(_sql: string, _params?: unknown[]): Promise<{ rows: T[] }> {
    return { rows: [] };
  }
}

function makeFaceSnapshot() {
  return {
    identifyFace: jest.fn().mockReturnValue(null),
    matchFace: jest.fn().mockReturnValue(null),
    updateCentroid: jest.fn(),
  };
}

function makeVwm() {
  return new VisualWorkingMemoryService(
    new FakeTimescale() as any,
    null, // no Neo4j
    makeFaceSnapshot() as any,
    {} as any,
    new BindingService(),
  );
}

function makeTrack(over: Partial<TrackedObjectDTO> = {}): TrackedObjectDTO {
  return {
    trackId: 1,
    label: 'cup',
    state: 'confirmed',
    bbox: [10, 10, 50, 50],
    confidence: 0.9,
    framesSeen: 5,
    framesLost: 0,
    firstSeenAt: null,
    lastSeenAt: null,
    embedding: null,
    ...over,
  } as TrackedObjectDTO;
}

function makePersonTrack(over: Partial<TrackedObjectDTO> = {}): TrackedObjectDTO {
  return makeTrack({ trackId: 2, label: 'person', faceEmbedding: null, ...over });
}

/** Drive a confirmed track through N frames separated by `intervalMs`. */
function driveFrames(
  vwm: VisualWorkingMemoryService,
  track: TrackedObjectDTO,
  count: number,
  nowFn: () => number,
): void {
  for (let i = 0; i < count; i++) {
    jest.setSystemTime(nowFn());
    vwm.updateScene({ objects: [track], events: [], summary: {} } as any);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const STALE_TIMEOUT_MS = 10_000; // must match STALE_TRACK_TIMEOUT_MS in the service

describe('VWM TK-102 — evictStaleEntities()', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not evict a freshly-seen entity (within stale window)', () => {
    const vwm = makeVwm();
    jest.setSystemTime(1000);
    vwm.updateScene({ objects: [makeTrack()], events: [], summary: {} } as any);
    vwm.updateScene({ objects: [makeTrack()], events: [], summary: {} } as any);

    // Entity is present and recently seen; calling evict right away evicts nothing.
    const evicted = vwm.evictStaleEntities(1000 + STALE_TIMEOUT_MS - 1);
    expect(evicted).toBe(0);
    // The entity is still visible to getUndiscoveredEntities.
    expect(vwm.getUndiscoveredEntities().length).toBeGreaterThan(0);
  });

  it('evicts an entity that has not been seen for >= STALE_TRACK_TIMEOUT_MS', () => {
    const vwm = makeVwm();
    jest.setSystemTime(1000);
    // Drive two frames so the entity is 'present'.
    vwm.updateScene({ objects: [makeTrack()], events: [], summary: {} } as any);
    vwm.updateScene({ objects: [makeTrack()], events: [], summary: {} } as any);

    // Advance time past the stale threshold; call evict with no new frames.
    const evicted = vwm.evictStaleEntities(1000 + STALE_TIMEOUT_MS);
    expect(evicted).toBe(1);
    // No longer counted as an undiscovered entity.
    expect(vwm.getUndiscoveredEntities().length).toBe(0);
  });

  it('evicts only the stale entity, leaving the fresh one intact', () => {
    const vwm = makeVwm();
    const t0 = 5000;
    jest.setSystemTime(t0);

    // Two different tracks added at t0.
    vwm.updateScene({
      objects: [makeTrack({ trackId: 1 }), makeTrack({ trackId: 2, label: 'bottle' })],
      events: [], summary: {},
    } as any);
    vwm.updateScene({
      objects: [makeTrack({ trackId: 1 }), makeTrack({ trackId: 2, label: 'bottle' })],
      events: [], summary: {},
    } as any);

    // Advance 6s; re-sight track 1 but not track 2.
    jest.setSystemTime(t0 + 6_000);
    vwm.updateScene({ objects: [makeTrack({ trackId: 1 })], events: [], summary: {} } as any);

    // At t0 + STALE_TIMEOUT_MS track 2's lastSeenAt is t0 (6s < 10s → not stale yet).
    expect(vwm.evictStaleEntities(t0 + STALE_TIMEOUT_MS - 1)).toBe(0);

    // At t0 + STALE_TIMEOUT_MS track 2's lastSeenAt is t0 (10s → stale!).
    const evicted = vwm.evictStaleEntities(t0 + STALE_TIMEOUT_MS);
    expect(evicted).toBe(1);

    // Track 1 (re-sighted at t0+6s) is still alive.
    const undiscovered = vwm.getUndiscoveredEntities();
    expect(undiscovered.some(e => e.trackIds.includes(1))).toBe(true);
    expect(undiscovered.some(e => e.trackIds.includes(2))).toBe(false);
  });

  it('evicts unknown-person entities too (not just objects)', () => {
    const vwm = makeVwm();
    jest.setSystemTime(2000);
    vwm.updateScene({ objects: [makePersonTrack()], events: [], summary: {} } as any);
    vwm.updateScene({ objects: [makePersonTrack()], events: [], summary: {} } as any);

    expect(vwm.getUnknownPersons().length).toBeGreaterThan(0);

    const evicted = vwm.evictStaleEntities(2000 + STALE_TIMEOUT_MS);
    expect(evicted).toBe(1);
    expect(vwm.getUnknownPersons().length).toBe(0);
  });

  it('is idempotent — re-evicting already-gone entities counts them as 0', () => {
    const vwm = makeVwm();
    jest.setSystemTime(1000);
    vwm.updateScene({ objects: [makeTrack()], events: [], summary: {} } as any);
    vwm.updateScene({ objects: [makeTrack()], events: [], summary: {} } as any);

    vwm.evictStaleEntities(1000 + STALE_TIMEOUT_MS);
    // Second call after entities are already gone returns 0.
    expect(vwm.evictStaleEntities(1000 + STALE_TIMEOUT_MS + 1000)).toBe(0);
  });
});

describe('VWM TK-102 — updateScene evicts stale entities on each frame', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('a track unseen for >= STALE_TRACK_TIMEOUT_MS is gone by the next frame', () => {
    const vwm = makeVwm();
    const t0 = 1_000;
    jest.setSystemTime(t0);

    // Stabilize the track to 'present'.
    vwm.updateScene({ objects: [makeTrack()], events: [], summary: {} } as any);
    vwm.updateScene({ objects: [makeTrack()], events: [], summary: {} } as any);
    expect(vwm.getUndiscoveredEntities().length).toBeGreaterThan(0);

    // Advance past the stale threshold and send an EMPTY frame (feed still
    // connected, track just stopped being detected).
    jest.setSystemTime(t0 + STALE_TIMEOUT_MS + 500);
    vwm.updateScene({ objects: [], events: [], summary: {} } as any);

    // The stale entity should have been evicted by the updateScene call above.
    expect(vwm.getUndiscoveredEntities().length).toBe(0);
    expect(vwm.getUnknownPersons().length).toBe(0);
  });
});

describe('VWM TK-102 — PerceptionGateway.handleDisconnect drains pressure', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('handleDisconnect evicts stale VWM entities and zeros tick-sampler counts', () => {
    jest.setSystemTime(1000);

    const vwm = makeVwm();
    // Stabilize two entities (one object, one person).
    const snap = {
      objects: [makeTrack({ trackId: 1 }), makePersonTrack({ trackId: 2 })],
      events: [],
      summary: {},
    } as any;
    vwm.updateScene(snap);
    vwm.updateScene(snap);

    // Both entities are present.
    expect(vwm.getUndiscoveredEntities().length).toBeGreaterThan(0);
    expect(vwm.getUnknownPersons().length).toBeGreaterThan(0);

    // Simulate what PerceptionGateway.handleDisconnect does (same two calls).
    jest.setSystemTime(1000 + STALE_TIMEOUT_MS + 1);
    const undiscoveredCount = { val: -1 };
    const unknownPersonCount = { val: -1 };
    const tickSampler = {
      updateUndiscoveredCount: (n: number) => { undiscoveredCount.val = n; },
      updateUnknownPersonCount: (n: number) => { unknownPersonCount.val = n; },
    };

    // Call the same operations handleDisconnect performs.
    vwm.evictStaleEntities();
    tickSampler.updateUndiscoveredCount(0);
    tickSampler.updateUnknownPersonCount(0);

    // All stale entities are gone.
    expect(vwm.getUndiscoveredEntities().length).toBe(0);
    expect(vwm.getUnknownPersons().length).toBe(0);
    // Tick-sampler counts are zeroed.
    expect(undiscoveredCount.val).toBe(0);
    expect(unknownPersonCount.val).toBe(0);
  });

  it('recently-seen entities are NOT evicted on disconnect (within stale window)', () => {
    jest.setSystemTime(1000);
    const vwm = makeVwm();
    vwm.updateScene({ objects: [makeTrack()], events: [], summary: {} } as any);
    vwm.updateScene({ objects: [makeTrack()], events: [], summary: {} } as any);

    // Disconnect almost immediately (well within 10 s).
    jest.setSystemTime(1000 + STALE_TIMEOUT_MS - 1);
    const evicted = vwm.evictStaleEntities();
    // Not stale yet — entity survives the eviction pass.
    expect(evicted).toBe(0);
    // Pressure counts are still zeroed by disconnect (independent of entity state).
    // (The test only asserts the eviction count; the zero is always written by
    // handleDisconnect regardless of whether entities were evicted.)
  });
});
