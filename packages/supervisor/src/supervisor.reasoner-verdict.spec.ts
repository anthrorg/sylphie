/**
 * Unit tests for SupervisorService reasoner-verdict handling (Phase 4 Wave 2 fix).
 *
 * Run via: npx tsx packages/supervisor/src/supervisor.reasoner-verdict.spec.ts
 *
 * Regression guard for the live-smoke bug where the supervisor audit trail
 * NEVER persisted a row in production:
 *
 *   The 'deep' tier routes to deepseek-reasoner, which spends its token budget
 *   on `reasoning_content` (chain-of-thought) and, at the old maxTokens:300,
 *   never emitted the final JSON verdict. parseVerdict returned null and
 *   evaluate() bailed BEFORE VerdictAuditService.record(...) — so zero
 *   SUPERVISOR_VERDICT rows ever landed.
 *
 * These tests feed a realistic reasoner-shaped response (a `reasoning_content`
 * blob + a final JSON verdict in `content`) and assert:
 *   1. parseVerdict extracts the verdict from `content` (separate from the CoT).
 *   2. evaluate() reaches VerdictAuditService.record(...).
 *   3. The audit record carries BOTH the parsed verdict AND the reasoningContent.
 *   4. The hardened extractor picks the FINAL JSON object when content contains
 *      a worked-example object before the real verdict (and ignores brace-bearing
 *      prose), and survives nested objects (suggested_correction).
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
import type { VerdictAuditRecord } from './interfaces/supervisor.types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function makeConfig(over: Record<string, string> = {}): any {
  const map: Record<string, string> = {
    SUPERVISOR_ENABLED: 'true',
    SUPERVISOR_SAMPLING_RATE: '1', // evaluate every cycle (cycleCount % 1 === 0)
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

/**
 * Mock LLM mimicking deepseek-reasoner: chain-of-thought in `reasoningContent`,
 * the final JSON verdict in `content`. `content` is configurable so we can test
 * the hardened extractor against tricky shapes.
 */
function makeReasonerLlm(content: string, reasoning: string): any {
  return {
    async complete() {
      return {
        content,
        tokensUsed: { prompt: 220, completion: 640 },
        latencyMs: 1800,
        model: 'deepseek-reasoner',
        cost: 0.0009,
        reasoningContent: reasoning,
      };
    },
  };
}

function makeSidecar(): any {
  return { executeIntervention: async () => ({ accepted: true }) };
}

