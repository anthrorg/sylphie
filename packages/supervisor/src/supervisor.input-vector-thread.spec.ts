/**
 * Unit test for the verdict → intervention inputVector thread-through
 * (Phase 4 Wave 2 cluster 3b — closing the reinforcement loop).
 *
 * Run via: npx tsx packages/supervisor/src/supervisor.input-vector-thread.spec.ts
 *
 * Verifies that when a sampled cycle carries CycleResponse.globalInputVector and
 * the supervisor's verdict flags a correction, the resulting proposed
 * SupervisorIntervention carries that EXACT vector on inputVector — the value
 * the sidecar's /reinforce and /correct endpoints require. Also verifies the
 * honest-skip case: a cycle WITHOUT a globalInputVector yields an intervention
 * with NO inputVector (so reinforce/correct skip rather than fabricate one).
 *
 * Strategy mirrors supervisor.always-evaluate.spec.ts: drive a real cycle
 * through DecisionMakingService.response$ with a mock LLM that returns a flagged
 * verdict + correction, and capture the intervention via a spy tracker.
 */

import assert from 'node:assert/strict';
import { Subject } from 'rxjs';
import { SupervisorService } from './supervisor.service.js';
import { NarrationBuilderService } from './narration-builder.service.js';
import { CostTrackerService } from './cost-tracker.service.js';
import { AdaptiveSamplerService } from './adaptive-sampler.service.js';
import { VerdictAuditService } from './verdict-audit.service.js';
import { InterventionTrackerService } from './intervention-tracker.service.js';
import { INITIAL_DRIVE_STATE } from '@sylphie/shared';
import type { CycleResponse } from '@sylphie/shared';
import type { SupervisorIntervention } from './interfaces/supervisor.types.js';

const GLOBAL_INPUT_DIM = 1561;

function makeConfig(over: Record<string, string> = {}): any {
  const map: Record<string, string> = {
    SUPERVISOR_ENABLED: 'true',
    // Sample EVERY cycle so the verdict path is deterministic for the test.
    SUPERVISOR_SAMPLING_RATE: '1',
    SUPERVISOR_DAILY_BUDGET_USD: '5.00',
    SUPERVISOR_ADAPTIVE_SAMPLING: 'false',
    ...over,
  };
  return {
    get<T>(key: string, def?: T): T {
      return (map[key] as unknown as T) ?? def;
    },
  };
}

/** Mock LLM that returns a FLAGGED verdict carrying a reinforce correction. */
function makeFlaggingLlm(): any {
  return {
    async complete() {
      return {
        content: JSON.stringify({
          verdict: 'wrong',
          confidence: 0.9,
          reasoning: 'should reinforce the correct action',
          flag_for_guardian: true,
          flag_reason: 'needs reinforcement',
          suggested_correction: {
            type: 'reinforce',
            targetAction: 'wave',
            reason: 'good behaviour to reinforce',
          },
        }),
        tokensUsed: { prompt: 10, completion: 10 },
        latencyMs: 5,
        model: 'deepseek-reasoner',
        cost: 0.0001,
        reasoningContent: 'trace',
      };
    },
  };
}

function makeSidecar(): any {
  return { executeIntervention: async () => ({ accepted: true }) };
}

class MockAttractorMonitor {
  async getActiveAlerts() {
    return [];
  }
}

/** Spy tracker that records every proposed intervention. */
class SpyInterventionTracker extends InterventionTrackerService {
  readonly proposals: SupervisorIntervention[] = [];
  constructor() {
    super(null as any);
  }
  override proposed(intervention: SupervisorIntervention): string {
    this.proposals.push(intervention);
    return `spy-${this.proposals.length}`;
  }
}

function makeCycle(over: Partial<CycleResponse> = {}): CycleResponse {
  return {
    turnId: `t-${Math.random().toString(36).slice(2)}`,
    text: 'hello',
    arbitrationType: 'TYPE_1',
    actionId: 'wave',
    driveSnapshot: {
      pressureVector: { ...INITIAL_DRIVE_STATE },
      timestamp: new Date(),
      tickNumber: 1,
      driveDeltas: {} as any,
      ruleMatchResult: { ruleId: null, eventType: 'TEST', matched: false },
      totalPressure: 0,
      sessionId: 's1',
    },
    arbitrationResult: { type: 'TYPE_1' } as any,
    latencyMs: 12,
    knowledgeGrounding: 'GROUNDED' as any,
    ...over,
  } as CycleResponse;
}

function buildSupervisor(
  response$: Subject<CycleResponse>,
  tracker: InterventionTrackerService,
) {
  const decisionMaking: any = { response$: response$.asObservable() };
  return new SupervisorService(
    decisionMaking,
    makeFlaggingLlm(),
    new NarrationBuilderService(),
    new CostTrackerService(makeConfig()),
    makeSidecar(),
    new VerdictAuditService(null as any),
    tracker,
    new AdaptiveSamplerService(),
    makeConfig(),
    new MockAttractorMonitor() as any,
  );
}

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ok ${name}`);
}

/** Wait until the spy tracker records a proposal (or time out). */
async function waitForProposal(
  tracker: SpyInterventionTracker,
  ms = 300,
): Promise<SupervisorIntervention | null> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (tracker.proposals.length > 0) return tracker.proposals[0];
    await new Promise((r) => setTimeout(r, 5));
  }
  return tracker.proposals[0] ?? null;
}

async function main(): Promise<void> {
  console.log('SupervisorService — globalInputVector → intervention.inputVector');

  // 1. Cycle carries a globalInputVector → it threads onto the intervention
  //    BYTE-FOR-BYTE, ready for the sidecar's reinforce/correct.
  await check('globalInputVector threads onto intervention.inputVector', async () => {
    const response$ = new Subject<CycleResponse>();
    const tracker = new SpyInterventionTracker();
    const svc = buildSupervisor(response$, tracker);
    svc.onModuleInit();

    const vec = Array.from({ length: GLOBAL_INPUT_DIM }, (_, i) => (i % 7) * 0.01);
    response$.next(makeCycle({ globalInputVector: vec }));

    const intervention = await waitForProposal(tracker);
    assert.ok(intervention, 'a flagged verdict must propose an intervention');
    assert.ok(
      intervention.inputVector,
      'intervention must carry inputVector when the cycle had one',
    );
    assert.equal(
      intervention.inputVector!.length,
      GLOBAL_INPUT_DIM,
      'inputVector must be the full 1561-dim vector',
    );
    assert.deepEqual(
      intervention.inputVector,
      vec,
      'inputVector must be byte-identical to the cycle vector (no reconstruction)',
    );
    assert.equal(intervention.type, 'reinforce');

    svc.onModuleDestroy();
  });

  // 2. Cycle WITHOUT a globalInputVector → intervention has NO inputVector, so
  //    reinforce/correct skip honestly (never a fabricated/zeroed vector).
  await check('no globalInputVector → intervention.inputVector stays undefined', async () => {
    const response$ = new Subject<CycleResponse>();
    const tracker = new SpyInterventionTracker();
    const svc = buildSupervisor(response$, tracker);
    svc.onModuleInit();

    response$.next(makeCycle()); // no globalInputVector

    const intervention = await waitForProposal(tracker);
    assert.ok(intervention, 'a flagged verdict must still propose an intervention');
    assert.equal(
      intervention.inputVector,
      undefined,
      'no cycle vector → inputVector omitted (honest skip downstream)',
    );

    svc.onModuleDestroy();
  });

  console.log(`\nSupervisor inputVector thread-through: ${passed} checks passed\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
