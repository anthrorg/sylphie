/**
 * Shared WKG information-gain diff primitives (Phase 4 Wave 2, cluster 3a —
 * Ticket 2 / §A.14).
 *
 * MAIN computes a real before/after diff of the World Knowledge Graph attributed
 * to ONE action and pushes `informationGainMetrics` for the Drive Engine to judge.
 * The drive never queries the WKG (event-judge model, no drive→main read path):
 * the producer only computes and exposes the metric.
 *
 * This module holds the SHARED, dependency-free pieces of that compute so every
 * WKG-touching producer uses ONE honesty gate instead of a private copy:
 *   - the snapshot node-state / snapshot / result types,
 *   - the canonical snapshot Cypher (WKG_SNAPSHOT_CYPHER),
 *   - the pure attribution math (computeInformationGain).
 *
 * Two concrete services depend on it and supply their own Neo4j session:
 *   - apps/sylphie WkgDiffService  (communication fast-fact world write)
 *   - decision-making WkgDiffService (latent/WKG write-back, learned reflexes)
 *
 * CANON honesty gate (Std-2 provenance-required): the metric is emitted as
 * `WKG_DIFF` ONLY when the diff is cleanly attributable to THIS action via its
 * `last_action_id` marker. If a snapshot is missing, or a concurrent writer
 * touched the graph between the snapshots such that per-action attribution is
 * unsafe, the result is `UNVERIFIED` — the Drive Engine then grants ZERO
 * curiosity relief. We never emit WKG_DIFF with guessed numbers. Honest-red is
 * the correct fallback.
 */

/**
 * A captured snapshot of one WKG node's state at a moment in time.
 *
 * Per node we record only what the diff needs:
 *   - confidence (for confidenceDeltas)
 *   - lastActionId: the value of the node's action-attribution marker
 *     (`last_action_id`), if the writer stamped one. Used to attribute new
 *     nodes / confidence increases to THIS action and NOT to a concurrent
 *     writer. `null` when the node carries no marker.
 *   - unresolvedPredictionError marker (for resolvedErrors).
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
export const UNVERIFIED_INFORMATION_GAIN: InformationGainResult = Object.freeze({
  newNodes: 0,
  confidenceDeltas: 0,
  resolvedErrors: 0,
  source: 'UNVERIFIED',
});

/**
 * The canonical Cypher a producer runs against the WORLD graph to capture a
 * snapshot. Shared so both producers read the SAME fields (drift here would
 * silently break attribution for one of them). Returns one row per node_id:
 * node_id, confidence, last_action_id, prediction_error, error_resolved.
 */
export const WKG_SNAPSHOT_CYPHER = `MATCH (n)
WHERE n.node_id IS NOT NULL
RETURN n.node_id            AS node_id,
       n.confidence         AS confidence,
       n.last_action_id     AS last_action_id,
       n.prediction_error   AS prediction_error,
       n.error_resolved     AS error_resolved`;

/** An empty, failed snapshot (capture error → forces UNVERIFIED downstream). */
export function emptyFailedWkgSnapshot(): WkgSnapshot {
  return { captured: false, nodes: new Map(), capturedAt: new Date() };
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
 *     (a writer that doesn't stamp last_action_id → honest-red).
 *
 * @param before  snapshot taken before the action
 * @param after   snapshot taken after the action's writes landed
 * @param actionId the WKG node id of the action (the attribution key)
 */
export function computeInformationGain(
  before: WkgSnapshot,
  after: WkgSnapshot,
  actionId: string,
): InformationGainResult {
  // Missing / failed snapshots → cannot attribute.
  if (!before.captured || !after.captured) {
    return UNVERIFIED_INFORMATION_GAIN;
  }
  if (!actionId) {
    return UNVERIFIED_INFORMATION_GAIN;
  }

  let newNodes = 0;
  let confidenceDeltas = 0;
  let resolvedErrors = 0;

  // Concurrency detection: did any change in the window carry a foreign,
  // non-null attribution marker? If so, attribution to THIS action is unsafe.
  let foreignWriterSeen = false;
  // Did we observe ANY attribution marker for this action? Without at least
  // one, a non-empty diff is unattributable (the honest-red path).
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
    return UNVERIFIED_INFORMATION_GAIN;
  }

  // Graph changed but nothing was attributable to this action (no markers).
  // Honest-red: emitting WKG_DIFF here would be guessing.
  if (graphChanged && !ownMarkerSeen) {
    return UNVERIFIED_INFORMATION_GAIN;
  }

  // Clean attribution (possibly an all-zero no-op diff, which is honest and
  // earns zero relief but is still a valid WKG_DIFF).
  return {
    newNodes,
    confidenceDeltas: confidenceDeltas > 0 ? confidenceDeltas : 0,
    resolvedErrors,
    source: 'WKG_DIFF',
  };
}

// ---------------------------------------------------------------------------
// Neo4j driver value coercion helpers (driver returns Integer/null wrappers).
// Shared so both producers parse snapshot rows identically.
// ---------------------------------------------------------------------------

export function wkgDiffAsString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return String(v);
}

export function wkgDiffAsNullableString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.length > 0 ? v : null;
  return String(v);
}

export function wkgDiffAsNumber(v: unknown, fallback: number): number {
  if (v == null) return fallback;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && v !== null && 'toNumber' in v) {
    return (v as { toNumber(): number }).toNumber();
  }
  const parsed = Number(v);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function wkgDiffAsBool(v: unknown): boolean {
  return v === true;
}
