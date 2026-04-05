/**
 * IPC message validation using Zod schemas.
 *
 * Validates all inbound and outbound DriveIPCMessage payloads at the IPC
 * boundary. Malformed messages are rejected with detailed error information.
 *
 * CANON §Drive Isolation: All messages crossing the process boundary must
 * be validated to prevent accidentally accepting corrupted or malicious data.
 */

import { z } from 'zod';
import { DriveIPCMessageType } from '@sylphie/shared';
import { DriveName } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Drive Name Enum Validation
// ---------------------------------------------------------------------------

const DriveNameSchema = z.nativeEnum(DriveName);

// ---------------------------------------------------------------------------
// Inbound Message Payloads
// ---------------------------------------------------------------------------

/**
 * ACTION_OUTCOME payload validation.
 *
 * Validates:
 *   - actionId is required (CANON Standard 2)
 *   - feedbackSource is required (CANON Standard 5)
 *   - theaterCheck is required (CANON Standard 1)
 *   - driveEffects are partial records with numeric values in [-10.0, 1.0]
 *   - anxietyAtExecution is in [-10.0, 1.0]
 */
const ActionOutcomePayloadSchema = z.object({
  actionId: z.string().min(1, 'actionId is required'),
  actionType: z.string(),
  outcome: z.enum(['positive', 'negative']),
  driveEffects: z.record(DriveNameSchema, z.number().min(-10.0).max(1.0)),
  feedbackSource: z.enum([
    'guardian_confirmation',
    'guardian_correction',
    'algorithmic',
  ]),
  theaterCheck: z.object({
    expressionType: z.enum(['pressure', 'relief', 'none']),
    driveValueAtExpression: z.number().min(-10.0).max(1.0),
    drive: DriveNameSchema,
    isTheatrical: z.boolean(),
  }),
  anxietyAtExecution: z.number().min(-10.0).max(1.0),
});

/**
 * SOFTWARE_METRICS payload validation.
 *
 * Validates:
 *   - llmCallCount and tokenCount are non-negative integers
 *   - llmLatencyMs and estimatedCostUsd are non-negative numbers
 *   - cognitiveEffortPressure is in [0.0, 1.0]
 *   - windowStartAt and windowEndAt are valid dates
 */
const SoftwareMetricsPayloadSchema = z.object({
  llmCallCount: z.number().int().min(0),
  llmLatencyMs: z.number().min(0),
  cognitiveEffortPressure: z.number().min(0).max(1.0),
  tokenCount: z.number().int().min(0),
  estimatedCostUsd: z.number().min(0),
  windowStartAt: z.coerce.date(),
  windowEndAt: z.coerce.date(),
});

/**
 * SESSION_START payload validation.
 *
 * Validates:
 *   - sessionId is a non-empty string
 *   - initialDriveState is a valid DriveSnapshot
 */
const SessionStartPayloadSchema = z.object({
  sessionId: z.string().min(1),
  initialDriveState: z.object({
    pressureVector: z.record(
      DriveNameSchema,
      z.number().min(-10.0).max(1.0),
    ),
    timestamp: z.coerce.date(),
    tickNumber: z.number().int().min(0),
    driveDeltas: z.record(DriveNameSchema, z.number()),
    ruleMatchResult: z.object({
      ruleId: z.string().nullable(),
      eventType: z.string(),
      matched: z.boolean(),
    }),
    totalPressure: z.number().min(0).max(12.0),
    sessionId: z.string(),
  }),
});

/**
 * SESSION_END payload validation.
 *
 * Validates:
 *   - sessionId is a non-empty string
 *   - durationMs is a non-negative integer
 */
const SessionEndPayloadSchema = z.object({
  sessionId: z.string().min(1),
  durationMs: z.number().int().min(0),
});

// ---------------------------------------------------------------------------
// Outbound Message Payloads
// ---------------------------------------------------------------------------

/**
 * DRIVE_SNAPSHOT payload validation.
 *
 * Validates the full DriveSnapshot structure returned by the Drive Engine.
 */
const DriveSnapshotPayloadSchema = z.object({
  snapshot: z.object({
    pressureVector: z.record(
      DriveNameSchema,
      z.number().min(-10.0).max(1.0),
    ),
    timestamp: z.coerce.date(),
    tickNumber: z.number().int().min(0),
    driveDeltas: z.record(DriveNameSchema, z.number()),
    ruleMatchResult: z.object({
      ruleId: z.string().nullable(),
      eventType: z.string(),
      matched: z.boolean(),
    }),
    totalPressure: z.number().min(0).max(12.0),
    sessionId: z.string(),
  }),
});

/**
 * OPPORTUNITY_CREATED payload validation.
 *
 * Validates:
 *   - id is a UUID v4 string
 *   - contextFingerprint is non-empty
 *   - classification is a valid OpportunityClassification
 *   - priority is 'HIGH' | 'MEDIUM' | 'LOW'
 *   - affectedDrive is a valid DriveName
 */
const OpportunityCreatedPayloadSchema = z.object({
  id: z.string().uuid(),
  contextFingerprint: z.string().min(1),
  classification: z.enum([
    'PREDICTION_FAILURE_PATTERN',
    'HIGH_IMPACT_ONE_OFF',
    'BEHAVIORAL_NARROWING',
    'GUARDIAN_TEACHING',
  ]),
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  sourceEventId: z.string(),
  affectedDrive: DriveNameSchema,
});

