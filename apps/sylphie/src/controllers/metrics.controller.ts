import { Body, Controller, Get, HttpCode, Inject, Logger, Post, Query } from '@nestjs/common';
import { Public } from '../decorators/public.decorator';
import {
  ARBITRATION_SERVICE,
  ArbitrationService,
  ATTRACTOR_MONITOR_SERVICE,
  AttractorMonitorService,
  EPISODIC_MEMORY_SERVICE,
  type IEpisodicMemoryService,
  LatentSpaceService,
  ModalityRegistryService,
  ScenePredictionService,
  VisualPresenceHabituatorService,
  WkgContextService,
  isDocumentEncoder,
  getLastCapturedPrompt,
  getCapturedPromptForTurn,
  resetPromptCapture,
  isPromptCaptureEnabled,
} from '@sylphie/decision-making';
import { DRIVE_STATE_READER, type IDriveStateReader } from '@sylphie/drive-engine';
import { LEARNING_SERVICE, type ILearningService } from '@sylphie/learning';
import {
  Neo4jService,
  Neo4jInstanceName,
  TimescaleService,
  DriveName,
} from '@sylphie/shared';
import { PersonModelService } from '../services/person-model.service';
import { VisualWorkingMemoryService } from '../services/visual-working-memory.service';
import { PerceptionGateway } from '../gateways/perception.gateway';
import type {
  Type1Type2Ratio,
  PredictionMAEMetric,
  ProvenanceRatio,
  BehavioralDiversityIndex,
  GuardianResponseRate,
  InteroceptiveAccuracy,
  MeanDriveResolutionTime,
  HealthMetrics,
} from '@sylphie/shared';

/**
 * WS3 T4 — post-decay state of a C3 gate-fixture node, as read by /metrics/c3-inspect.
 * Carries both timestamps so the gate can run the write-recency guard
 * (treatment.updatedAt must equal control.updatedAt).
 */
interface C3NodeState {
  nodeId: string;
  confidence: number;
  retrievalCount: number;
  hasLastRetrieval: boolean;
  lastRetrievalAt: string | null;
  updatedAt: string | null;
  createdAt: string | null;
}

/**
 * MetricsController — CANON §Development Metrics health endpoint.
 *
 * Exposes the 7 primary health metrics defined in CANON §Development Metrics
 * as REST endpoints. The `/metrics/health` endpoint returns all seven metrics
 * in a single snapshot; individual observatory endpoints return historical
 * per-session slices for the telemetry dashboard.
 *
 * Data sources:
 *   - Type1Type2Ratio       → ArbitrationService.getMetrics()
 *   - PredictionMAEMetric   → AttractorMonitorService.getPredictionMAESummary()
 *   - ProvenanceRatio       → Neo4j WORLD (MATCH (n) RETURN n.provenance_type, count(*))
 *   - BehavioralDiversityIndex → TimescaleDB events table (ARBITRATION_COMPLETE, last 20)
 *   - GuardianResponseRate  → TimescaleDB events table (SOCIAL_COMMENT_INITIATED + responses)
 *   - InteroceptiveAccuracy → DriveStateReader current state (real-time point-in-time)
 *   - MeanDriveResolutionTime → TimescaleDB events (drive pressure timeline)
 *
 * Metrics with insufficient data return the type-correct shape with sampleCount: 0
 * rather than an empty array, per the task constraint.
 *
 * CANON §Theater Prohibition: These metrics are read-only. No writes happen here.
 * CANON §Drive Isolation: DriveStateReader is read-only (IDriveStateReader interface).
 */
@Controller('metrics')
export class MetricsController {
  private readonly logger = new Logger(MetricsController.name);

  constructor(
    @Inject(ARBITRATION_SERVICE)
    private readonly arbitration: ArbitrationService,

    @Inject(ATTRACTOR_MONITOR_SERVICE)
    private readonly attractorMonitor: AttractorMonitorService,

    @Inject(DRIVE_STATE_READER)
    private readonly driveReader: IDriveStateReader,

    private readonly neo4j: Neo4jService,
    private readonly timescale: TimescaleService,
    private readonly latentSpace: LatentSpaceService,
    private readonly personModel: PersonModelService,
    private readonly modalityRegistry: ModalityRegistryService,

    // WS3 T2/T4 — the REAL knowledge use→reinforce service. The C3 gate seam
    // drives reinforceFactNode() through this, never re-implementing ACT-R math.
    private readonly wkgContext: WkgContextService,

    // WS3 T3/T4 — the REAL decay cycle. The C3 gate runs an actual decay pass
    // (LEARNING_SERVICE.runDecayCycle) so the divergence it measures is produced
    // by production decay code reading the production last_retrieval_at field.
    @Inject(LEARNING_SERVICE)
    private readonly learning: ILearningService,

    // WS5 T0.7 — perception/episodic gate hermeticity reset surfaces.
    // EpisodicMemoryService is internal to DecisionMakingModule but its token +
    // interface are exported (index.ts) and the provider is a module export, so
    // injection by token is isolation-clean (no concrete-class import).
    @Inject(EPISODIC_MEMORY_SERVICE)
    private readonly episodicMemory: IEpisodicMemoryService,

    // WS5 T0.7 — scene-predictor reset (P1a determinism: carried state, not RNG).
    private readonly scenePrediction: ScenePredictionService,

    // WS5 T0.7 — VWM in-memory entity Map clear + synthetic WORLD node deletion.
    private readonly vwm: VisualWorkingMemoryService,

    // WS5 T0.5 — read-only `processing` flag observability so the inbound camera
    // stub can await frame completion between injected frames (no GATE_MODE
    // branch in the gateway — this is an accessor, not a test-only code path).
    private readonly perceptionGateway: PerceptionGateway,

    // TK-97 — per-identity visual-presence habituation state (gate seam).
    private readonly visualPresenceHabituator: VisualPresenceHabituatorService,
  ) {}

  // ---------------------------------------------------------------------------
  // CANON §Development Metrics: primary health snapshot
  // ---------------------------------------------------------------------------

  /**
   * GET /metrics/health
   *
   * Returns a single HealthMetrics snapshot containing all 7 CANON primary
   * health metrics computed at the time of the request.
   *
   * The `sessionId` field reflects the current drive session ID from the
   * most recent DriveSnapshot. Drive session IDs are set by the Drive Engine
   * child process and carried through all IPC messages.
   *
   * @returns HealthMetrics snapshot.
   */
  @Get('health')
  @Public()
  async health(): Promise<HealthMetrics> {
    const computedAt = new Date();

    const [
      type1Type2Ratio,
      predictionMAE,
      provenanceRatio,
      behavioralDiversityIndex,
      guardianResponseRate,
      interoceptiveAccuracy,
      meanDriveResolutionTimes,
    ] = await Promise.all([
      this.computeType1Type2Ratio(computedAt),
      this.computePredictionMAE(computedAt),
      this.computeProvenanceRatio(computedAt),
      this.computeBehavioralDiversityIndex(computedAt),
      this.computeGuardianResponseRate(computedAt),
      this.computeInteroceptiveAccuracy(computedAt),
      this.computeMeanDriveResolutionTimes(computedAt),
    ]);

    const snapshot = this.driveReader.getCurrentState();

    return {
      computedAt,
      sessionId: snapshot.sessionId,
      type1Type2Ratio,
      predictionMAE,
      provenanceRatio,
      behavioralDiversityIndex,
      guardianResponseRate,
      interoceptiveAccuracy,
      meanDriveResolutionTimes,
    };
  }

  // ---------------------------------------------------------------------------
  // Metrics reset — per-run measurement window for the Provability Gate
  // ---------------------------------------------------------------------------

  /**
   * POST /metrics/reset
   *
   * Zero the in-process arbitration outcome counters (type1/type2/shrug) so a
   * caller can measure a clean window. The Provability Gate calls this AFTER the
   * reachability check and BEFORE the corpus runs, so the Type 1/Type 2 ratio
   * (CANON §Development Metrics) reflects only that run's turns rather than the
   * process's lifetime counters.
   *
   * CANON §Theater Prohibition: this resets only the diagnostic counters used by
   * the metrics window. It does NOT touch drive state, WKG provenance, or any
   * evaluation logic — there is no self-modification of evaluation here.
   *
   * @returns The counts as they stood immediately before the reset, for audit.
   */
  @Post('reset')
  @HttpCode(200)
  resetMetrics(): { ok: true; clearedAt: string; previous: { type1: number; type2: number; shrug: number } } {
    const { type1Count, type2Count, shrugCount } = this.arbitration.getMetrics();
    this.arbitration.resetMetrics();
    this.logger.log(
      `Arbitration metrics reset (was type1=${type1Count} type2=${type2Count} shrug=${shrugCount}).`,
    );
    return {
      ok: true,
      clearedAt: new Date().toISOString(),
      previous: { type1: type1Count, type2: type2Count, shrug: shrugCount },
    };
  }

  /**
   * POST /metrics/latent-reset
   *
   * Clear ONLY the in-memory latent hot layer, so the next run starts from a cold
   * latent index. NON-DESTRUCTIVE: the persistent `learned_patterns` warm layer is
   * left intact and re-hydrates the hot layer on the next boot, so no accumulated
   * data is lost. The Provability Gate calls this at the start of a run for
   * within-session hermeticity: without it, the hot layer is hydrated on boot from
   * patterns accumulated by ALL prior runs, so a graduated-but-over-general stored
   * pattern matches unknowable inputs as ~10ms TYPE_1 reflexes (confabulation that
   * no fresh embedding could explain).
   *
   * This does NOT truncate the warm layer — a durable hermetic gate would, but that
   * is irreversible and a separately authorized action.
   *
   * @returns The number of hot-layer patterns cleared, for audit.
   */
  @Post('latent-reset')
  @HttpCode(200)
  resetLatentSpace(): { ok: true; clearedAt: string; hotLayerCleared: number } {
    const hotLayerCleared = this.latentSpace.clearHotLayer();
    this.logger.warn(
      `Latent hot layer cleared for gate hermeticity (non-destructive): ${hotLayerCleared} patterns removed; warm layer preserved.`,
    );
    return { ok: true, clearedAt: new Date().toISOString(), hotLayerCleared };
  }

