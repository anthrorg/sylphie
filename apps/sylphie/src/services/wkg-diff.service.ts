import { Injectable, Logger } from '@nestjs/common';
import { Neo4jService, Neo4jInstanceName, verboseFor } from '@sylphie/shared';

const vlog = verboseFor('Knowledge');

// ---------------------------------------------------------------------------
// WKG-diff compute (Phase 4 Wave 2, cluster 3a — Ticket 2 / §A.14)
//
// MAIN computes a real before/after diff of the World Knowledge Graph attributed
// to ONE action and pushes `informationGainMetrics` for the Drive Engine to judge.
// The drive never queries the WKG (event-judge model, no drive→main read path):
// this service only computes and exposes the metric. The apps reporter wraps a
// WKG-touching action with captureWkgSnapshot() before/after and calls
// computeInformationGain() to build the payload field.
//
// CANON honesty gate (Std-2 provenance-required): the metric is emitted as
// `WKG_DIFF` ONLY when the diff is cleanly attributable to THIS action. If a
// snapshot is missing, or a concurrent writer touched the graph between the
// snapshots such that per-action attribution is unsafe, the result is
// `UNVERIFIED` — the Drive Engine then grants ZERO curiosity relief. We never
// emit WKG_DIFF with guessed numbers. Honest-red is the correct fallback.
// ---------------------------------------------------------------------------

/**
 * A captured snapshot of the WKG node-set at a moment in time.
 *
 * Per node we record only what the diff needs:
 *   - confidence (for confidenceDeltas)
 *   - lastActionId: the value of the node's action-attribution marker
 *     (`last_action_id`), if the writer stamped one. Used to attribute new
 *     nodes / confidence increases to THIS action and NOT to a concurrent
 *     writer. `null` when the node carries no marker.
 *   - resolved / predictionError markers (for resolvedErrors).
 *
 * The snapshot also records whether the capture itself succeeded. A failed
 * capture (Neo4j unavailable) forces UNVERIFIED downstream — we never guess.
 */
export interface WkgNodeState {
  /** Node confidence at capture time. */
  readonly confidence: number;
  /**
   * Value of the node's `last_action_id` attribution marker, or null if the
   * node does not carry one. A node is attributable to an action only when
   * this equals that action's id.
   */
  readonly lastActionId: string | null;
  /**
   * Whether this node is an unresolved prediction-error marker at capture time.
   * True when the node is tagged `prediction_error = true` and not yet resolved.
   */
  readonly unresolvedPredictionError: boolean;
}

export interface WkgSnapshot {
  /** Whether the capture completed successfully. False forces UNVERIFIED. */
  readonly captured: boolean;
  /** node_id → state at capture time. Empty when captured is false. */
  readonly nodes: ReadonlyMap<string, WkgNodeState>;
  /** Wall-clock time of capture (diagnostics only). */
  readonly capturedAt: Date;
}

/**
 * The information-gain metric matching ActionOutcomePayload.informationGainMetrics.
 * `source` carries the provenance the Drive Engine honesty-gates on.
 */
export interface InformationGainResult {
  readonly newNodes: number;
  readonly confidenceDeltas: number;
  readonly resolvedErrors: number;
  readonly source: 'WKG_DIFF' | 'UNVERIFIED';
}

/** UNVERIFIED result with zeroed counts — drive grants zero relief. */
const UNVERIFIED: InformationGainResult = Object.freeze({
  newNodes: 0,
  confidenceDeltas: 0,
  resolvedErrors: 0,
  source: 'UNVERIFIED',
});

/** An empty, failed snapshot (capture error → forces UNVERIFIED). */
function emptyFailedSnapshot(): WkgSnapshot {
  return { captured: false, nodes: new Map(), capturedAt: new Date() };
}

@Injectable()
export class WkgDiffService {
  private readonly logger = new Logger(WkgDiffService.name);

  constructor(private readonly neo4j: Neo4jService) {}

