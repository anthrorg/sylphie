/**
 * Unit tests for SupervisorService always-evaluate bypass (ticket 2, §2.6).
 *
 * Run via: npx tsx packages/supervisor/src/supervisor.always-evaluate.spec.ts
 *
 * Verifies that a cycle which routine sampling would DROP is still evaluated
 * when:
 *   1. an attractor detector is currently active (attractor_alert half), and
 *   2. the cycle is GUARDIAN_FEEDBACK (regression guard for the existing half).
 *
 * And that when neither holds and the sampler says "skip", no verdict is
 * produced.
 *
 * Strategy: drive real cycles through DecisionMakingService.response$ (a Subject
 * we control), with a mock LLM and a mock attractor monitor. We assert on the
 * verdicts emitted on supervisor.verdict$.
 */

import assert from 'node:assert/strict';
import { Subject, firstValueFrom, timeout, of, catchError } from 'rxjs';
import { SupervisorService } from './supervisor.service.js';
import { NarrationBuilderService } from './narration-builder.service.js';
import { CostTrackerService } from './cost-tracker.service.js';
import { AdaptiveSamplerService } from './adaptive-sampler.service.js';
import { VerdictAuditService } from './verdict-audit.service.js';
import { InterventionTrackerService } from './intervention-tracker.service.js';
import { INITIAL_DRIVE_STATE } from '@sylphie/shared';
import type { CycleResponse } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function makeConfig(over: Record<string, string> = {}): any {
  const map: Record<string, string> = {
    SUPERVISOR_ENABLED: 'true',
    SUPERVISOR_SAMPLING_RATE: '10',
    SUPERVISOR_DAILY_BUDGET_USD: '5.00',
    // Disable adaptive so the routine path is the deterministic fixed gate
    // (cycleCount % 10) — makes "would be dropped" unambiguous.
    SUPERVISOR_ADAPTIVE_SAMPLING: 'false',
    ...over,
  };
  return {
    get<T>(key: string, def?: T): T {
      return (map[key] as unknown as T) ?? def;
    },
  };
}

/** Mock LLM that always returns a parseable verdict JSON. */
function makeLlm(): any {
  return {
    async complete() {
      return {
        content: JSON.stringify({
          verdict: 'good',
          confidence: 0.9,
          reasoning: 'fine',
          flag_for_guardian: false,
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

/** Attractor monitor whose active-alert state we can flip. */
class MockAttractorMonitor {
  active = false;
  async getActiveAlerts() {
    return this.active
      ? [{ name: 'TYPE_2_ADDICT', triggered: true, metric: 0.95, threshold: 0.9 }]
      : [];
  }
}

function makeCycle(over: Partial<CycleResponse> = {}): CycleResponse {
  return {
    turnId: `t-${Math.random().toString(36).slice(2)}`,
    text: 'hello',
    arbitrationType: 'TYPE_1',
    actionId: 'action-x',
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

function buildSupervisor(response$: Subject<CycleResponse>, monitor: MockAttractorMonitor) {
  const decisionMaking: any = { response$: response$.asObservable() };
  const svc = new SupervisorService(
    decisionMaking,
    makeLlm(),
    new NarrationBuilderService(),
    new CostTrackerService(makeConfig()),
    makeSidecar(),
    new VerdictAuditService(null as any),
    new InterventionTrackerService(null as any),
    new AdaptiveSamplerService(),
    makeConfig(),
    monitor as any,
  );
  return svc;
}

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ok ${name}`);
}

/** Collect verdicts for a short window. */
function collectFirstVerdict(svc: SupervisorService) {
  return firstValueFrom(
    svc.verdict$.pipe(
      timeout(300),
      catchError(() => of(null)),
    ),
  );
}

async function main(): Promise<void> {
  console.log('SupervisorService — always-evaluate bypass');

  // 1. Attractor active → the very FIRST cycle (cycleCount=1, which 1%10 !== 0
  //    would normally DROP) is evaluated.
  await check('attractor-active cycle bypasses sampling', async () => {
    const response$ = new Subject<CycleResponse>();
    const monitor = new MockAttractorMonitor();
    monitor.active = true;
    const svc = buildSupervisor(response$, monitor);
    svc.onModuleInit();

    const verdictP = collectFirstVerdict(svc);
    response$.next(makeCycle()); // cycleCount becomes 1 → 1%10 !== 0
    const verdict = await verdictP;
    assert.ok(verdict, 'attractor cycle must be evaluated despite sampling');

    svc.onModuleDestroy();
  });

  // 2. Guardian feedback → bypass (regression guard for the existing half).
  await check('GUARDIAN_FEEDBACK cycle bypasses sampling', async () => {
    const response$ = new Subject<CycleResponse>();
    const monitor = new MockAttractorMonitor(); // inactive
    const svc = buildSupervisor(response$, monitor);
    svc.onModuleInit();

    const verdictP = collectFirstVerdict(svc);
    response$.next(makeCycle({ inputCategory: 'GUARDIAN_FEEDBACK' }));
    const verdict = await verdictP;
    assert.ok(verdict, 'guardian-feedback cycle must be evaluated');

    svc.onModuleDestroy();
  });

  // 3. No attractor, not guardian, sampler would skip → NO verdict.
  await check('routine cycle that sampling drops produces no verdict', async () => {
    const response$ = new Subject<CycleResponse>();
    const monitor = new MockAttractorMonitor(); // inactive
    const svc = buildSupervisor(response$, monitor);
    svc.onModuleInit();

    const verdictP = collectFirstVerdict(svc);
    response$.next(makeCycle()); // cycleCount=1 → 1%10 !== 0 → dropped
    const verdict = await verdictP;
    assert.equal(verdict, null, 'dropped cycle must not produce a verdict');

    svc.onModuleDestroy();
  });

  console.log(`\nSupervisorService always-evaluate: ${passed} checks passed\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