  /**
   * POST /metrics/latent-seed-overgeneral   { "text": "<nonsense probe>" }
   *
   * WS1 follow-up #3 — the NO-CLEAR gate seam (the TRAP defense).
   *
   * Clears the hot layer and seeds EXACTLY ONE over-general text pattern whose
   * stimulus embedding is the DOCUMENT embedding of the provided text — i.e. a
   * worst-case near-1.0 cosine match for that same text as a query, with
   * useCount 0. This reproduces the production hazard the min-population trust
   * gate exists to neutralize: a single fresh over-general pattern that would,
   * absent the gate, fire a confident GROUNDED Type 1 reflex on a grazing input.
   *
   * The provability gate's H1 probe calls this, then sends the SAME nonsense text
   * over the conversation WS and asserts the response is NOT a GROUNDED Type 1.
   * Unlike H0 (clearHotLayer → empty hot layer), this probe deliberately leaves a
   * lone pattern present, so it goes RED if the gate is removed — the real proof.
   *
   * NON-DESTRUCTIVE: hot-layer only; the persistent warm layer is untouched.
   *
   * @returns ok + the seeded pattern id + the resulting (modality) populations.
   */
  @Post('latent-seed-overgeneral')
  @HttpCode(200)
  async seedOverGeneral(
    @Body() body: { text?: string },
  ): Promise<{ ok: boolean; seededAt: string; patternId: string | null; hotLayerSize: number; textPopulation: number; reason?: string }> {
    const text = (body?.text ?? '').trim();
    if (!text) {
      return {
        ok: false, seededAt: new Date().toISOString(), patternId: null,
        hotLayerSize: this.latentSpace.hotLayerSize, textPopulation: 0,
        reason: 'no text provided',
      };
    }

    const encoder = this.modalityRegistry.get('text');
    if (!isDocumentEncoder(encoder)) {
      return {
        ok: false, seededAt: new Date().toISOString(), patternId: null,
        hotLayerSize: this.latentSpace.hotLayerSize, textPopulation: 0,
        reason: 'no document-capable text encoder registered',
      };
    }

    const embedding = await encoder.encodeDocument(text);
    const { id, hotLayerSize } = this.latentSpace.seedSingleOverGeneralPattern(embedding);
    this.logger.warn(
      `Seeded a single over-general pattern ${id.substring(0, 8)} for the H1 no-clear gate probe ` +
        `(text="${text.slice(0, 40)}", useCount 0). Hot layer size now ${hotLayerSize}.`,
    );
    return {
      ok: true,
      seededAt: new Date().toISOString(),
      patternId: id,
      hotLayerSize,
      textPopulation: this.latentSpace.hotLayerSizeForModality('text'),
    };
  }

  /**
   * POST /metrics/person-facts-reset
   *
   * Delete all OKG facts (Attribute nodes) for the gate conversation person
   * ('guardian' — the default userId the conversation WS attributes text to)
   * and clear the in-memory fact cache. The Person anchor node is preserved.
   *
   * The Provability Gate calls this at the start of a run (P0 step): person
   * facts are injected verbatim into LLM prompts, so any fact accumulated
   * between cassette record and replay changes prompt content and causes a
   * cassette miss (X0). The gate corpus re-teaches its facts every run, so a
   * pre-run wipe makes prompt content deterministic across runs.
   *
   * DESTRUCTIVE for the 'guardian' person's accumulated facts, by design and
   * gate-authorized: in the current single-user deployment those facts are
   * (re)taught by the corpus itself. Multi-person fact isolation is WS4.
   *
   * @returns The number of Attribute nodes deleted, for audit.
   */
  @Post('person-facts-reset')
  @HttpCode(200)
  async resetPersonFacts(): Promise<{ ok: boolean; clearedAt: string; factsCleared: number }> {
    const factsCleared = await this.personModel.clearFactsForPerson('guardian');
    this.logger.warn(
      `Person facts reset for gate hermeticity: ${factsCleared} attribute(s) deleted for 'guardian'.`,
    );
    return { ok: factsCleared >= 0, clearedAt: new Date().toISOString(), factsCleared };
  }

  /**
   * POST /metrics/all-persons-facts-reset
   *
   * WS4 Ticket 7 (P0′) — Delete all OKG facts (Attribute nodes) for ALL persons
   * and clear the in-memory fact cache.  Dedicated route (not a param on the
   * legacy person-facts-reset route per spec §6).
   *
   * Called once in the gate's P0 hermeticity block BEFORE the multi-person phase
   * so the privacy probes start from a provably clean state. Enumerates every
   * person in the OKG by traversing Person→HAS_FACT edges — never relies on a
   * hardcoded list, so it can never miss a person the gate forgot.
   *
   * DESTRUCTIVE for all persons' accumulated facts, by design and gate-authorized.
   *
   * @returns ok + clearedAt + factsCleared for audit.
   */
  @Post('all-persons-facts-reset')
  @HttpCode(200)
  async resetAllPersonFacts(): Promise<{ ok: boolean; clearedAt: string; factsCleared: number }> {
    const factsCleared = await this.personModel.clearFactsForAllPersons();
    this.logger.warn(
      `All-persons facts reset for gate hermeticity (WS4 T7): ` +
        `${factsCleared} attribute(s) deleted across all persons.`,
    );
    return { ok: factsCleared >= 0, clearedAt: new Date().toISOString(), factsCleared };
  }

  // ---------------------------------------------------------------------------
  // WS5 T0.7 — perception/episodic gate hermeticity reset block
  //
  // Mirrors the existing latent-reset / person-facts-reset pattern: dedicated
  // POST routes the Provability Gate calls in its hermeticity block before
  // injecting perception frames. Each leaves the perception path in a known cold
  // state so the next run's surprise/novelty/episode counts reflect ONLY that run.
  // ---------------------------------------------------------------------------

  /**
   * POST /metrics/episodic-reset
   *
   * Clear the in-process episodic ring buffer (clear()) AND truncate the
   * TimescaleDB checkpoint table. The in-memory clear alone is insufficient:
   * the checkpoint is re-hydrated on backend restart (episodic-memory.service
   * onModuleInit), so without the TRUNCATE a backend restart between gate phases
   * contaminates P3 cross-run (finding M). DESTRUCTIVE for the episodic buffer,
   * by design and gate-authorized — the gate re-encodes its own episodes.
   */
  @Post('episodic-reset')
  @HttpCode(200)
  async resetEpisodic(): Promise<{ ok: boolean; clearedAt: string; checkpointTruncated: boolean }> {
    this.episodicMemory.clear();
    let checkpointTruncated = false;
    try {
      await this.timescale.query('TRUNCATE episodic_memory_checkpoint');
      checkpointTruncated = true;
    } catch (err) {
      // Table may not exist yet (no episodes ever persisted) — non-fatal.
      this.logger.warn(
        `episodic-reset: TRUNCATE episodic_memory_checkpoint failed ` +
          `(${err instanceof Error ? err.message : err}) — buffer cleared in-memory regardless.`,
      );
    }
    this.logger.warn(
      `Episodic memory reset for gate hermeticity: ring buffer cleared, ` +
        `checkpoint truncated=${checkpointTruncated}.`,
    );
    return { ok: true, clearedAt: new Date().toISOString(), checkpointTruncated };
  }

  /**
   * POST /metrics/perception-reset
   *
   * Reset visual perception state: clear the VWM in-memory entity Map, DETACH
   * DELETE the synthetic WORLD :VisualObject nodes (T0.8), TRUNCATE
   * visual_object_embeddings, AND reset the gateway's scene-cycle cooldown
   * timestamp (`lastSceneCycleAt = 0`). Synthetic-scoped so genuine SENSOR world
   * facts are untouched. Without this, synthetic nodes + embedding rows accumulate
   * across runs and contaminate P1c/P3 surprise/novelty (finding 4). WORLD-only —
   * never touches SELF/OTHER (isolation-sound per atlas 2026-06-13).
   *
   * WS5 T4 isolation: folding the cooldown reset here means every per-row
   * perception-reset also guarantees the row's first scene-change nudge fires
   * immediately, eliminating cross-row cooldown contamination (the cause of P1c
   * seeing only ONE teapot surprise instead of two when rows ran back-to-back).
   */
  @Post('perception-reset')
  @HttpCode(200)
  async resetPerception(): Promise<{
    ok: boolean;
    clearedAt: string;
    entitiesCleared: number;
    syntheticNodesDeleted: number;
    embeddingsTruncated: boolean;
  }> {
    const r = await this.vwm.resetForGate();
    // WS5 T4 — zero the gateway scene-cycle cooldown so the row's first
    // scene-change event always fires a nudge, never suppressed by carry-over
    // from the previous row's final frame.
    this.perceptionGateway.resetCooldown();
    return {
      ok: true,
      clearedAt: new Date().toISOString(),
      entitiesCleared: r.entitiesCleared,
      syntheticNodesDeleted: r.syntheticNodesDeleted,
      embeddingsTruncated: r.embeddingsTruncated,
    };
  }

