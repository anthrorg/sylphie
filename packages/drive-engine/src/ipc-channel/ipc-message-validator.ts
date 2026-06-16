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
  // OPTIONAL correlation id for end-to-end provenance (CANON Standard 2).
  // If absent, the Drive Engine derives a deterministic id from actionId.
  correlationId: z.string().optional(),
  actionType: z.string(),
  outcome: z.enum(['positive', 'negative']),
  // Signal metadata — the drive engine computes effects from these signals.
  // No driveEffects field: the main process sends what happened, the drive
  // engine decides what it means using its internal rule system.
  metadata: z.object({
    undiscoveredObjectCount: z.number().int().min(0).optional(),
    unknownPersonCount: z.number().int().min(0).optional(),
    sensoryPredictionError: z.number().min(0).max(1).optional(),
    sceneSurprise: z.number().min(0).max(1).optional(),
    guardianTeachingDrive: DriveNameSchema.optional(),
  }).optional(),
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
  // Optional fields that the reporter may include
  predictionData: z.object({
    predictionId: z.string(),
    predictedValue: z.number(),
    actualValue: z.number(),
  }).optional(),
  // Constrained informationGainMetrics — closes the "arbitrary numbers" hole
  // (Ticket 2 / §A.14). Counts must be non-negative; confidenceDeltas is a
  // non-negative sum; `source` carries the provenance the honesty gate checks.
  // Only source === 'WKG_DIFF' earns curiosity relief downstream.
  informationGainMetrics: z.object({
    newNodes: z.number().int().min(0),
    confidenceDeltas: z.number().min(0),
    resolvedErrors: z.number().int().min(0),
    source: z.enum(['WKG_DIFF', 'UNVERIFIED']),
  }).optional(),
  socialCommentTimestamp: z.number().optional(),
}).strict(); // CANON Std-6: reject any top-level field not declared above —
             // an injected `driveEffects` MUST hard-fail at the isolation
             // boundary, never silently pass through (was .passthrough()).

/**
 * SELF_ASSESSMENT payload validation (Ticket 1 — KG(Self) self-evaluation).
 *
 * A KG(Self) snapshot pushed by MAIN. Cached by the Drive Engine and judged on
 * its own self-eval cadence. This is NOT an outcome — no actionId, no theater
 * check, no reinforcement. Ranges per CANON; dates coerced.
 *
 * Std-3 ceiling clamp and provenance-based reduction suppression are applied in
 * the reader (CachedSelfKgReader), not here — the validator only shape-checks.
 */
const SelfAssessmentPayloadSchema = z.object({
  assessedAt: z.coerce.date(),
  capabilities: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      successRate: z.number().min(0).max(1),
      confidence: z.number().min(0).max(1),
      sampleCount: z.number().int().min(0),
      lastExecuted: z.coerce.date(),
    }),
  ),
  drivePatterns: z.array(
    z.object({
      drive: DriveNameSchema,
      stimulus: z.string(),
      responseStrength: z.number().min(0).max(1),
      examples: z.array(z.string()),
      lastObserved: z.coerce.date(),
      confidence: z.number().min(0).max(1),
    }),
  ),
  predictionAccuracy: z.array(
    z.object({
      domain: z.string(),
      mae: z.number(),
      sampleCount: z.number().int().min(0),
      confidence: z.number().min(0).max(1),
      lastUpdated: z.coerce.date(),
    }),
  ),
  provenance: z.enum([
    'GUARDIAN',
    'GUARDIAN_APPROVED_INFERENCE',
    'INFERENCE',
    'SYSTEM_BOOTSTRAP',
  ]),
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
  correlationId: z.string().nullable(),
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
 * THEATER_PROHIBITED payload validation (CANON Standard 1).
 *
 * Validates the audit-trail record for a theatrical expression that was
 * zero-reinforced. AUDIT ONLY — never feeds reinforcement.
 */
const TheaterProhibitedPayloadSchema = z.object({
  actionId: z.string().min(1),
  correlationId: z.string().nullable(),
  actionType: z.string(),
  offendingExpressionType: z.enum(['pressure', 'relief']),
  drive: DriveNameSchema,
  expectedThreshold: z.number(),
  actualDriveValue: z.number().min(-10.0).max(1.0),
  verdictReason: z.string(),
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
  DriveIPCMessageEnvelopeSchema.extend({
    type: z.literal(DriveIPCMessageType.SELF_ASSESSMENT),
    payload: SelfAssessmentPayloadSchema,
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
    type: z.literal(DriveIPCMessageType.THEATER_PROHIBITED),
    payload: TheaterProhibitedPayloadSchema,
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
