/**
 * Telemetry adapter — Sylphie-native DriveSnapshot → CoBeing_DriveFrame.
 *
 * Converts the internal DriveSnapshot (camelCase drive names, structured
 * PressureVector) to the flat snake_case CoBeing_DriveFrame format expected
 * by co-being React frontends connecting with `?protocol=cobeing-v1`.
 *
 * This is a pure transformation layer. It carries no drive computation logic,
 * applies no confidence ceilings, and does not assign provenance. Drive values
 * are passed through unchanged; only the shape and field names differ.
 *
 * CANON §Drive Isolation: This adapter is read-only. It reads from DriveSnapshot
 * and produces an output frame. It never mutates drive state.
 *
 * CANON §Theater Prohibition: The `state` field defaults to 'idle' because
 * Decision Making state is not yet surfaced in DriveSnapshot. When that
 * integration is complete the default must be replaced with actual state data.
 */

import type { DriveSnapshot } from '../../shared/types/drive.types';
import { DriveName } from '../../shared/types/drive.types';
import type { CoBeing_DriveFrame } from './cobeing-types';

/**
 * Canonical mapping from DriveName (camelCase) to the snake_case pressure key
 * required by CoBeing_DriveFrame.pressure. Defined as a const map so that
 * TypeScript can enforce exhaustiveness at the call site and future rename
 * refactors are caught by the compiler.
 */
const DRIVE_NAME_TO_SNAKE: Readonly<
  Record<DriveName, keyof CoBeing_DriveFrame['pressure']>
> = {
  [DriveName.SystemHealth]: 'system_health',
  [DriveName.MoralValence]: 'moral_valence',
  [DriveName.Integrity]: 'integrity',
  [DriveName.CognitiveAwareness]: 'cognitive_awareness',
  [DriveName.Guilt]: 'guilt',
  [DriveName.Curiosity]: 'curiosity',
  [DriveName.Boredom]: 'boredom',
  [DriveName.Anxiety]: 'anxiety',
  [DriveName.Satisfaction]: 'satisfaction',
  [DriveName.Sadness]: 'sadness',
  [DriveName.InformationIntegrity]: 'information_integrity',
  [DriveName.Social]: 'social',
} as const;

/**
 * Transform a Sylphie-native DriveSnapshot into a CoBeing_DriveFrame.
 *
 * Converts the PressureVector's camelCase drive names to snake_case and
 * flattens them into the `pressure` sub-object. Fields the co-being frontend
 * expects but DriveSnapshot does not yet carry (state, category, action,
 * action_confidence, transition_count) are given safe, semantically neutral
 * defaults. These defaults must be replaced with real data when the Decision
 * Making subsystem exposes its current evaluation result.
 *
 * @param snapshot - The DriveSnapshot published by the Drive Engine tick.
 * @returns A CoBeing_DriveFrame ready to be serialised and sent over the wire.
 *
 * @throws Never. All DriveSnapshot fields used here are guaranteed non-null
 *   by the DriveSnapshot interface contract.
 */
export function adaptTelemetryFrame(snapshot: DriveSnapshot): CoBeing_DriveFrame {
  // Build the pressure object by iterating every DriveName in DRIVE_NAME_TO_SNAKE.
  // Casting through Record<string, number> during construction avoids the
  // TypeScript "object literal must specify all properties" error while still
  // being type-checked on the way out — the return type annotation on
  // CoBeing_DriveFrame['pressure'] enforces that every key is present.
  const pressure = {} as Record<keyof CoBeing_DriveFrame['pressure'], number>;

  for (const [driveName, snakeKey] of Object.entries(DRIVE_NAME_TO_SNAKE) as Array<
    [DriveName, keyof CoBeing_DriveFrame['pressure']]
  >) {
    pressure[snakeKey] = snapshot.pressureVector[driveName];
  }

  const nowMs = Date.now();

  return {
    type: 'executor_cycle',
    timestamp: nowMs,
    pressure: pressure as CoBeing_DriveFrame['pressure'],
    pressure_metadata: {
      sequence_number: snapshot.tickNumber,
      timestamp_ms: snapshot.timestamp instanceof Date ? snapshot.timestamp.getTime() : Number(snapshot.timestamp),
      is_stale: false,
    },
    // Decision Making state is not yet surfaced in DriveSnapshot.
    // These defaults are semantically neutral — 'idle' means no active
    // evaluation is in progress, which is the safest default for a frontend
    // that has not yet received real state data.
    state: 'idle',
    category: null,
    action: null,
    action_confidence: null,
    transition_count: 0,
    cycle_count: snapshot.tickNumber,
  };
}
