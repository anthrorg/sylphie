/**
 * Unit tests for ProposalService cost-logging (TK-47).
 *
 * Verifies AC-1: after a successful LLM proposal call, the service logs a line
 * matching `LLM cost [proposal]: $X (Np+Nc tokens)` (observability only).
 *
 * Run via: npx tsx --tsconfig packages/planning/tsconfig.json packages/planning/src/pipeline/proposal.service.spec.ts
 *
 * Design:
 *  - ProposalService is instantiated directly (no NestJS runtime needed).
 *  - A minimal mock ILlmService returns a controlled LlmResponse.
 *  - Logger.log/warn are patched to capture and suppress output during the test.
 */

import assert from 'node:assert/strict';
import { Logger } from '@nestjs/common';
import { ProposalService } from './proposal.service.js';
import type { ILlmService, LlmRequest, LlmResponse } from '@sylphie/shared';
import { DriveName } from '@sylphie/shared';
import type {
  QueuedOpportunity,
  ResearchResult,
  SimulationResult,
} from '../interfaces/planning.interfaces.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal LlmResponse fixture with controllable token counts. */
function makeLlmResponse(prompt: number, completion: number): LlmResponse {
  return {
    content: JSON.stringify({
      name: 'test-plan',
      category: 'SelfRegulation',
      triggerContext: 'when curiosity is low',
      rationale: 'Addresses curiosity deficit',
      steps: [{ stepType: 'LLM_GENERATE', params: { purpose: 'respond' } }],
    }),
    tokensUsed: { prompt, completion },
    latencyMs: 42,
    model: 'deepseek-chat',
    cost: 0,
  };
}

function makeOpportunity(): QueuedOpportunity {
  return {
    payload: {
      id: 'opp-test-1',
      contextFingerprint: 'fingerprint-abc',
      classification: 'PREDICTION_FAILURE_PATTERN',
      priority: 'MEDIUM',
      sourceEventId: 'evt-1',
      affectedDrive: DriveName.Curiosity,
    },
    enqueuedAt: new Date(),
    initialPriority: 0.6,
    currentPriority: 0.6,
  };
}

function makeResearch(): ResearchResult {
  return {
    sufficient: true,
    eventFrequency: 3,
    recentOccurrences: 1,
    relatedEvents: [],
    contextPatterns: ['low-engagement'],
  };
}

function makeSimulation(): SimulationResult {
  return {
    viable: true,
    outcomes: [
      {
        actionCategory: 'SelfRegulation',
        description: 'Self-regulate curiosity',
        confidenceEstimate: 0.5,
        riskScore: 0.1,
        estimatedDriveEffect: { [DriveName.Curiosity]: -0.2 },
      },
    ],
    bestOutcome: {
      actionCategory: 'SelfRegulation',
      description: 'Self-regulate curiosity',
      confidenceEstimate: 0.5,
      riskScore: 0.1,
      estimatedDriveEffect: { [DriveName.Curiosity]: -0.2 },
    },
  };
}

/** Build a mock ILlmService whose complete() returns the given response. */
function makeMockLlm(response: LlmResponse): ILlmService {
  return {
    isAvailable: () => true,
    complete: async (_req: LlmRequest) => response,
    estimateCost: () => ({ tokenEstimate: 0, latencyEstimate: 0, cognitiveEffortCost: 0 }),
    enableLesionTest: () => {},
    resetCircuitBreaker: () => {},
  };
}

/** Build a mock ILlmService that reports unavailable. */
function makeUnavailableLlm(): ILlmService {
  return {
    isAvailable: () => false,
    complete: async () => { throw new Error('should not be called'); },
    estimateCost: () => ({ tokenEstimate: 0, latencyEstimate: 0, cognitiveEffortCost: 0 }),
    enableLesionTest: () => {},
    resetCircuitBreaker: () => {},
  };
}

// ---------------------------------------------------------------------------
// Logger patch helpers
// ---------------------------------------------------------------------------