/**
 * DRIVE_EVENT payload validation.
 *
 * Validates:
 *   - driveEventType is a valid event type
 *   - drive is a valid DriveName
 *   - delta is a number
 *   - ruleId is nullable string
 *   - snapshot is a valid DriveSnapshot
 */
const DriveEventPayloadSchema = z.object({
  driveEventType: z.enum([
    'DRIVE_RELIEF',
    'DRIVE_RULE_APPLIED',
    'OPPORTUNITY_DETECTED',
    'SELF_EVALUATION_RUN',
  ]),
  drive: DriveNameSchema,
  delta: z.number(),
  ruleId: z.string().nullable(),
  snapshot: z.object({
    pressureVector: z.record(
      DriveNameSchema,
      z.number().min(-10.0).max(1.0),
    ),
    timestamp: z.coerce.date(),
    tickNumber: z.number().int().min(0),
    driveDeltas: z.record(DriveNameSchema, z.number()),
    ruleMatchResult: z.object({
      ruleId: z.string().nullable(),
      eventType: z.string(),
      matched: z.boolean(),
    }),
    totalPressure: z.number().min(0).max(12.0),
    sessionId: z.string(),
  }),
});

/**
 * HEALTH_STATUS payload validation.
 *
 * Validates:
 *   - healthy is boolean
 *   - currentTick is non-negative integer
 *   - msSinceLastTick is non-negative integer
 *   - diagnosticMessage is nullable string
 */
const HealthStatusPayloadSchema = z.object({
  healthy: z.boolean(),
  currentTick: z.number().int().min(0),
  msSinceLastTick: z.number().int().min(0),
  diagnosticMessage: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Generic Message Envelope
// ---------------------------------------------------------------------------

const DriveIPCMessageEnvelopeSchema = z.object({
  type: z.nativeEnum(DriveIPCMessageType),
  timestamp: z.coerce.date(),
});

// ---------------------------------------------------------------------------
// Message Routing and Validation
// ---------------------------------------------------------------------------

/**
 * Combined validation schema for all possible inbound messages (main → child).
 */
const InboundMessageSchema = z.union([
  DriveIPCMessageEnvelopeSchema.extend({
    type: z.literal(DriveIPCMessageType.ACTION_OUTCOME),
    payload: ActionOutcomePayloadSchema,
  }),
  DriveIPCMessageEnvelopeSchema.extend({
    type: z.literal(DriveIPCMessageType.SOFTWARE_METRICS),
    payload: SoftwareMetricsPayloadSchema,
  }),
  DriveIPCMessageEnvelopeSchema.extend({
    type: z.literal(DriveIPCMessageType.SESSION_START),
    payload: SessionStartPayloadSchema,
  }),
  DriveIPCMessageEnvelopeSchema.extend({
    type: z.literal(DriveIPCMessageType.SESSION_END),
    payload: SessionEndPayloadSchema,
  }),
]);

/**
 * Combined validation schema for all possible outbound messages (child → main).
 */
const OutboundMessageSchema = z.union([
  DriveIPCMessageEnvelopeSchema.extend({
    type: z.literal(DriveIPCMessageType.DRIVE_SNAPSHOT),
    payload: DriveSnapshotPayloadSchema,
  }),
  DriveIPCMessageEnvelopeSchema.extend({
    type: z.literal(DriveIPCMessageType.OPPORTUNITY_CREATED),
    payload: OpportunityCreatedPayloadSchema,
  }),
  DriveIPCMessageEnvelopeSchema.extend({
    type: z.literal(DriveIPCMessageType.DRIVE_EVENT),
    payload: DriveEventPayloadSchema,
  }),
  DriveIPCMessageEnvelopeSchema.extend({
    type: z.literal(DriveIPCMessageType.HEALTH_STATUS),
    payload: HealthStatusPayloadSchema,
  }),
]);

// ---------------------------------------------------------------------------
// Public Validator Functions
// ---------------------------------------------------------------------------

/**
 * Validate an inbound message (main process → Drive Engine).
 *
 * @param message - The message to validate
 * @throws {z.ZodError} If validation fails
 * @returns The validated message
 */
export function validateInboundMessage(message: unknown) {
  return InboundMessageSchema.parse(message);
}

/**
 * Validate an outbound message (Drive Engine → main process).
 *
 * @param message - The message to validate
 * @throws {z.ZodError} If validation fails
 * @returns The validated message
 */
export function validateOutboundMessage(message: unknown) {
  return OutboundMessageSchema.parse(message);
}

/**
 * Safe validation that returns a result instead of throwing.
 * Useful for logging validation errors without crashing.
 *
 * @param message - The message to validate
 * @param direction - 'inbound' or 'outbound' for error reporting
 * @returns { success: true, data: message } or { success: false, error: string }
 */
export function safeValidateMessage(
  message: unknown,
  direction: 'inbound' | 'outbound',
): { success: true; data: any } | { success: false; error: string } {
  try {
    const schema =
      direction === 'inbound' ? InboundMessageSchema : OutboundMessageSchema;
    const data = schema.parse(message);
    return { success: true, data };
  } catch (error) {
    let errorMsg: string;
    if (error instanceof z.ZodError) {
      errorMsg = error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
    } else {
      errorMsg = String(error);
    }
    return { success: false, error: errorMsg };
  }
}