  /**
   * POST /metrics/scene-predictor-reset
   *
   * Zero the scene predictor's carried state so the FIRST frame after reset
   * returns surprise 0 by construction. This is the determinism mechanism for
   * the P1a "reset → prime-frame (surprise 0) → novel-frame" ordering — carried
   * mutable state being cleared, NOT a seeded RNG (finding L).
   */
  @Post('scene-predictor-reset')
  @HttpCode(200)
  resetScenePredictor(): { ok: true; clearedAt: string } {
    this.scenePrediction.reset();
    this.logger.warn('Scene predictor reset for gate hermeticity (P1a determinism).');
    return { ok: true, clearedAt: new Date().toISOString() };
  }

  /**
   * GET /metrics/scene-prediction-state
   *
   * WS5 T4 (P1a/P1c) — read-only view of the scene predictor's per-frame surprise
   * inspection ring + per-identity familiarity counts. Surfaces the EXACT
   * `totalSurprise` the predictor emitted into the cognitive cycle each frame (the
   * same number that fed both the encode-attention saliency term and the drive
   * router) plus the per-identity novel magnitudes — so the gate can assert:
   *   • P1a: surprise ≈0 on the prime frame, >0.05 on the NOVEL (second) frame.
   *   • P1c: surprise₂ < surprise₁ on the same IDENTITY key (personId else label)
   *     under a fresh trackId — proving familiarity habituation, NOT trackId
   *     persistence.
   * Read-only; no write path, no recomputation (Theater Prohibition — the gate
   * asserts on the value the cycle actually consumed).
   */
  @Get('scene-prediction-state')
  scenePredictionState(): ReturnType<ScenePredictionService['getState']> {
    return this.scenePrediction.getState();
  }

  /**
   * GET /metrics/last-scene-outcome
   *
   * WS5 P1a gate seam — the most recent ScenePrediction ACTION_OUTCOME that was
   * routed to the drive engine (totalSurprise >= 0.05 threshold passed).
   * Returns `lastRoutedOutcome` from the scene predictor, which carries:
   *   sceneSurprise  — the totalSurprise value that triggered the outcome.
   *   computedEffects — deterministic drive deltas ({curiosity, anxiety}) computed
   *                     from the same rule table the drive engine applies
   *                     (curiosity=0.02*s, anxiety=0.01*s), so P1a can assert on
   *                     the CAUSAL effect without polling the noisy net drive-vector.
   *   routedAt       — wall-clock when the outcome was routed.
   * Returns null.lastRoutedOutcome when no outcome has fired since the last reset.
   */
  @Get('last-scene-outcome')
  lastSceneOutcome(): { lastRoutedOutcome: ReturnType<ScenePredictionService['getState']>['lastRoutedOutcome'] } {
    return { lastRoutedOutcome: this.scenePrediction.getState().lastRoutedOutcome };
  }

  // ---------------------------------------------------------------------------
  // TK-97 — Visual-presence habituation gate seam
  // ---------------------------------------------------------------------------

  /**
   * GET /metrics/visual-presence-habituation-state
   *
   * TK-97 gate seam — read-only snapshot of the per-identity exposure counts
   * maintained by VisualPresenceHabituatorService.  Returns:
   *   exposureCounts  — map of entityId → number of cycles seen (object or person)
   *
   * Tests assert that:
   *   AC2: a static scene's exposure counts rise monotonically per-cycle and the
   *        attenuated count (1/(1+0.6*n)) decreases toward 0 over time.
   *   AC3: a NEW identity (absent from exposureCounts) starts at count=0 (factor=1.0).
   */
  @Get('visual-presence-habituation-state')
  visualPresenceHabituationState(): { exposureCounts: Record<string, number> } {
    return { exposureCounts: this.visualPresenceHabituator.getExposureCounts() };
  }

  /**
   * POST /metrics/visual-presence-habituation-reset
   *
   * TK-97 gate seam — reset all per-identity exposure counts so a fresh gate run
   * starts with full novelty pressure (factor=1.0 for every identity).
   * Mirrors /metrics/scene-predictor-reset for the same hermeticity guarantee.
   */
  @Post('visual-presence-habituation-reset')
  @HttpCode(200)
  visualPresenceHabituationReset(): { ok: true; clearedAt: string } {
    this.visualPresenceHabituator.reset();
    this.logger.warn('VisualPresenceHabituator reset for gate hermeticity (TK-97).');
    return { ok: true, clearedAt: new Date().toISOString() };
  }

  /**
   * GET /metrics/last-deliberation-prompt
   *
   * WS5 T4 (P2/P4) — read the test-only "last composed prompt" mirror: the
   * visual/knowledge context summary the most recent deliberation embedded in the
   * LLM prompt, plus which composition path produced it (production WM-snapshot vs
   * flat fallback). P2/P4 read this to prove the injected perception caption is
   * GENUINELY in the prompt the LLM saw — read directly off the real composed
   * context, decoupled from cassette record/replay (mythos ruling 2026-06-13).
   *
   * DARK unless GATE_DEBUG_PROMPT_CAPTURE is set on the backend process (the ring
   * is never populated otherwise — a standing "last prompt" surface would be a
   * data-exfil seam over person facts + drive state). Returns `enabled:false` when
   * capture is off so a caller can distinguish "disabled" from "no turn yet".
   *
   * WS5 T4/P2 turn-correlation: pass `?turnId=<id>` to read the capture for a
   * SPECIFIC turn (the turnId echoed on that turn's cb_speech) rather than the
   * racy "latest". Under queue backlog the real procedure cycle composes its
   * prompt seconds after the probe returns, so the gate polls THIS turn's record
   * by id instead of snapshotting "latest" at a fixed delay. Returns
   * `captured:null` (not an error) until that turn's prompt has been composed.
   */
  @Get('last-deliberation-prompt')
  lastDeliberationPrompt(@Query('turnId') turnId?: string): {
    enabled: boolean;
    turnId: string | null;
    captured: ReturnType<typeof getLastCapturedPrompt>;
  } {
    const captured =
      turnId && turnId.trim()
        ? getCapturedPromptForTurn(turnId.trim())
        : getLastCapturedPrompt();
    return {
      enabled: isPromptCaptureEnabled(),
      turnId: turnId?.trim() ?? null,
      captured,
    };
  }

  /**
   * POST /metrics/prompt-capture-reset
   *
   * WS5 T4 — clear the prompt-capture ring between gate phases so a stale capture
   * from a prior turn cannot satisfy a later assertion vacuously.
   */
  @Post('prompt-capture-reset')
  @HttpCode(200)
  resetPromptCapture(): { ok: true; clearedAt: string } {
    resetPromptCapture();
    return { ok: true, clearedAt: new Date().toISOString() };
  }

  /**
   * GET /metrics/perception-status
   *
   * WS5 T0.5 — read-only view of the perception gateway's per-frame `processing`
   * flag so the inbound camera stub can await frame completion before injecting
   * the next frame (back-to-back frames are dropped by the gateway). Read-only;
   * no GATE_MODE branch in the gateway — this is an accessor only.
   */
  @Get('perception-status')
  perceptionStatus(): { processing: boolean } {
    return { processing: this.perceptionGateway.isProcessing() };
  }

  /**
   * GET /metrics/episodic-recent
   *
   * WS5 T1/P3 — read-only view of the most recent episodes in the in-process
   * ring, surfacing the new `source` discriminant and `visualContext`
   * (caption/sceneLabels/personIds with per-sub-field provenance). P3 asserts
   * that after a salient injected frame an episode IS stored with
   * `source='perception'` and the injected caption/sceneLabels — which it could
   * not be before T1.0 wired sceneSurprise→encode-attention. Read-only; no write
   * path here (CANON Theater Prohibition).
   *
   * @param limit max episodes to return (default 10).
   */
  @Get('episodic-recent')
  episodicRecent(@Query('limit') limit?: string): {
    count: number;
    episodes: Array<{
      id: string;
      source: string;
      timestamp: string;
      inputSummary: string;
      actionTaken: string;
      speakerId?: string;
      speakerIsGuardian?: boolean;
      visualContext?: {
        caption?: { text: string; provenanceSource: string };
        sceneLabels?: readonly string[];
        personIds?: { ids: readonly string[]; provenanceSource: string };
        faceCount?: number;
      };
    }>;
  } {
    const n = limit ? Math.max(1, Math.min(50, parseInt(limit, 10) || 10)) : 10;
    const episodes = this.episodicMemory.getRecentEpisodes(n);
    return {
      count: episodes.length,
      episodes: episodes.map((ep) => ({
        id: ep.id,
        source: ep.source,
        timestamp: ep.timestamp instanceof Date ? ep.timestamp.toISOString() : String(ep.timestamp),
        inputSummary: ep.inputSummary,
        actionTaken: ep.actionTaken,
        ...(ep.speakerId !== undefined ? { speakerId: ep.speakerId } : {}),
        ...(ep.speakerIsGuardian !== undefined ? { speakerIsGuardian: ep.speakerIsGuardian } : {}),
        ...(ep.visualContext !== undefined ? { visualContext: ep.visualContext } : {}),
      })),
    };
  }