  /**
   * Capture a before/after snapshot of the WORLD graph node-set + confidences
   * + per-node action-attribution markers. Call once immediately BEFORE a
   * WKG-touching action dispatches and once AFTER its writes have landed, then
   * pass both to computeInformationGain().
   *
   * On any failure the returned snapshot has `captured: false`, which forces a
   * downstream UNVERIFIED result (honest-red) rather than a guessed diff.
   */
  async captureWkgSnapshot(): Promise<WkgSnapshot> {
    const t0 = Date.now();
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'READ');
    try {
      const result = await session.run(
        `MATCH (n)
         WHERE n.node_id IS NOT NULL
         RETURN n.node_id            AS node_id,
                n.confidence         AS confidence,
                n.last_action_id     AS last_action_id,
                n.prediction_error   AS prediction_error,
                n.error_resolved     AS error_resolved`,
      );

      const nodes = new Map<string, WkgNodeState>();
      for (const rec of result.records) {
        const nodeId = asString(rec.get('node_id'));
        if (!nodeId) continue;
        nodes.set(nodeId, {
          confidence: asNumber(rec.get('confidence'), 0),
          lastActionId: asNullableString(rec.get('last_action_id')),
          // An unresolved prediction-error marker: flagged as an error and not
          // yet marked resolved.
          unresolvedPredictionError:
            asBool(rec.get('prediction_error')) && !asBool(rec.get('error_resolved')),
        });
      }

      vlog('WKG-diff: snapshot captured', { nodes: nodes.size, latencyMs: Date.now() - t0 });
      return { captured: true, nodes, capturedAt: new Date() };
    } catch (err) {
      this.logger.warn(
        `WKG snapshot capture failed → diff will be UNVERIFIED: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return emptyFailedSnapshot();
    } finally {
      await session.close();
    }
  }

  /**
   * Diff two WKG snapshots and attribute the gain to ONE action.
   *
   * Attribution rule (the heart of the honesty gate):
   *   A created node or a confidence increase counts toward THIS action ONLY
   *   when the after-node carries `last_action_id === actionId`. Any node
   *   created or raised that carries a DIFFERENT, non-null `last_action_id` is a
   *   concurrent writer's work — its presence between our snapshots means we
   *   cannot safely isolate this action's contribution, so we return UNVERIFIED.
   *
   * Returns UNVERIFIED (zeroed) when:
   *   - either snapshot failed to capture, or
   *   - no after-node attributed to this action carries the marker AND another
   *     writer's marker appeared in the diff window (concurrency), or
   *   - the after-graph shows change but carries NO attribution markers at all
   *     (today's writers don't stamp last_action_id yet → honest-red).
   *
   * @param before  snapshot taken before the action
   * @param after   snapshot taken after the action's writes landed
   * @param actionId the WKG procedure node id of the action (the attribution key)
   */
  computeInformationGain(
    before: WkgSnapshot,
    after: WkgSnapshot,
    actionId: string,
  ): InformationGainResult {
    // Missing / failed snapshots → cannot attribute.
    if (!before.captured || !after.captured) {
      vlog('WKG-diff: UNVERIFIED (snapshot missing)', { actionId });
      return UNVERIFIED;
    }
    if (!actionId) {
      vlog('WKG-diff: UNVERIFIED (no actionId)', {});
      return UNVERIFIED;
    }

    let newNodes = 0;
    let confidenceDeltas = 0;
    let resolvedErrors = 0;

    // Concurrency detection: did any change in the window carry a foreign,
    // non-null attribution marker? If so, attribution to THIS action is unsafe.
    let foreignWriterSeen = false;
    // Did we observe ANY attribution marker for this action? Without at least
    // one, a non-empty diff is unattributable (today's honest-red path).
    let ownMarkerSeen = false;
    let graphChanged = false;

    for (const [nodeId, afterState] of after.nodes) {
      const beforeState = before.nodes.get(nodeId);

      if (!beforeState) {
        // Newly created node in the window.
        graphChanged = true;
        if (afterState.lastActionId === actionId) {
          newNodes += 1;
          ownMarkerSeen = true;
        } else if (afterState.lastActionId !== null) {
          foreignWriterSeen = true;
        }
        // New node with no marker at all: counts as change but cannot be
        // attributed to us — handled by the ownMarkerSeen guard below.
        continue;
      }

      // Pre-existing node: look for a positive confidence increase.
      const delta = afterState.confidence - beforeState.confidence;
      if (delta > 0) {
        graphChanged = true;
        if (afterState.lastActionId === actionId) {
          confidenceDeltas += delta;
          ownMarkerSeen = true;
        } else if (afterState.lastActionId !== null) {
          foreignWriterSeen = true;
        }
      }

      // Prediction-error marker flipped from unresolved → resolved.
      if (beforeState.unresolvedPredictionError && !afterState.unresolvedPredictionError) {
        graphChanged = true;
        if (afterState.lastActionId === actionId) {
          resolvedErrors += 1;
          ownMarkerSeen = true;
        } else if (afterState.lastActionId !== null) {
          foreignWriterSeen = true;
        }
      }
    }

    // Concurrency: a different writer's marker appeared in the window.
    if (foreignWriterSeen) {
      vlog('WKG-diff: UNVERIFIED (concurrent writer detected)', { actionId });
      return UNVERIFIED;
    }

    // Graph changed but nothing was attributable to this action (no markers).
    // Honest-red: emitting WKG_DIFF here would be guessing.
    if (graphChanged && !ownMarkerSeen) {
      vlog('WKG-diff: UNVERIFIED (changes carry no action attribution)', { actionId });
      return UNVERIFIED;
    }

    // Clean attribution (possibly an all-zero no-op diff, which is honest and
    // earns zero relief but is still a valid WKG_DIFF).
    vlog('WKG-diff: WKG_DIFF', { actionId, newNodes, confidenceDeltas, resolvedErrors });
    return {
      newNodes,
      confidenceDeltas: confidenceDeltas > 0 ? confidenceDeltas : 0,
      resolvedErrors,
      source: 'WKG_DIFF',
    };
  }
}

// ---------------------------------------------------------------------------
// Neo4j driver value coercion helpers (driver returns Integer/null wrappers).
// ---------------------------------------------------------------------------

function asString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return String(v);
}

function asNullableString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.length > 0 ? v : null;
  return String(v);
}

function asNumber(v: unknown, fallback: number): number {
  if (v == null) return fallback;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && v !== null && 'toNumber' in v) {
    return (v as { toNumber(): number }).toNumber();
  }
  const parsed = Number(v);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function asBool(v: unknown): boolean {
  return v === true;
}
