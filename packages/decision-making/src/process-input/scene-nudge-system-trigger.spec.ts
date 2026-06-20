/**
 * Wiring test for P4.2 / TK-21 acceptance criterion AC3.
 *
 * AC3 — Given a salient-but-calm frame on a drive-cold backend, when the
 * sceneNudge fires, then a SYSTEM_TRIGGER cycle is still enqueued and runs
 * (trigger independent of drive pressure).
 *
 * Why this lives at the CycleGuard level: the only drive-pressure gate in the
 * decision loop is the SELF-TICK path (onTick → IDLE_PRESSURE_THRESHOLD=4.0).
 * The sceneNudge path deliberately bypasses that gate — it enqueues an
 * originator-less turn straight into the CycleGuard, which has NO pressure
 * check. This test stands up the real CycleGuardService and a cycle runner that
 * reproduces the stamp-then-categorize seam from
 * DecisionMakingService.runCycleForTurn (stamp frame.raw['system_trigger']=true
 * on a sceneNudge turn, then categorize via the real ProcessInputService),
 * proving the cycle RUNS and yields SYSTEM_TRIGGER even when total drive
 * pressure is 0.0 (drive-cold).
 */

import { CycleGuardService } from '../concurrency/cycle-guard.service';
import type { InboundTurn } from '../concurrency/inbound-turn';
import { ProcessInputService } from './process-input.service';
import {
  EMBEDDING_DIM,
  DRIVE_INDEX_ORDER,
  type SensoryFrame,
  type DriveSnapshot,
} from '@sylphie/shared';

jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return { ...actual, verboseFor: () => () => {} };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A drive-COLD snapshot: every drive at 0.0, total pressure 0.0. */
function coldSnapshot(): DriveSnapshot {
  const pressureVector: Record<string, number> = {};
  for (const d of DRIVE_INDEX_ORDER) pressureVector[d] = 0;
  return { pressureVector, totalPressure: 0 } as unknown as DriveSnapshot;
}

/** A salient-but-calm visual frame (video + scene, no human text/audio). */
function salientCalmFrame(): SensoryFrame {
  return {
    timestamp: 1,
    fused_embedding: new Array(EMBEDDING_DIM).fill(0),
    modality_embeddings: {},
    active_modalities: ['video', 'scene'],
    raw: { video: { detections: [] } },
  };
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('sceneNudge → SYSTEM_TRIGGER cycle on a drive-cold backend (AC3)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('enqueues and runs a SYSTEM_TRIGGER cycle independent of drive pressure', async () => {
    const processInput = new ProcessInputService(null, null, null);

    const ran: Array<{ turnId: string; category: string }> = [];
    const guard = new CycleGuardService(null);
    // Executor is IDLE (drive-cold, nothing else running).
    const mockExecutor = { getState: () => 'IDLE', forceIdle: jest.fn() };

    guard.register(
      // Cycle runner — reproduces the runCycleForTurn stamp-then-process seam.
      async (turn: InboundTurn, _epoch: number): Promise<boolean> => {
        const frame = salientCalmFrame();
        // The exact stamp runCycleForTurn applies for a sceneNudge turn.
        if (turn.sceneNudge) {
          (frame.raw as Record<string, unknown>)['system_trigger'] = true;
        }
        const result = await processInput.processInput(frame, coldSnapshot());
        ran.push({ turnId: turn.turnId, category: result.inputCategory });
        return true;
      },
      (_turnId, _msg, _epoch) => {},
      mockExecutor as any,
    );

    // The exogenous scene-change turn: no originator, no text, sceneNudge=true.
    const nudge: InboundTurn = {
      turnId: 'scene-nudge-1',
      isGuardian: false,
      receivedAt: Date.now(),
      enqueuedAt: Date.now(),
      text: '',
      sceneNudge: true,
    };
    guard.enqueue(nudge);

    // Drain the queue.
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    }

    // The cycle RAN (trigger fired despite 0.0 total drive pressure) ...
    expect(ran).toHaveLength(1);
    expect(ran[0]?.turnId).toBe('scene-nudge-1');
    // ... and it was categorized as a SYSTEM_TRIGGER.
    expect(ran[0]?.category).toBe('SYSTEM_TRIGGER');

    guard.destroy();
  });
});
