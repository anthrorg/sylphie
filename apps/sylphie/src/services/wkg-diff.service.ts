import { Injectable, Logger } from '@nestjs/common';
import {
  Neo4jService,
  Neo4jInstanceName,
  verboseFor,
  WKG_SNAPSHOT_CYPHER,
  computeInformationGain as sharedComputeInformationGain,
  emptyFailedWkgSnapshot,
  wkgDiffAsString,
  wkgDiffAsNullableString,
  wkgDiffAsNumber,
  wkgDiffAsBool,
  type WkgNodeState,
  type WkgSnapshot,
  type InformationGainResult,
} from '@sylphie/shared';

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
// The types, snapshot Cypher, and the attribution math (the honesty gate) live
// in @sylphie/shared (wkg-diff.types) so decision-making's own write-back path
// shares the SAME gate rather than a private copy. This service is the thin
// apps-side Neo4j wrapper around them.
//
// CANON honesty gate (Std-2 provenance-required): the metric is emitted as
// `WKG_DIFF` ONLY when the diff is cleanly attributable to THIS action. If a
// snapshot is missing, or a concurrent writer touched the graph between the
// snapshots such that per-action attribution is unsafe, the result is
// `UNVERIFIED` — the Drive Engine then grants ZERO curiosity relief. We never
// emit WKG_DIFF with guessed numbers. Honest-red is the correct fallback.
// ---------------------------------------------------------------------------

// Re-export the shared types so existing apps-side importers keep working.
export type { WkgNodeState, WkgSnapshot, InformationGainResult };

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
      const result = await session.run(WKG_SNAPSHOT_CYPHER);

      const nodes = new Map<string, WkgNodeState>();
      for (const rec of result.records) {
        const nodeId = wkgDiffAsString(rec.get('node_id'));
        if (!nodeId) continue;
        nodes.set(nodeId, {
          confidence: wkgDiffAsNumber(rec.get('confidence'), 0),
          lastActionId: wkgDiffAsNullableString(rec.get('last_action_id')),
          // An unresolved prediction-error marker: flagged as an error and not
          // yet marked resolved.
          unresolvedPredictionError:
            wkgDiffAsBool(rec.get('prediction_error')) && !wkgDiffAsBool(rec.get('error_resolved')),
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
      return emptyFailedWkgSnapshot();
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
    // Delegate to the shared honesty gate so apps + decision-making use ONE
    // attribution rule. The verbose log preserves the apps-side diagnostics.
    const result = sharedComputeInformationGain(before, after, actionId);
    vlog(`WKG-diff: ${result.source}`, {
      actionId,
      newNodes: result.newNodes,
      confidenceDeltas: result.confidenceDeltas,
      resolvedErrors: result.resolvedErrors,
    });
    return result;
  }
}
