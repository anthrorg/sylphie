/**
 * RESPONSE_GENERATED event payload builder.
 *
 * Extracted into its own decorator-free module so the mapping — including the
 * knowledge_retrieval telemetry source fields knowledgeGrounding + intent — is
 * unit-testable with tsx (esbuild) without importing the NestJS-decorated
 * CommunicationService (whose @Inject() parameter decorators esbuild rejects).
 *
 * CANON Std-1 (theater prohibition): the knowledge_retrieval self-model metric
 * reads these two fields off RESPONSE_GENERATED rows. They are REUSED verbatim
 * from the CycleResponse — never recomputed here — and both null-coalesce to
 * null so the field is always present (the writer's SQL filters on IS NOT NULL
 * and intent = 'QUESTION').
 */

import type { CycleResponse } from '@sylphie/shared';

export function buildResponseGeneratedPayload(
  response: CycleResponse,
): Record<string, unknown> {
  return {
    turnId: response.turnId,
    arbitrationType: response.arbitrationType,
    actionId: response.actionId,
    text: response.text,
    textLength: response.text.length,
    model: response.model,
    latencyMs: response.latencyMs,
    knowledgeGrounding: response.knowledgeGrounding ?? null,
    intent: response.intent ?? null,
  };
}
