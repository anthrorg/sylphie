/**
 * ContradictionScannerService — Pre-commit coherence check.
 *
 * Inspired by co-being's Validation Phase (Phase 3): before an action is
 * committed, this service scans the WKG for CONTRADICTS edges connected to
 * the candidate's procedure node. If contradictions exist, the caller
 * (ArbitrationService) may downgrade the result to SHRUG with
 * GapType.CONTRADICTION.
 *
 * This is a lightweight implementation. Heavy contradiction resolution belongs
 * to the Learning subsystem's consolidation pipeline; this service only
 * detects contradictions at the point of action commitment.
 *
 * Neo4j is injected @Optional. If unavailable, the scan returns a clean
 * no-contradiction result rather than blocking the decision cycle.
 *
 * Query:
 *   MATCH (p:ActionProcedure {id: $id})-[:CONTRADICTS]-(c)
 *   RETURN c.claim, c.existingFact, c.confidence
 *
 * CANON §Subsystem 1 (Decision Making): The contradiction scanner is an
 * internal decision-making service. No other module injects it directly.
 *
 * Injection token: CONTRADICTION_SCANNER (decision-making.tokens.ts)
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { Neo4jService, Neo4jInstanceName, type ContradictionScanResult } from '@sylphie/shared';
import type { ActionCandidate, DriveSnapshot } from '@sylphie/shared';
import type { IContradictionScannerService } from '../interfaces/decision-making.interfaces';

// ---------------------------------------------------------------------------
// Neo4j query result shape
// ---------------------------------------------------------------------------

/**
 * Raw row returned by the CONTRADICTS edge query.
 * Narrowed from `unknown` before constructing ContradictionEntry objects.
 */
interface ContradictionRow {
  readonly 'c.claim': string | null;
  readonly 'c.existingFact': string | null;
  readonly 'c.confidence': number | null;
}

function isContradictionRow(value: unknown): value is ContradictionRow {
  return (
    typeof value === 'object' &&
    value !== null &&
    'c.claim' in value &&
    'c.existingFact' in value &&
    'c.confidence' in value
  );
}

// ---------------------------------------------------------------------------
// ContradictionScannerService
// ---------------------------------------------------------------------------

@Injectable()
export class ContradictionScannerService implements IContradictionScannerService {
  private readonly logger = new Logger(ContradictionScannerService.name);

  constructor(
    @Optional() private readonly neo4j: Neo4jService | null,
  ) {}

  /**
   * Scan for contradictions related to the given action candidate.
   *
   * Queries the WKG for CONTRADICTS edges on the candidate's procedure node.
   * If the candidate has no procedure ID (Type 2 novel response) or if Neo4j
   * is unavailable, returns a clean no-contradiction result.
   *
   * The caller is not expected to treat Neo4j unavailability as an error —
   * operating without contradiction scanning is a graceful degradation, not
   * a failure mode.
   *
   * @param candidate     - The action candidate to check.
   * @param driveSnapshot - Current drive state (used only for logging context).
   * @returns ContradictionScanResult indicating whether contradictions exist.
   */
  async scan(
    candidate: ActionCandidate,
    driveSnapshot: DriveSnapshot,
  ): Promise<ContradictionScanResult> {
    // No procedure ID means this is a Type 2 novel response — nothing to scan.
    const procedureId = candidate.procedureData?.id ?? null;
    if (procedureId === null) {
      this.logger.debug(
        'Contradiction scan skipped: candidate has no procedure ID (Type 2 novel).',
      );
      return { hasContradictions: false, contradictions: [] };
    }

    // Neo4j unavailable — degrade gracefully.
    if (!this.neo4j) {
      this.logger.debug(
        `Contradiction scan skipped: Neo4jService unavailable ` +
          `(procedure: ${procedureId}, session: ${driveSnapshot.sessionId}).`,
      );
      return { hasContradictions: false, contradictions: [] };
    }

    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'READ');
    try {
      const result = await session.run(
        'MATCH (p:ActionProcedure {id: $id})-[:CONTRADICTS]-(c) RETURN c.claim, c.existingFact, c.confidence',
        { id: procedureId },
      );

      if (result.records.length === 0) {
        this.logger.debug(
          `Contradiction scan clean: no CONTRADICTS edges for procedure ${procedureId}.`,
        );
        return { hasContradictions: false, contradictions: [] };
      }

      const contradictions = result.records
        .map((record) => record.toObject())
        .filter(isContradictionRow)
        .map((row) => ({
          claim: row['c.claim'] ?? '(unknown claim)',
          existingFact: row['c.existingFact'] ?? '(unknown fact)',
          confidence: row['c.confidence'] ?? 0,
        }));

      this.logger.warn(
        `Contradiction scan found ${contradictions.length} contradiction(s) ` +
          `for procedure ${procedureId}.`,
      );

      return { hasContradictions: contradictions.length > 0, contradictions };
    } catch (err) {
      // A Neo4j query failure is not a blocking error — log and degrade.
      this.logger.warn(
        `Contradiction scan query failed for procedure ${procedureId}: ${err}. ` +
          `Returning no-contradiction result.`,
      );
      return { hasContradictions: false, contradictions: [] };
    } finally {
      await session.close();
    }
  }
}
