/**
 * Unit tests for drive-event correlation-id propagation and DRIVE_EVENT audit
 * emission (Phase 4 Wave 2, cluster 3c — drive-engine audit/observability).
 *
 * Covers:
 *   1. resolveCorrelationId(): propagates an explicit inbound correlationId,
 *      derives a DETERMINISTIC id from actionId when absent, and returns null
 *      for non-action payloads (SOFTWARE_METRICS) — CANON Standard 2.
 *   2. End-to-end: an ACTION_OUTCOME with default-affect effects causes the
 *      engine to emit DRIVE_EVENT messages over the transport, each carrying
 *      the resolved correlationId so the relief is auditable end-to-end.
 *
 * The DRIVE_EVENT messages are the audit feed that the parent
 * (DriveProcessManagerService.writeDriveEvent) forwards to the TimescaleDB
 * `events` backbone (correlation_id column). This spec asserts the drive-side
 * emission; the parent-side persistence is exercised by the live smoke.
 */

import {
  DriveIPCMessage,
  DriveIPCMessageType,
  type ActionOutcomePayload,
  type SoftwareMetricsPayload,
} from '@sylphie/shared';
import { DriveEngine, resolveCorrelationId } from './drive-engine';
import type { IMessageTransport } from './message-transport';

// Suppress verbose logging during tests.
jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return { ...actual, verboseFor: () => () => {} };
});

/**
 * Fake transport: captures everything the engine sends and lets the test feed
 * inbound messages through the engine's registered handler.
 */
class FakeTransport implements IMessageTransport {
  public readonly sent: DriveIPCMessage<any>[] = [];
  private handler: ((msg: DriveIPCMessage<unknown>) => void) | null = null;

  send(message: DriveIPCMessage<any>): void {
    this.sent.push(message);
  }

  onMessage(handler: (msg: DriveIPCMessage<unknown>) => void): void {
    this.handler = handler;
  }

  feed(msg: DriveIPCMessage<unknown>): void {
    if (!this.handler) throw new Error('no handler registered');
    this.handler(msg);
  }
}

function makeOutcome(
  overrides: Partial<ActionOutcomePayload> = {},
): ActionOutcomePayload {
  return {
    actionId: 'act-123',
    actionType: 'ConversationalResponse',
    outcome: 'positive',
    feedbackSource: 'algorithmic',
    anxietyAtExecution: 0.1,
    theaterCheck: {
      expressionType: 'none',
      driveValueAtExpression: 0.5,
      drive: 'social' as any,
      isTheatrical: false,
    },
    ...overrides,
  };
}

describe('resolveCorrelationId (CANON Standard 2 — provenance)', () => {
  it('propagates an explicit inbound correlationId verbatim', () => {
    const id = resolveCorrelationId(
      makeOutcome({ correlationId: 'inbound-evt-777' }),
    );
    expect(id).toBe('inbound-evt-777');
  });

  it('derives a DETERMINISTIC id from actionId when correlationId is absent', () => {
    const id = resolveCorrelationId(makeOutcome({ actionId: 'act-abc' }));
    expect(id).toBe('action:act-abc');
    // Determinism: same action → same id (reconstructable from logs alone).
    expect(resolveCorrelationId(makeOutcome({ actionId: 'act-abc' }))).toBe(id);
  });

  it('returns null for non-action payloads (SOFTWARE_METRICS)', () => {
    const metrics: SoftwareMetricsPayload = {
      llmCallCount: 3,
      cognitiveEffortPressure: 0.05,
    } as SoftwareMetricsPayload;
    expect(resolveCorrelationId(metrics)).toBeNull();
  });
});

describe('DRIVE_EVENT emission carries the correlation id', () => {
  let transport: FakeTransport;
  let engine: DriveEngine;

  beforeEach(() => {
    transport = new FakeTransport();
    // Constructor seeds a full INITIAL_DRIVE_STATE state manager and registers
    // the inbound handler; no SESSION_START needed for these assertions.
    engine = new DriveEngine(transport);
  });

  function runTick(): void {
    // tick() is private and timer-driven; invoke it directly for determinism.
    (engine as any).tick();
  }

  it('emits DRIVE_EVENT messages stamped with the derived correlationId', () => {
    // Tick once so lastPublishedSnapshot is populated (required before the
    // engine will attach drive state to a DRIVE_EVENT).
    runTick();

    // Feed an action outcome with NO explicit correlationId → engine derives
    // `action:<actionId>` at the ingestion boundary.
    transport.feed({
      type: DriveIPCMessageType.ACTION_OUTCOME,
      payload: makeOutcome({ actionId: 'act-xyz' }),
      timestamp: new Date(),
    });

    // Tick again to drain + process the queued outcome.
    runTick();

    const driveEvents = transport.sent.filter(
      (m) => m.type === DriveIPCMessageType.DRIVE_EVENT,
    );
    expect(driveEvents.length).toBeGreaterThan(0);
    for (const evt of driveEvents) {
      expect(evt.payload.correlationId).toBe('action:act-xyz');
    }
  });

  it('propagates an explicit inbound correlationId onto emitted DRIVE_EVENTs', () => {
    runTick();

    transport.feed({
      type: DriveIPCMessageType.ACTION_OUTCOME,
      payload: makeOutcome({
        actionId: 'act-xyz',
        correlationId: 'inbound-evt-999',
      }),
      timestamp: new Date(),
    });

    runTick();

    const driveEvents = transport.sent.filter(
      (m) => m.type === DriveIPCMessageType.DRIVE_EVENT,
    );
    expect(driveEvents.length).toBeGreaterThan(0);
    for (const evt of driveEvents) {
      expect(evt.payload.correlationId).toBe('inbound-evt-999');
    }
  });
});