interface Patch {
  captured: string[];
  restore: () => void;
}

/** Patch Logger.prototype.log (and optionally .warn) to capture lines silently. */
function patchLogger(): Patch {
  const captured: string[] = [];
  const origLog = Logger.prototype.log;
  const origWarn = Logger.prototype.warn;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const origDebug = (Logger.prototype as unknown as Record<string, unknown>).debug;

  Logger.prototype.log = function (...args: unknown[]) {
    captured.push(args.map(String).join(' '));
  };
  // Suppress warn/debug during tests to keep output clean.
  Logger.prototype.warn = function () {};
  (Logger.prototype as unknown as Record<string, unknown>).debug = function () {};

  return {
    captured,
    restore: () => {
      Logger.prototype.log = origLog;
      Logger.prototype.warn = origWarn;
      (Logger.prototype as unknown as Record<string, unknown>).debug = origDebug;
    },
  };
}

// ---------------------------------------------------------------------------
// Sequential async test runner
// ---------------------------------------------------------------------------

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, passed: true });
  } catch (err) {
    results.push({
      name,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Tests (run sequentially to avoid Logger patch races)
// ---------------------------------------------------------------------------

async function runAll(): Promise<void> {
  console.log('\n  ProposalService — cost logging (TK-47 AC-1)');

  // -------------------------------------------------------------------------
  // AC-1: cost line emitted on successful LLM call
  // -------------------------------------------------------------------------
  await runTest('logs "LLM cost [proposal]: $X (Np+Nc tokens)" after a successful LLM call', async () => {
    const promptTokens = 400;
    const completionTokens = 180;
    const mockLlm = makeMockLlm(makeLlmResponse(promptTokens, completionTokens));

    const patch = patchLogger();
    try {
      const service = new ProposalService(mockLlm);
      await service.propose(makeOpportunity(), makeResearch(), makeSimulation());
    } finally {
      patch.restore();
    }

    // AC-1: must contain a line matching the expected format.
    const costLine = patch.captured.find((line) => line.startsWith('LLM cost [proposal]:')) ?? '';
    assert.ok(
      costLine.length > 0,
      `Expected a "LLM cost [proposal]: ..." log line, but captured lines were:\n${patch.captured.join('\n')}`,
    );

    // Verify token counts appear in the line.
    assert.ok(
      costLine.includes(`${promptTokens}+${completionTokens} tokens`),
      `Expected "${promptTokens}+${completionTokens} tokens" in cost line, got: ${costLine}`,
    );

    // Verify cost is a non-negative number prefixed with $.
    const costMatch = costLine.match(/\$(\d+\.\d+)/);
    assert.ok(costMatch !== null, `Expected a "$X.XXXXXX" cost value in: ${costLine}`);
    const costValue = parseFloat(costMatch[1]);
    assert.ok(costValue >= 0, `Cost must be non-negative, got ${costValue}`);
  });

  // -------------------------------------------------------------------------
  // Template path: no cost line
  // -------------------------------------------------------------------------
  await runTest('does NOT log a cost line when LLM is unavailable (template path)', async () => {
    const patch = patchLogger();
    try {
      const service = new ProposalService(makeUnavailableLlm());
      await service.propose(makeOpportunity(), makeResearch(), makeSimulation());
    } finally {
      patch.restore();
    }

    const costLine = patch.captured.find((line) => line.startsWith('LLM cost [proposal]:'));
    assert.ok(
      costLine === undefined,
      `Expected NO cost line on template path, but found: ${costLine}`,
    );
  });

  // -------------------------------------------------------------------------
  // Print summary
  // -------------------------------------------------------------------------
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  for (const r of results) {
    if (r.passed) {
      console.log(`    PASS  ${r.name}`);
    } else {
      console.error(`    FAIL  ${r.name}`);
      console.error(`          ${r.error}`);
    }
  }

  console.log(`\n  Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) process.exit(1);
}

runAll().catch((err) => {
  console.error('Unexpected error in test runner:', err);
  process.exit(1);
});