  /**
   * GET /metrics/episodic-recall?q=<natural language query>&limit=<n>
   *
   * WS5 T2/P4 — drive the REAL free-text recall path (queryByContent) with a
   * natural-language query and the LIVE drive snapshot as the query mood. This is
   * the deterministic seam the T2 smoke (and P4) uses to exercise content recall
   * + per-episode provenance WITHOUT depending on LLM tool-calling stochasticity:
   * it calls the identical method the `episodic_search` tool calls.
   *
   * The returned shape mirrors the tool's surfaced episode (caption surfaced as
   * its own LLM_GENERATED-tagged field; per-episode provenance derived from
   * `source` — a perception episode is 'experiential', its caption is never
   * experiential-GROUNDED). Read-only; no write path (Theater Prohibition).
   */
  @Get('episodic-recall')
  episodicRecall(
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ): {
    query: string;
    count: number;
    episodes: Array<{
      id: string;
      source: string;
      provenance: string;
      inputSummary: string;
      timestamp: string;
      caption?: string;
      captionProvenance?: string;
      sceneLabels?: readonly string[];
      sceneLabelsProvenance?: string;
    }>;
  } {
    const query = (q ?? '').trim();
    const n = limit ? Math.max(1, Math.min(50, parseInt(limit, 10) || 5)) : 5;
    // Live drive snapshot = query mood for the bounded mood-congruent blend.
    // Read-only (IDriveStateReader) — never writes to the Drive Engine.
    const queryMood = this.driveReader.getCurrentState();
    const episodes = this.episodicMemory.queryByContent(query, n, queryMood);
    return {
      query,
      count: episodes.length,
      episodes: episodes.map((ep) => {
        const provenance =
          ep.source === 'perception'
            ? 'experiential'
            : ep.source === 'conversation'
              ? 'medium_trust'
              : 'unknown';
        const caption = ep.visualContext?.caption;
        const labels = ep.visualContext?.sceneLabels;
        return {
          id: ep.id,
          source: ep.source,
          provenance,
          inputSummary: ep.inputSummary,
          timestamp:
            ep.timestamp instanceof Date ? ep.timestamp.toISOString() : String(ep.timestamp),
          ...(caption ? { caption: caption.text, captionProvenance: caption.provenanceSource } : {}),
          ...(labels && labels.length > 0
            ? { sceneLabels: labels, sceneLabelsProvenance: 'SENSOR' }
            : {}),
        };
      }),
    };
  }

  /**
   * GET /metrics/rumination-state
   *
   * WS5 T2.5 — read-only view of the rumination circuit-breaker (sliding-window
   * retrieval-diversity detector). Surfaces suppressRemaining / tripCount /
   * lastTripAt / window diagnostics so a future gate row can assert a trip (and a
   * RUMINATION_BREAKER_TRIPPED event) directly. Std 6: read-only, no drive write.
   */
  @Get('rumination-state')
  ruminationState(): ReturnType<IEpisodicMemoryService['getRuminationState']> {
    return this.episodicMemory.getRuminationState();
  }

  // ---------------------------------------------------------------------------
  // WS3 T4 — C3 compounding gate seam (hermetic) + T5 live-Neo4j provenance probe
  //
  // These routes let the Provability Gate prove the WS3 thesis — that a
  // recalled-and-used fact node STRENGTHENS relative to a never-recalled control,
  // capped at the 0.60 ceiling (Std 3) — against the LIVE Neo4j WORLD instance,
  // exercising the REAL T2 (reinforceFactNode) and T3 (runDecayCycle) code.
  //
  // Why a dedicated seam rather than driving reinforcement purely through the
  // conversation corpus: the live reinforce path fires only when (a) the turn is
  // a recall question recallKeyForQuestion() recognizes, (b) the OKG misses so it
  // falls to a topical WORLD entity, AND (c) the entity's label surfaces VERBATIM
  // in the LLM response so the C2 honesty guard flips the label to GROUNDED. That
  // chain is real but brittle to drive deterministically on a WORLD-seeded entity
  // through a hermetic cassette, and a "the value happened to appear in the prose"
  // pass would be green-for-the-wrong-reason. So C3 splits the proof honestly:
  //
  //   • C3 (this seam) proves the COMPOUNDING MECHANISM end-to-end through the
  //     real T2 + T3 services: seed two byte-identical WORLD nodes, reinforce ONLY
  //     the treatment via reinforceFactNode() N times (the exact method the live
  //     cycle calls), run the real decay cycle, and observe the divergence.
  //   • C3PROV / T5 proves the LIVE RETRIEVAL→PROVENANCE chain on the conversation
  //     WS path: a GROUNDED recall turn carries a groundingProvenance node id that
  //     ACTUALLY EXISTS in the correct live Neo4j instance (verified via
  //     /metrics/node-exists).
  //
  // What remains for the mythos live-smoke: observe a WORLD-entity recall turn
  // that genuinely routes retrieveWkgRecall → GROUNDED → reinforceFactNode in one
  // live conversation cycle (the brittle (a)+(b)+(c) chain above), closing the
  // last gap between "mechanism proven" and "the conversation path drives it".
  //
  // WRITE-RECENCY GUARD (the false-positive this seam is built to refute): the
  // divergence MUST come from reinforcement, not from the treatment being written
  // more recently. So c3-seed writes BOTH nodes with byte-identical created_at,
  // updated_at, confidence, and provenance_type. reinforceFactNode() sets
  // last_retrieval_at / retrieval_count / reinforced_at / confidence — it NEVER
  // touches updated_at (verified: wkg-context.service.ts SET clause). The decay
  // query coalesces last_retrieval_at → updated_at → created_at, so after a
  // decay cycle the control decays from its (old, shared) updated_at while the
  // treatment decays from its fresh last_retrieval_at AND carries ACT-R growth.
  // c3-inspect returns updated_at for both nodes so the gate can ASSERT they
  // remained equal (proving reinforce introduced no write-recency artifact).
  // ---------------------------------------------------------------------------

  /**
   * POST /metrics/c3-seed
   *
   * Seed two matched WORLD fact nodes — a control and a treatment — at IDENTICAL
   * starting confidence, provenance, and timestamps, `ageHours` in the past so a
   * single decay cycle actually applies (decay needs > MIN_HOURS_BEFORE_DECAY).
   * Deletes any prior nodes with these ids first, so the seam is idempotent and
   * the gate starts from a known state every run.
   *
   * Both nodes carry node_id (so reinforceFactNode's `MATCH (n {node_id})` finds
   * them), :Entity, schema_level='instance', and INFERENCE provenance (so they sit
   * below the 0.60 ceiling and are eligible to strengthen toward it via recall).
   *
   * PRUNE-IMMUNITY (so C3.2 always has a control to compare): the decay cycle also
   * PRUNES orphaned :Entity nodes whose confidence falls below 0.10. A never-recalled
   * control at 0.30 aged 48h would decay to ~0.07 and be GC'd — leaving nothing to
   * diverge from (observed live during the first smoke run). We give BOTH nodes an
   * IDENTICAL anchor relationship to a shared fixture node, so `NOT EXISTS {(n)--()}`
   * is false for both → neither is pruned. The anchor is matched, so it introduces
   * no asymmetry; it only removes the prune threshold as a confound. The control can
   * then decay toward (but survive at) a low confidence the treatment diverges above.
   *
   * Idempotent + hermetic. Returns the seeded values for audit.
   */
  @Post('c3-seed')
  @HttpCode(200)
  async c3Seed(
    @Body() body: { confidence?: number; ageHours?: number },
  ): Promise<{
    ok: boolean;
    seededAt: string;
    controlId: string;
    treatmentId: string;
    confidence: number;
    provenanceType: string;
    ageHours: number;
  }> {
    const confidence = typeof body?.confidence === 'number' ? body.confidence : 0.30;
    const ageHours = typeof body?.ageHours === 'number' ? body.ageHours : 48;
    const controlId = 'ws3-c3-control';
    const treatmentId = 'ws3-c3-treatment';
    const anchorId = 'ws3-c3-anchor';
    const provenanceType = 'INFERENCE';

    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');
    try {
      // Single statement so BOTH nodes get the SAME datetime() instant for
      // created_at/updated_at — no per-node clock skew that could itself read as
      // write-recency. Delete-then-create makes the seam idempotent. Both fact
      // nodes get an identical FIXTURE_ANCHOR edge to a shared anchor so the
      // decay cycle's orphan-prune can never remove the control (matched edge →
      // zero asymmetry; it only neutralizes the prune-threshold confound).
      await session.run(
        `WITH datetime() - duration({hours: $ageHours}) AS ts
         CALL {
           WITH ts
           MATCH (old) WHERE old.node_id IN [$controlId, $treatmentId, $anchorId] DETACH DELETE old
         }
         CREATE (a:Entity {
           node_id: $anchorId, name: 'ws3-c3-anchor', entityType: 'GateFixture',
           schema_level: 'instance', provenance_type: $provenanceType,
           confidence: 0.95, retrieval_count: 0, created_at: ts, updated_at: ts
         })
         CREATE (c:Entity {
           node_id: $controlId, name: 'ws3-c3-control', entityType: 'GateFixture',
           schema_level: 'instance', provenance_type: $provenanceType,
           confidence: $confidence, retrieval_count: 0,
           created_at: ts, updated_at: ts
         })
         CREATE (t:Entity {
           node_id: $treatmentId, name: 'ws3-c3-treatment', entityType: 'GateFixture',
           schema_level: 'instance', provenance_type: $provenanceType,
           confidence: $confidence, retrieval_count: 0,
           created_at: ts, updated_at: ts
         })
         CREATE (c)-[:FIXTURE_ANCHOR]->(a)
         CREATE (t)-[:FIXTURE_ANCHOR]->(a)
         RETURN c.node_id AS c, t.node_id AS t`,
        { controlId, treatmentId, anchorId, confidence, provenanceType, ageHours },
      );
      this.logger.warn(
        `WS3 C3 seed: control='${controlId}' + treatment='${treatmentId}' ` +
          `seeded identically (confidence=${confidence}, provenance=${provenanceType}, ` +
          `created_at/updated_at = now - ${ageHours}h).`,
      );
      return {
        ok: true, seededAt: new Date().toISOString(),
        controlId, treatmentId, confidence, provenanceType, ageHours,
      };
    } catch (err) {
      this.logger.error('c3Seed failed', err);
      return {
        ok: false, seededAt: new Date().toISOString(),
        controlId, treatmentId, confidence, provenanceType, ageHours,
      };
    } finally {
      await session.close();
    }
  }