/** Capturing audit service: records into an array instead of TimescaleDB. */
class CapturingAudit extends VerdictAuditService {
  readonly records: VerdictAuditRecord[] = [];
  constructor() {
    super(null as any);
  }
  override record(record: VerdictAuditRecord): void {
    this.records.push(record);
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

function buildSupervisor(
  response$: Subject<CycleResponse>,
  llm: any,
  audit: CapturingAudit,
) {
  const decisionMaking: any = { response$: response$.asObservable() };
  return new SupervisorService(
    decisionMaking,
    llm,
    new NarrationBuilderService(),
    new CostTrackerService(makeConfig()),
    makeSidecar(),
    audit,
    new InterventionTrackerService(null as any),
    new AdaptiveSamplerService(),
    makeConfig(),
    null, // no attractor monitor
  );
}

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ok ${name}`);
}

function firstVerdict(svc: SupervisorService) {
  return firstValueFrom(
    svc.verdict$.pipe(
      timeout(300),
      catchError(() => of(null)),
    ),
  );
}

// A realistic reasoner CoT blob — long-ish and contains brace-bearing prose to
// prove the extractor never accidentally parses the chain-of-thought.
const REASONING =
  'Let me think. The dominant drive was curiosity {high}. The action taken ' +
  'addressed it. Considering criterion 1: drive alignment is good. ' +
  'I will format {the answer} as JSON. Final answer below.';

// The final content the reasoner emits: ONLY the verdict JSON.
const VERDICT_CONTENT = JSON.stringify({
  verdict: 'good',
  confidence: 0.82,
  reasoning: 'Action addressed the dominant curiosity pressure.',
  flag_for_guardian: false,
  flag_reason: null,
  suggested_correction: null,
});

async function main(): Promise<void> {
  console.log('SupervisorService — reasoner verdict + audit');

  // 1 + 2 + 3: reasoner-shaped response parses, record() reached, both
  // verdict and reasoningContent captured.
  await check(
    'reasoner response → verdict parsed, record() reached with verdict + reasoningContent',
    async () => {
      const response$ = new Subject<CycleResponse>();
      const audit = new CapturingAudit();
      const svc = buildSupervisor(
        response$,
        makeReasonerLlm(VERDICT_CONTENT, REASONING),
        audit,
      );
      svc.onModuleInit();

      const verdictP = firstVerdict(svc);
      response$.next(makeCycle());
      const verdict = await verdictP;

      assert.ok(verdict, 'verdict must be produced from the reasoner content');
      assert.equal(verdict!.rating, 'good');
      assert.equal(audit.records.length, 1, 'record() must be reached exactly once');

      const rec = audit.records[0];
      assert.equal(rec.provenance, 'LLM_GENERATED', 'Std-2 truthful provenance');
      assert.equal(rec.model, 'deepseek-reasoner');
      assert.equal(rec.verdict.rating, 'good');
      assert.equal(
        rec.verdict.reasoningTrace,
        REASONING,
        'reasoningContent (CoT) must be threaded into the audit record',
      );

      svc.onModuleDestroy();
    },
  );

  // 4a: content has a worked-example object BEFORE the real verdict → take last.
  await check(
    'extractor takes the FINAL JSON object when content has an example first',
    async () => {
      const response$ = new Subject<CycleResponse>();
      const audit = new CapturingAudit();
      const content =
        'Here is the schema I will follow: ' +
        JSON.stringify({ verdict: 'wrong', confidence: 0.1, reasoning: 'EXAMPLE' }) +
        '\nNow my actual answer:\n' +
        JSON.stringify({
          verdict: 'acceptable',
          confidence: 0.6,
          reasoning: 'REAL',
          flag_for_guardian: false,
        });
      const svc = buildSupervisor(
        response$,
        makeReasonerLlm(content, REASONING),
        audit,
      );
      svc.onModuleInit();

      const verdictP = firstVerdict(svc);
      response$.next(makeCycle());
      const verdict = await verdictP;

      assert.ok(verdict);
      assert.equal(verdict!.rating, 'acceptable', 'must pick the LAST object');
      assert.equal(verdict!.reasoning, 'REAL');
      assert.equal(audit.records.length, 1);

      svc.onModuleDestroy();
    },
  );

  // 4b: nested object (suggested_correction) survives the balanced-brace scan.
  await check('extractor handles a nested suggested_correction object', async () => {
    const response$ = new Subject<CycleResponse>();
    const audit = new CapturingAudit();
    const content = JSON.stringify({
      verdict: 'questionable',
      confidence: 0.55,
      reasoning: 'Possible non-sequitur.',
      flag_for_guardian: true,
      flag_reason: 'Response did not address dominant drive.',
      suggested_correction: { type: 'correct', reason: 'redirect to drive' },
    });
    const svc = buildSupervisor(
      response$,
      makeReasonerLlm(content, REASONING),
      audit,
    );
    svc.onModuleInit();

    const verdictP = firstVerdict(svc);
    response$.next(makeCycle());
    const verdict = await verdictP;

    assert.ok(verdict);
    assert.equal(verdict!.rating, 'questionable');
    assert.equal(verdict!.flagForGuardian, true);
    assert.ok(verdict!.suggestedCorrection, 'nested correction object preserved');
    assert.equal((verdict!.suggestedCorrection as any).type, 'correct');
    assert.equal(audit.records.length, 1);

    svc.onModuleDestroy();
  });

  // 5: empty content (reasoner blew its budget on CoT, no verdict) → no record,
  //    no throw. Guards graceful degradation if the budget is still too low.
  await check('empty content → no verdict, no audit record, no throw', async () => {
    const response$ = new Subject<CycleResponse>();
    const audit = new CapturingAudit();
    const svc = buildSupervisor(response$, makeReasonerLlm('', REASONING), audit);
    svc.onModuleInit();

    const verdictP = firstVerdict(svc);
    response$.next(makeCycle());
    const verdict = await verdictP;

    assert.equal(verdict, null, 'no verdict when content has no JSON');
    assert.equal(audit.records.length, 0, 'record() must NOT be reached');

    svc.onModuleDestroy();
  });

  console.log(`\nSupervisorService reasoner-verdict: ${passed} checks passed\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