  /**
   * POST /metrics/c3-reinforce   { "times": 12 }
   *
   * Reinforce the TREATMENT node `times` via the REAL WS3 T2 path
   * (WkgContextService.reinforceFactNode(nodeId, 'WKG')) — the identical method
   * the live cognitive cycle invokes on a grounded recall-and-use. The control is
   * left untouched. No bespoke confidence math here (Std 6): the ACT-R recompute
   * and the 0.60 ceiling clamp both live inside reinforceFactNode().
   *
   * Returns the reinforcement audit (old/new confidence, final retrieval_count)
   * so the gate can confirm retrieval_count advanced and confidence respected the
   * ceiling at the SOURCE, not just post-decay.
   */
  @Post('c3-reinforce')
  @HttpCode(200)
  async c3Reinforce(
    @Body() body: { times?: number },
  ): Promise<{
    ok: boolean;
    treatmentId: string;
    reinforced: number;
    oldConfidence: number | null;
    newConfidence: number | null;
    retrievalCount: number | null;
  }> {
    const times = Math.max(1, Math.min(100, typeof body?.times === 'number' ? body.times : 12));
    const treatmentId = 'ws3-c3-treatment';

    let oldConfidence: number | null = null;
    let newConfidence: number | null = null;
    let retrievalCount: number | null = null;
    let reinforced = 0;

    for (let i = 0; i < times; i++) {
      const r = await this.wkgContext.reinforceFactNode(treatmentId, 'WKG');
      if (!r) {
        this.logger.warn(`c3Reinforce: reinforceFactNode returned null on iteration ${i} (node missing?)`);
        break;
      }
      if (oldConfidence === null) oldConfidence = r.oldConfidence;
      newConfidence = r.newConfidence;
      retrievalCount = r.retrievalCount;
      reinforced++;
    }

    this.logger.warn(
      `WS3 C3 reinforce: treatment='${treatmentId}' reinforced ${reinforced}/${times}x via T2 ` +
        `reinforceFactNode — confidence ${oldConfidence ?? '?'} -> ${newConfidence ?? '?'}, ` +
        `retrieval_count -> ${retrievalCount ?? '?'} (ceiling 0.60).`,
    );

    return {
      ok: reinforced > 0,
      treatmentId, reinforced, oldConfidence, newConfidence, retrievalCount,
    };
  }

  /**
   * POST /metrics/decay-now
   *
   * Run a single REAL decay cycle (LEARNING_SERVICE.runDecayCycle → the WS3 T3
   * ConfidenceDecayService over WORLD). This is the production decay code reading
   * the production coalesce(last_retrieval_at, updated_at, created_at) ordering —
   * the gate does not simulate decay, it triggers it.
   *
   * @returns the decay cycle result for audit.
   */
  @Post('decay-now')
  @HttpCode(200)
  async decayNow(): Promise<{ ok: boolean; ranAt: string; result: unknown }> {
    try {
      const result = await this.learning.runDecayCycle();
      this.logger.warn(`WS3 C3 decay-now: ran a real decay cycle — ${JSON.stringify(result)}`);
      return { ok: true, ranAt: new Date().toISOString(), result };
    } catch (err) {
      this.logger.error('decayNow failed', err);
      return { ok: false, ranAt: new Date().toISOString(), result: String(err) };
    }
  }

  /**
   * POST /metrics/learn-now
   *
   * Wave 3 / C3 — run a single REAL learning maintenance cycle
   * (LEARNING_SERVICE.runMaintenanceCycle → the production consolidation pipeline:
   * upsertEntities → extractTypedEdges → extractEdges → … ). The gate uses this to
   * deterministically drain the just-spoken INPUT_RECEIVED / INPUT_PARSED events
   * into the WORLD graph (as `:Candidate` nodes, C3) instead of waiting on the 60s
   * self-driven timer. This is the production path, not a simulation.
   *
   * @returns the maintenance cycle result for audit.
   */
  @Post('learn-now')
  @HttpCode(200)
  async learnNow(): Promise<{ ok: boolean; ranAt: string; result: unknown }> {
    try {
      const result = await this.learning.runMaintenanceCycle();
      this.logger.warn(`Wave3 C3 learn-now: ran a real maintenance cycle — ${JSON.stringify(result)}`);
      return { ok: true, ranAt: new Date().toISOString(), result };
    } catch (err) {
      this.logger.error('learnNow failed', err);
      return { ok: false, ranAt: new Date().toISOString(), result: String(err) };
    }
  }

  /**
   * GET /metrics/candidate-exists?label=<label>
   *
   * Wave 3 / C3 — control assertion for gate PRIV.3. After a non-guardian speaker
   * introduces a proper noun and a learning cycle runs, a `:Candidate {label}` node
   * MUST exist in the WORLD graph (CANON Std-1: the leaked noun is STAGED visibly,
   * not silently dropped). This read-only endpoint matches that node by label and
   * returns its provenance_type, confidence, and grounding_person_id so the gate can
   * assert the full C0 contract (provenance 'CANDIDATE', confidence ≤0.60, scoped to
   * the speaker). It deliberately matches `:Candidate`, NOT `:Entity` — a live
   * `:Entity` of the same label would be the §2.8 leak the probe exists to catch.
   *
   * Read-only; never writes.
   */
  @Get('candidate-exists')
  async candidateExists(
    @Query('label') label?: string,
  ): Promise<{
    ok: boolean;
    label: string | null;
    exists: boolean;
    provenanceType: string | null;
    confidence: number | null;
    groundingPersonId: string | null;
  }> {
    const wanted = (label ?? '').trim();
    if (!wanted) {
      return { ok: false, label: null, exists: false, provenanceType: null, confidence: null, groundingPersonId: null };
    }
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'READ');
    try {
      const res = await session.run(
        `MATCH (c:Candidate {label: $label})
         RETURN c.provenance_type AS provenanceType,
                c.confidence AS confidence,
                c.grounding_person_id AS groundingPersonId
         LIMIT 1`,
        { label: wanted },
      );
      const rec = res.records[0];
      const exists = !!rec;
      const toNum = (v: unknown): number | null =>
        typeof v === 'number' ? v
          : v && typeof v === 'object' && 'toNumber' in v ? (v as { toNumber(): number }).toNumber()
          : null;
      return {
        ok: true,
        label: wanted,
        exists,
        provenanceType: exists ? ((rec!.get('provenanceType') as string | null) ?? null) : null,
        confidence: exists ? toNum(rec!.get('confidence')) : null,
        groundingPersonId: exists ? ((rec!.get('groundingPersonId') as string | null) ?? null) : null,
      };
    } catch (err) {
      this.logger.error('candidateExists failed', err);
      return { ok: false, label: wanted, exists: false, provenanceType: null, confidence: null, groundingPersonId: null };
    } finally {
      await session.close();
    }
  }

  /**
   * GET /metrics/c3-inspect
   *
   * Read the post-decay state of the control + treatment WORLD nodes the C3 gate
   * seam created. Returns confidence, retrieval_count, and BOTH timestamps
   * (updated_at + last_retrieval_at) for each so the gate can assert:
   *   (a) treatment retrieval_count > 0 and last_retrieval_at set; control: neither.
   *   (b) treatment confidence STRICTLY GREATER than control after decay.
   *   (c) treatment confidence never exceeds 0.60 (Std 3 ceiling).
   *   (d) WRITE-RECENCY GUARD: treatment.updated_at == control.updated_at — proves
   *       the divergence is reinforcement, not a more-recent write on treatment.
   */
  @Get('c3-inspect')
  async c3Inspect(): Promise<{
    ok: boolean;
    control: C3NodeState | null;
    treatment: C3NodeState | null;
  }> {
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'READ');
    try {
      const read = async (nodeId: string): Promise<C3NodeState | null> => {
        const res = await session.run(
          `MATCH (n {node_id: $nodeId})
           RETURN n.confidence AS confidence,
                  coalesce(n.retrieval_count, 0) AS retrievalCount,
                  n.last_retrieval_at IS NOT NULL AS hasLastRetrieval,
                  toString(n.last_retrieval_at) AS lastRetrievalAt,
                  toString(n.updated_at) AS updatedAt,
                  toString(n.created_at) AS createdAt`,
          { nodeId },
        );
        const rec = res.records[0];
        if (!rec) return null;
        const toNum = (v: unknown): number =>
          typeof v === 'number' ? v
            : v && typeof v === 'object' && 'toNumber' in v ? (v as { toNumber(): number }).toNumber()
            : 0;
        return {
          nodeId,
          confidence: typeof rec.get('confidence') === 'number' ? (rec.get('confidence') as number) : toNum(rec.get('confidence')),
          retrievalCount: toNum(rec.get('retrievalCount')),
          hasLastRetrieval: rec.get('hasLastRetrieval') === true,
          lastRetrievalAt: (rec.get('lastRetrievalAt') as string | null) ?? null,
          updatedAt: (rec.get('updatedAt') as string | null) ?? null,
          createdAt: (rec.get('createdAt') as string | null) ?? null,
        };
      };

      const control = await read('ws3-c3-control');
      const treatment = await read('ws3-c3-treatment');
      return { ok: control !== null && treatment !== null, control, treatment };
    } catch (err) {
      this.logger.error('c3Inspect failed', err);
      return { ok: false, control: null, treatment: null };
    } finally {
      await session.close();
    }
  }

  /**
   * POST /metrics/c3-cleanup
   *
   * Remove the C3 gate-fixture nodes so the seam leaves no residue in the live
   * graph (keeps the experiential-provenance census honest across runs).
   */
  @Post('c3-cleanup')
  @HttpCode(200)
  async c3Cleanup(): Promise<{ ok: boolean; deleted: number }> {
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');
    try {
      const res = await session.run(
        `MATCH (n) WHERE n.node_id IN ['ws3-c3-control', 'ws3-c3-treatment', 'ws3-c3-anchor']
         DETACH DELETE n RETURN count(n) AS deleted`,
      );
      const rec = res.records[0];
      const deleted = rec ? (rec.get('deleted') as { toNumber(): number }).toNumber() : 0;
      return { ok: true, deleted };
    } catch (err) {
      this.logger.error('c3Cleanup failed', err);
      return { ok: false, deleted: 0 };
    } finally {
      await session.close();
    }
  }

  /**
   * GET /metrics/node-exists?nodeId=<id>&source=WORLD|OTHER
   *
   * WS3 T5 — the deferred C1 provenance verification (ROADMAP.md:73). Given a
   * groundingProvenance node id carried by a GROUNDED recall turn, assert the node
   * ACTUALLY EXISTS in the correct live Neo4j instance:
   *   - WORLD (WKG source): match on `node_id`.
   *   - OTHER (OKG source): match on the deterministic `attr_id` Attribute key.
   * `source` should be the turn's responseGroundedBy ('WKG' → WORLD, 'OKG' →
   * OTHER). Defaults to WORLD when omitted. Read-only; never writes.
   *
   * This closes the gap C1 left open: C1 proved the response CARRIES a node id,
   * but never proved that id resolves to a real node in the live graph. T5 does.
   */
  @Get('node-exists')
  async nodeExists(
    @Query('nodeId') nodeId?: string,
    @Query('source') source?: string,
  ): Promise<{ ok: boolean; nodeId: string | null; instance: string; exists: boolean; label: string | null }> {
    const id = (nodeId ?? '').trim();
    const src = (source ?? 'WORLD').toUpperCase();
    const isOkg = src === 'OTHER' || src === 'OKG';
    const instance = isOkg ? Neo4jInstanceName.OTHER : Neo4jInstanceName.WORLD;
    if (!id) {
      return { ok: false, nodeId: null, instance, exists: false, label: null };
    }
    // OKG nodes key on attr_id; WORLD nodes key on node_id (mirrors reinforceFactNode).
    const matchClause = isOkg
      ? 'MATCH (n:Attribute {attr_id: $id})'
      : 'MATCH (n {node_id: $id})';
    const session = this.neo4j.getSession(instance, 'READ');
    try {
      const res = await session.run(
        `${matchClause} RETURN coalesce(n.name, n.value, n.label, n.node_id, n.attr_id) AS label LIMIT 1`,
        { id },
      );
      const rec = res.records[0];
      const exists = !!rec;
      const label = exists ? ((rec!.get('label') as string | null) ?? null) : null;
      return { ok: true, nodeId: id, instance: String(instance), exists, label };
    } catch (err) {
      this.logger.error('nodeExists failed', err);
      return { ok: false, nodeId: id, instance: String(instance), exists: false, label: null };
    } finally {
      await session.close();
    }
  }

  // ---------------------------------------------------------------------------
  // Observatory endpoints (per-session historical slices for dashboard charts)
  //
  // These return session-bucketed arrays for trend visualization. They query
  // the TimescaleDB events table grouped by session_id. When no sessions exist
  // yet (empty system), they return an empty `sessions` array — this is correct
  // behavior for a chart renderer that shows "no data" rather than a zeroed bar.
  // ---------------------------------------------------------------------------

  /**
   * GET /metrics/observatory/vocabulary-growth
   *
   * Returns per-day entity node counts from the WKG to visualize knowledge
   * accumulation over time. Queries Neo4j WORLD for nodes grouped by
   * date(created_at). Returns `{ days: [] }` when the graph has no nodes.
   */
  @Get('observatory/vocabulary-growth')
  @Public()
  async vocabularyGrowth(): Promise<{ days: Array<{ date: string; count: number }> }> {
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'READ');
    try {
      const result = await session.run(
        `MATCH (n)
         WHERE n.created_at IS NOT NULL
         WITH date(n.created_at) AS day, count(*) AS cnt
         RETURN toString(day) AS date, cnt AS count
         ORDER BY day ASC`,
      );
      const days = result.records.map((r) => ({
        date: r.get('date') as string,
        count: (r.get('count') as { toNumber(): number }).toNumber(),
      }));
      return { days };
    } catch (err) {
      this.logger.error('vocabularyGrowth Neo4j query failed', err);
      return { days: [] };
    } finally {
      await session.close();
    }
  }

  /**
   * GET /metrics/observatory/drive-evolution
   *
   * Returns per-session mean drive pressure snapshots from TimescaleDB.
   * Queries `events` for rows with drive_snapshot, groups by session_id,
   * and averages total_pressure. Returns `{ sessions: [] }` when no events exist.
   */
  @Get('observatory/drive-evolution')
  @Public()
  async driveEvolution(): Promise<{ sessions: Array<{ sessionId: string; meanPressure: number; timestamp: string }> }> {
    try {
      const result = await this.timescale.query<{
        session_id: string;
        mean_pressure: string;
        ts: string;
      }>(
        `SELECT
           session_id,
           AVG((drive_snapshot->>'totalPressure')::numeric) AS mean_pressure,
           MIN(timestamp) AS ts
         FROM events
         WHERE drive_snapshot IS NOT NULL
           AND drive_snapshot->>'totalPressure' IS NOT NULL
         GROUP BY session_id
         ORDER BY ts ASC
         LIMIT 100`,
      );
      const sessions = result.rows.map((row) => ({
        sessionId: row.session_id,
        meanPressure: parseFloat(row.mean_pressure),
        timestamp: row.ts,
      }));
      return { sessions };
    } catch (err) {
      this.logger.error('driveEvolution TimescaleDB query failed', err);
      return { sessions: [] };
    }
  }

  /**
   * GET /metrics/observatory/action-diversity
   *
   * Returns per-session behavioral diversity index values from TimescaleDB.
   * Queries ARBITRATION_COMPLETE events, groups by session_id, and counts
   * unique action types within 20-event windows per session.
   */
  @Get('observatory/action-diversity')
  @Public()
  async actionDiversity(): Promise<{ sessions: Array<{ sessionId: string; index: number; uniqueActionTypes: number }> }> {
    try {
      const result = await this.timescale.query<{
        session_id: string;
        unique_types: string;
        total_events: string;
      }>(
        `SELECT
           session_id,
           COUNT(DISTINCT payload->>'type') AS unique_types,
           COUNT(*) AS total_events
         FROM events
         WHERE type = 'ARBITRATION_COMPLETE'
         GROUP BY session_id
         ORDER BY MIN(timestamp) ASC
         LIMIT 100`,
      );
      const sessions = result.rows.map((row) => {
        const uniqueActionTypes = parseInt(row.unique_types, 10);
        const windowSize = Math.min(parseInt(row.total_events, 10), 20);
        const index = windowSize > 0 ? uniqueActionTypes / windowSize : 0;
        return { sessionId: row.session_id, index, uniqueActionTypes };
      });
      return { sessions };
    } catch (err) {
      this.logger.error('actionDiversity TimescaleDB query failed', err);
      return { sessions: [] };
    }
  }

  /**
   * GET /metrics/observatory/developmental-stage
   *
   * Returns per-session Type 1 percentage and overall developmental stage
   * classification. Uses ARBITRATION_COMPLETE events from TimescaleDB.
   *
   * Stage thresholds (CANON §Development Metrics — Autonomy trajectory):
   *   pre-autonomy  : type1Pct < 0.20
   *   emerging      : 0.20 <= type1Pct < 0.50
   *   consolidating : 0.50 <= type1Pct < 0.80
   *   autonomous    : type1Pct >= 0.80
   */
  @Get('observatory/developmental-stage')
  @Public()
  async developmentalStage(): Promise<{
    sessions: Array<{ sessionId: string; type1Pct: number; stage: string }>;
    overall: { stage: string; type1Pct: number };
  }> {
    // In-process metrics give the most accurate current-session numbers.
    const { type1Count, type2Count, shrugCount } = this.arbitration.getMetrics();
    const total = type1Count + type2Count + shrugCount;
    const currentType1Pct = total > 0 ? type1Count / total : 0;

    try {
      const result = await this.timescale.query<{
        session_id: string;
        type1_count: string;
        total_count: string;
      }>(
        `SELECT
           session_id,
           COUNT(*) FILTER (WHERE payload->>'type' = 'TYPE_1') AS type1_count,
           COUNT(*) AS total_count
         FROM events
         WHERE type = 'ARBITRATION_COMPLETE'
         GROUP BY session_id
         ORDER BY MIN(timestamp) ASC
         LIMIT 100`,
      );

      const sessions = result.rows.map((row) => {
        const t1 = parseInt(row.type1_count, 10);
        const tot = parseInt(row.total_count, 10);
        const type1Pct = tot > 0 ? t1 / tot : 0;
        return {
          sessionId: row.session_id,
          type1Pct,
          stage: this.classifyStage(type1Pct),
        };
      });

      const overallPct = sessions.length > 0
        ? currentType1Pct
        : 0;

      return {
        sessions,
        overall: {
          stage: this.classifyStage(overallPct),
          type1Pct: overallPct,
        },
      };
    } catch (err) {
      this.logger.error('developmentalStage TimescaleDB query failed', err);
      return {
        sessions: [],
        overall: {
          stage: this.classifyStage(currentType1Pct),
          type1Pct: currentType1Pct,
        },
      };
    }
  }

  /**
   * GET /metrics/observatory/session-comparison
   *
   * Returns per-session event counts and arbitration outcome breakdowns for
   * side-by-side session comparison in the telemetry dashboard.
   */
  @Get('observatory/session-comparison')
  @Public()
  async sessionComparison(): Promise<{ sessions: Array<{ sessionId: string; totalEvents: number; type1: number; type2: number; shrug: number }> }> {
    try {
      const result = await this.timescale.query<{
        session_id: string;
        total_events: string;
        type1_count: string;
        type2_count: string;
        shrug_count: string;
      }>(
        `SELECT
           session_id,
           COUNT(*) AS total_events,
           COUNT(*) FILTER (WHERE type = 'ARBITRATION_COMPLETE' AND payload->>'type' = 'TYPE_1') AS type1_count,
           COUNT(*) FILTER (WHERE type = 'ARBITRATION_COMPLETE' AND payload->>'type' = 'TYPE_2') AS type2_count,
           COUNT(*) FILTER (WHERE type = 'ARBITRATION_COMPLETE' AND payload->>'type' = 'SHRUG') AS shrug_count
         FROM events
         GROUP BY session_id
         ORDER BY MIN(timestamp) ASC
         LIMIT 100`,
      );
      const sessions = result.rows.map((row) => ({
        sessionId: row.session_id,
        totalEvents: parseInt(row.total_events, 10),
        type1: parseInt(row.type1_count, 10),
        type2: parseInt(row.type2_count, 10),
        shrug: parseInt(row.shrug_count, 10),
      }));
      return { sessions };
    } catch (err) {
      this.logger.error('sessionComparison TimescaleDB query failed', err);
      return { sessions: [] };
    }
  }

  /**
   * GET /metrics/observatory/comprehension-accuracy
   *
   * Returns per-session prediction accuracy data from TimescaleDB.
   * Queries PREDICTION_EVALUATED events (if they exist) grouped by session.
   */
  @Get('observatory/comprehension-accuracy')
  @Public()
  async comprehensionAccuracy(): Promise<{ sessions: Array<{ sessionId: string; mae: number; sampleCount: number }> }> {
    // The in-process window is the authoritative current-session source.
    const { mae: currentMae, sampleCount: currentSamples } =
      this.attractorMonitor.getPredictionMAESummary();

    try {
      const result = await this.timescale.query<{
        session_id: string;
        avg_mae: string;
        sample_count: string;
      }>(
        `SELECT
           session_id,
           AVG((payload->>'mae')::numeric) AS avg_mae,
           COUNT(*) AS sample_count
         FROM events
         WHERE type = 'PREDICTION_EVALUATED'
           AND payload->>'mae' IS NOT NULL
         GROUP BY session_id
         ORDER BY MIN(timestamp) ASC
         LIMIT 100`,
      );

      const sessions = result.rows.map((row) => ({
        sessionId: row.session_id,
        mae: parseFloat(row.avg_mae),
        sampleCount: parseInt(row.sample_count, 10),
      }));

      // Prepend current in-process data if it has samples and is not already
      // represented (the current session may not have flushed to TimescaleDB yet).
      if (currentSamples > 0) {
        const snapshot = this.driveReader.getCurrentState();
        const alreadyPresent = sessions.some((s) => s.sessionId === snapshot.sessionId);
        if (!alreadyPresent) {
          sessions.push({
            sessionId: snapshot.sessionId,
            mae: currentMae,
            sampleCount: currentSamples,
          });
        }
      }

      return { sessions };
    } catch (err) {
      this.logger.error('comprehensionAccuracy TimescaleDB query failed', err);
      const sessions: Array<{ sessionId: string; mae: number; sampleCount: number }> = [];
      if (currentSamples > 0) {
        const snapshot = this.driveReader.getCurrentState();
        sessions.push({ sessionId: snapshot.sessionId, mae: currentMae, sampleCount: currentSamples });
      }
      return { sessions };
    }
  }

  /**
   * GET /metrics/observatory/phrase-recognition
   *
   * Returns the cumulative phrase recognition ratio from the WKG.
   * Queries Neo4j WORLD for Utterance nodes grouped by provenance type.
   */
  @Get('observatory/phrase-recognition')
  @Public()
  async phraseRecognition(): Promise<{
    totalUtterances: number;
    recognizedCount: number;
    ratio: number;
    byProvenance: Record<string, number>;
  }> {
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'READ');
    try {
      const result = await session.run(
        `MATCH (n:Utterance)
         RETURN
           n.provenance_type AS provenance,
           count(*) AS cnt`,
      );

      const byProvenance: Record<string, number> = {};
      let totalUtterances = 0;
      let recognizedCount = 0;

      for (const record of result.records) {
        const prov = (record.get('provenance') as string | null) ?? 'UNKNOWN';
        const cnt = (record.get('cnt') as { toNumber(): number }).toNumber();
        byProvenance[prov] = cnt;
        totalUtterances += cnt;
        // SENSOR and GUARDIAN utterances have been grounded — count as recognized
        if (prov === 'SENSOR' || prov === 'GUARDIAN') {
          recognizedCount += cnt;
        }
      }

      const ratio = totalUtterances > 0 ? recognizedCount / totalUtterances : 0;
      return { totalUtterances, recognizedCount, ratio, byProvenance };
    } catch (err) {
      this.logger.error('phraseRecognition Neo4j query failed', err);
      return { totalUtterances: 0, recognizedCount: 0, ratio: 0, byProvenance: {} };
    } finally {
      await session.close();
    }
  }

  // ---------------------------------------------------------------------------
  // Private metric computation helpers
  // ---------------------------------------------------------------------------

  /**
   * Compute Type1Type2Ratio from ArbitrationService in-process counters.
   *
   * Uses the lifetime accumulated counts from the current process. The window
   * size is the total decisions seen since startup (or since the last
   * resetMetrics() call). Returns NaN ratio when no decisions have been made.
   *
   * CANON §Development Metrics: "Type 1 / Type 2 ratio — Autonomy from LLM — Increasing over time"
   */
  private computeType1Type2Ratio(computedAt: Date): Type1Type2Ratio {
    const { type1Count, type2Count, shrugCount } = this.arbitration.getMetrics();
    const windowSize = type1Count + type2Count + shrugCount;
    const ratio = windowSize > 0 ? type1Count / (type1Count + type2Count) : NaN;
    return { type1Count, type2Count, ratio, windowSize, computedAt };
  }

  /**
   * Compute PredictionMAEMetric from AttractorMonitorService rolling window.
   *
   * The attractor monitor maintains a rolling window of the last 50 prediction
   * evaluations. Metric is unreliable (per CANON) if sampleCount < 10.
   *
   * CANON §Development Metrics: "Prediction MAE — World model accuracy — Decreasing, then stabilizing"
   */
  private computePredictionMAE(computedAt: Date): PredictionMAEMetric {
    const { mae, sampleCount, windowSize } =
      this.attractorMonitor.getPredictionMAESummary();
    return { mae, sampleCount, windowSize, computedAt };
  }

  /**
   * Compute ProvenanceRatio from Neo4j WORLD instance.
   *
   * Queries all nodes (Entity label or any node) and groups by provenance_type.
   * Edges are intentionally excluded — this tracks the knowledge node population.
   * Returns zero counts on query failure (does not throw; dashboard must tolerate
   * transient Neo4j unavailability).
   *
   * CANON §Development Metrics: "Experiential provenance ratio — Self-constructed
   * vs LLM-provided knowledge — Increasing over time"
   */
  private async computeProvenanceRatio(computedAt: Date): Promise<ProvenanceRatio> {
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'READ');
    try {
      const result = await session.run(
        `MATCH (n)
         RETURN n.provenance_type AS provenance, count(*) AS cnt`,
      );

      let sensor = 0;
      let guardian = 0;
      let llmGenerated = 0;
      let inference = 0;
      let total = 0;

      for (const record of result.records) {
        const prov = (record.get('provenance') as string | null) ?? 'UNKNOWN';
        const cnt = (record.get('cnt') as { toNumber(): number }).toNumber();
        total += cnt;
        if (prov === 'SENSOR') sensor = cnt;
        else if (prov === 'GUARDIAN') guardian = cnt;
        else if (prov === 'LLM_GENERATED') llmGenerated = cnt;
        else if (prov === 'INFERENCE') inference = cnt;
      }

      const experientialRatio = total > 0
        ? (sensor + guardian + inference) / total
        : NaN;

      return { sensor, guardian, llmGenerated, inference, total, experientialRatio, computedAt };
    } catch (err) {
      this.logger.error('computeProvenanceRatio Neo4j query failed', err);
      return {
        sensor: 0, guardian: 0, llmGenerated: 0, inference: 0,
        total: 0, experientialRatio: NaN, computedAt,
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Compute BehavioralDiversityIndex from TimescaleDB recent ARBITRATION_COMPLETE events.
   *
   * Queries the last 20 ARBITRATION_COMPLETE events and counts distinct
   * `payload.type` values (TYPE_1, TYPE_2, SHRUG) as a proxy for action
   * type diversity. This is a structural diversity measure — full action type
   * diversity requires the action category field to be populated in the payload,
   * which the current arbitration event schema does not include.
   *
   * Returns windowSize: 0 and sampleCount: 0 when no events exist.
   *
   * CANON §Development Metrics: "Behavioral diversity index — Unique action types
   * per 20-action window — Stable at 4-8"
   */
  private async computeBehavioralDiversityIndex(computedAt: Date): Promise<BehavioralDiversityIndex> {
    try {
      const result = await this.timescale.query<{
        unique_types: string;
        window_size: string;
      }>(
        `SELECT
           COUNT(DISTINCT payload->>'type') AS unique_types,
           COUNT(*) AS window_size
         FROM (
           SELECT payload
           FROM events
           WHERE type = 'ARBITRATION_COMPLETE'
           ORDER BY timestamp DESC
           LIMIT 20
         ) recent`,
      );

      const row = result.rows[0];
      if (!row) {
        return { uniqueActionTypes: 0, windowSize: 0, index: 0, computedAt };
      }

      const uniqueActionTypes = parseInt(row.unique_types, 10);
      const windowSize = parseInt(row.window_size, 10);
      const index = windowSize > 0 ? uniqueActionTypes / windowSize : 0;

      return { uniqueActionTypes, windowSize, index, computedAt };
    } catch (err) {
      this.logger.error('computeBehavioralDiversityIndex TimescaleDB query failed', err);
      return { uniqueActionTypes: 0, windowSize: 0, index: 0, computedAt };
    }
  }

  /**
   * Compute GuardianResponseRate from TimescaleDB event pairs.
   *
   * Counts SOCIAL_COMMENT_INITIATED events as initiations, then for each,
   * checks whether a guardian input event (GUARDIAN_CONFIRMATION or any event
   * from the COMMUNICATION subsystem) followed within 30 seconds.
   *
   * When no initiation events exist yet, returns { initiated: 0, responded: 0,
   * rate: NaN } — NaN signals "no data" per the type contract.
   *
   * CANON §Development Metrics: "Guardian response rate to comments — Quality
   * of self-initiated conversation — Increasing over time"
   */
  private async computeGuardianResponseRate(computedAt: Date): Promise<GuardianResponseRate> {
    try {
      // Count initiations in the last 24 hours
      const initiationResult = await this.timescale.query<{ initiated: string }>(
        `SELECT COUNT(*) AS initiated
         FROM events
         WHERE type = 'SOCIAL_COMMENT_INITIATED'
           AND timestamp > NOW() - INTERVAL '24 hours'`,
      );

      const initiated = parseInt(initiationResult.rows[0]?.initiated ?? '0', 10);

      if (initiated === 0) {
        return { initiated: 0, responded: 0, rate: NaN, computedAt };
      }

      // Count how many initiations received a guardian response within 30 seconds.
      // A guardian response is any event from the COMMUNICATION subsystem that
      // follows a SOCIAL_COMMENT_INITIATED event within 30s.
      const responseResult = await this.timescale.query<{ responded: string }>(
        `SELECT COUNT(DISTINCT e1.id) AS responded
         FROM events e1
         JOIN events e2
           ON e2.session_id = e1.session_id
          AND e2.timestamp > e1.timestamp
          AND e2.timestamp <= e1.timestamp + INTERVAL '30 seconds'
          AND e2.type IN ('GUARDIAN_CONFIRMATION', 'GUARDIAN_INPUT_RECEIVED')
         WHERE e1.type = 'SOCIAL_COMMENT_INITIATED'
           AND e1.timestamp > NOW() - INTERVAL '24 hours'`,
      );

      const responded = parseInt(responseResult.rows[0]?.responded ?? '0', 10);
      const rate = initiated > 0 ? responded / initiated : NaN;

      return { initiated, responded, rate, computedAt };
    } catch (err) {
      this.logger.error('computeGuardianResponseRate TimescaleDB query failed', err);
      return { initiated: 0, responded: 0, rate: NaN, computedAt };
    }
  }

  /**
   * Compute InteroceptiveAccuracy as a point-in-time self vs actual drive comparison.
   *
   * Uses the current DriveSnapshot's totalPressure as the `actual` value,
   * normalized to [0.0, 1.0] by dividing by the maximum possible pressure (12.0,
   * one unit per drive at full negative pressure). The `selfReported` value is
   * approximated from the same snapshot's cognitive awareness drive, which
   * represents Sylphie's current metacognitive state.
   *
   * When the Drive Engine is in cold-start (tickNumber === 0), returns
   * accuracy: 0 and selfReported: 0 to signal pre-connection state.
   *
   * CANON §Development Metrics: "Interoceptive accuracy — Self-awareness
   * fidelity — Improving toward >0.6"
   * CANON Standard 1 (Theater Prohibition): accuracy < 0.6 is a warning.
   */
  private computeInteroceptiveAccuracy(computedAt: Date): InteroceptiveAccuracy {
    const snapshot = this.driveReader.getCurrentState();

    // Cold-start: no real tick yet
    if (snapshot.tickNumber === 0) {
      return { selfReported: 0, actual: 0, accuracy: 0, computedAt };
    }

    // Normalize totalPressure (max 12.0 = all 12 drives at full pressure) to [0, 1]
    const MAX_TOTAL_PRESSURE = 12.0;
    const actual = Math.min(1.0, snapshot.totalPressure / MAX_TOTAL_PRESSURE);

    // Self-reported: use cognitiveAwareness drive as the self-model proxy.
    // This is the drive that tracks Sylphie's awareness of her own state.
    // cognitiveAwareness is in the pressureVector as a signed value — normalize
    // it from [-1, 1] to [0, 1] for comparison with actual.
    const rawCogAwareness = snapshot.pressureVector[DriveName.CognitiveAwareness] ?? 0;
    const selfReported = (rawCogAwareness + 1.0) / 2.0;

    const accuracy = 1.0 - Math.abs(selfReported - actual);

    return { selfReported, actual, accuracy, computedAt };
  }

  /**
   * Compute MeanDriveResolutionTime per drive from TimescaleDB.
   *
   * Queries the events table for DRIVE_PRESSURE_ELEVATED and DRIVE_PRESSURE_RESOLVED
   * event pairs. For each drive, pairs the start and end events by session and
   * computes the elapsed milliseconds.
   *
   * Only drives with sampleCount >= 5 are included in the result map
   * (per HealthMetrics type contract).
   *
   * Returns empty map when no resolution events exist yet.
   *
   * CANON §Development Metrics: "Mean drive resolution time — Efficiency of
   * need satisfaction — Decreasing over time"
   */
  private async computeMeanDriveResolutionTimes(
    computedAt: Date,
  ): Promise<Readonly<Partial<Record<string, MeanDriveResolutionTime>>>> {
    try {
      const result = await this.timescale.query<{
        drive: string;
        mean_ms: string;
        sample_count: string;
      }>(
        `SELECT
           e1.payload->>'drive' AS drive,
           AVG(
             EXTRACT(EPOCH FROM (e2.timestamp - e1.timestamp)) * 1000
           ) AS mean_ms,
           COUNT(*) AS sample_count
         FROM events e1
         JOIN events e2
           ON e2.session_id = e1.session_id
          AND e2.type = 'DRIVE_PRESSURE_RESOLVED'
          AND (e2.payload->>'drive') = (e1.payload->>'drive')
          AND e2.timestamp > e1.timestamp
          AND e2.timestamp <= e1.timestamp + INTERVAL '5 minutes'
         WHERE e1.type = 'DRIVE_PRESSURE_ELEVATED'
           AND e1.payload->>'drive' IS NOT NULL
         GROUP BY e1.payload->>'drive'`,
      );

      const resolutionTimes: Partial<Record<string, MeanDriveResolutionTime>> = {};

      for (const row of result.rows) {
        const sampleCount = parseInt(row.sample_count, 10);
        // CANON: omit drives with insufficient data (sampleCount < 5)
        if (sampleCount < 5) continue;
        resolutionTimes[row.drive] = {
          drive: row.drive,
          meanMs: parseFloat(row.mean_ms),
          sampleCount,
          computedAt,
        };
      }

      return resolutionTimes;
    } catch (err) {
      // TK-112: surface the failure instead of silently returning {} — a
      // {} here was previously indistinguishable from "no drives crossed
      // the 5-sample CANON-omission threshold yet" (a real, healthy state)
      // vs. the query itself failing (e.g. the ambiguous-column bug this
      // ticket fixes, or a genuine connection failure). Logged with
      // context and rethrown so the caller sees a real error, not a
      // false-negative empty snapshot.
      this.logger.error(
        `computeMeanDriveResolutionTimes TimescaleDB query failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        err instanceof Error ? err.stack : undefined,
      );
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Classify a Type 1 percentage into a developmental stage name.
   *
   * Thresholds are based on CANON §Development Metrics autonomy trajectory:
   *   pre-autonomy  : type1Pct < 0.20 (LLM dependency dominant)
   *   emerging      : 0.20 <= type1Pct < 0.50 (reflexes forming)
   *   consolidating : 0.50 <= type1Pct < 0.80 (majority reflexes)
   *   autonomous    : type1Pct >= 0.80 (reflexes dominate)
   */
  private classifyStage(type1Pct: number): string {
    if (type1Pct >= 0.80) return 'autonomous';
    if (type1Pct >= 0.50) return 'consolidating';
    if (type1Pct >= 0.20) return 'emerging';
    return 'pre-autonomy';
  }
}
