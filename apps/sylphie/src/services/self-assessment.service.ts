import { Injectable, Logger } from '@nestjs/common';
import {
  Neo4jService,
  Neo4jInstanceName,
  DriveName,
  verboseFor,
  type SelfAssessmentPayload,
  type SelfAssessmentProvenance,
} from '@sylphie/shared';

const vlog = verboseFor('Knowledge');

// ---------------------------------------------------------------------------
// KG-Self snapshot compute (Phase 4 Wave 2, cluster 3a — Ticket 1)
//
// MAIN reads the Grafeo/Neo4j SELF graph and builds a SelfAssessmentPayload that
// the apps push path sends to the Drive Engine (event-judge model; the drive
// never queries MAIN). This service ONLY reads SELF and computes — three-graph
// isolation is absolute: it never touches WORLD or OTHER to fabricate a
// self-assessment.
//
// CANON enforced here (the rest is enforced drive-side on ingest):
//   - Std-2 provenance-required: every emitted datum carries the truthful
//     provenance read off its SELF node (defaulting to INFERENCE, never
//     GUARDIAN, when a node lacks an explicit provenance_type).
//   - Std-3 confidence ceiling: capability confidence is clamped ≤ 0.60 unless
//     the node's own provenance is GUARDIAN. (The drive re-clamps defensively;
//     we clamp at the source so the pushed payload is already honest.)
//   - Empty SELF graph → empty arrays, NEVER fabricated capabilities. The
//     bootstrap CoBeing/identity Attribute facts are NOT capabilities and are
//     deliberately ignored here.
//
// Capability `name` values are constrained to the Drive Engine's
// CAPABILITY_TO_DRIVE_MAP keys; any other name is dropped (the drive ignores
// unknown names anyway, but we filter at the source to keep the payload clean).
// ---------------------------------------------------------------------------

/** Std-3 ceiling for non-GUARDIAN-sourced capability confidence. */
export const CONFIDENCE_CEILING = 0.6;

/**
 * The only capability names that can influence a drive baseline. Mirrors the
 * Drive Engine's CAPABILITY_TO_DRIVE_MAP keys (self-evaluation.ts). Kept as a
 * local Set rather than importing the map to avoid coupling MAIN to a drive
 * internal — the contract is the four string keys, fixed by ipc.types.ts.
 */
export const KNOWN_CAPABILITY_NAMES: ReadonlySet<string> = new Set([
  'social_interaction',
  'knowledge_retrieval',
  'prediction_accuracy',
  'error_correction',
]);

/** Map a SELF-graph DrivePattern node's drive string to a DriveName, or null. */
function toDriveName(raw: string): DriveName | null {
  const candidate = (Object.values(DriveName) as string[]).find((d) => d === raw);
  return (candidate as DriveName | undefined) ?? null;
}

/** Normalize a stored provenance_type to a SelfAssessmentProvenance value. */
export function toAssessmentProvenance(raw: string | null): SelfAssessmentProvenance {
  switch (raw) {
    case 'GUARDIAN':
      return 'GUARDIAN';
    case 'GUARDIAN_APPROVED_INFERENCE':
      return 'GUARDIAN_APPROVED_INFERENCE';
    case 'SYSTEM_BOOTSTRAP':
      return 'SYSTEM_BOOTSTRAP';
    // Anything else (including null / 'INFERENCE' / unknown) is treated as an
    // unverified inference — the conservative, honest default. We NEVER promote
    // an unknown provenance to GUARDIAN.
    default:
      return 'INFERENCE';
  }
}

/**
 * Std-3 confidence clamp: capability confidence may exceed the 0.60 ceiling
 * ONLY when the provenance is GUARDIAN. Pure; exported for unit testing.
 */
export function clampCapabilityConfidence(
  rawConfidence: number,
  provenance: SelfAssessmentProvenance,
): number {
  const c = clamp01(rawConfidence);
  return provenance === 'GUARDIAN' ? c : Math.min(c, CONFIDENCE_CEILING);
}

@Injectable()
export class SelfAssessmentService {
  private readonly logger = new Logger(SelfAssessmentService.name);

  constructor(private readonly neo4j: Neo4jService) {}

  /**
   * Read the SELF graph and compute the current self-assessment snapshot.
   *
   * Returns a payload with empty arrays (not null) when the SELF graph contains
   * no Capability / DrivePattern / PredictionAccuracy nodes — which is the case
   * at bootstrap. The apps push path may send the empty payload (drive degrades
   * to safe-neutral) or skip the push; that decision belongs to the apps agent.
   *
   * On a SELF read failure this returns an empty INFERENCE payload rather than
   * throwing — never fabricate, never block the push cadence.
   */
  async computeSelfAssessment(): Promise<SelfAssessmentPayload> {
    const assessedAt = new Date();
    try {
      const [capabilities, drivePatterns, predictionAccuracy] = await Promise.all([
        this.readCapabilities(),
        this.readDrivePatterns(),
        this.readPredictionAccuracy(),
      ]);

      // Payload provenance is the STRONGEST provenance present across the data:
      // if any datum is guardian-sourced the snapshot as a whole is at least
      // GUARDIAN_APPROVED_INFERENCE-grade; otherwise it is INFERENCE. An empty
      // graph yields INFERENCE (a truthful "I have nothing verified to say").
      const provenance = this.aggregateProvenance(
        capabilities.map((c) => c.provenance),
      );

      vlog('KG-Self assessment computed', {
        capabilities: capabilities.length,
        drivePatterns: drivePatterns.length,
        predictionAccuracy: predictionAccuracy.length,
        provenance,
      });

      return {
        assessedAt,
        capabilities: capabilities.map(({ provenance: _p, ...rest }) => rest),
        drivePatterns,
        predictionAccuracy,
        provenance,
      };
    } catch (err) {
      this.logger.warn(
        `KG-Self assessment read failed → empty INFERENCE payload: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return {
        assessedAt,
        capabilities: [],
        drivePatterns: [],
        predictionAccuracy: [],
        provenance: 'INFERENCE',
      };
    }
  }

  // -------------------------------------------------------------------------
  // SELF-graph readers (each returns [] when its node type is absent)
  // -------------------------------------------------------------------------

  /**
   * Read :Capability nodes. Only the four CAPABILITY_TO_DRIVE_MAP names survive.
   * confidence is clamped to ≤0.60 unless the node's provenance is GUARDIAN.
   */
  private async readCapabilities(): Promise<
    Array<{
      id: string;
      name: string;
      successRate: number;
      confidence: number;
      sampleCount: number;
      lastExecuted: Date;
      provenance: SelfAssessmentProvenance;
    }>
  > {
    const session = this.neo4j.getSession(Neo4jInstanceName.SELF, 'READ');
    try {
      const result = await session.run(
        `MATCH (c:Capability)
         WHERE c.name IS NOT NULL
         RETURN c.node_id        AS id,
                c.name           AS name,
                c.success_rate   AS success_rate,
                c.confidence     AS confidence,
                c.sample_count   AS sample_count,
                c.last_executed  AS last_executed,
                c.provenance_type AS provenance_type`,
      );

      const out: Array<{
        id: string;
        name: string;
        successRate: number;
        confidence: number;
        sampleCount: number;
        lastExecuted: Date;
        provenance: SelfAssessmentProvenance;
      }> = [];

      for (const rec of result.records) {
        const name = asString(rec.get('name'));
        if (!KNOWN_CAPABILITY_NAMES.has(name)) continue; // never fabricate names

        const provenance = toAssessmentProvenance(asNullableString(rec.get('provenance_type')));
        // Std-3: clamp confidence unless guardian-sourced.
        const confidence = clampCapabilityConfidence(asNumber(rec.get('confidence'), 0), provenance);

        out.push({
          id: asString(rec.get('id')) || `self-cap-${name}`,
          name,
          successRate: clamp01(asNumber(rec.get('success_rate'), 0)),
          confidence,
          sampleCount: Math.max(0, Math.round(asNumber(rec.get('sample_count'), 0))),
          lastExecuted: asDate(rec.get('last_executed'), this.epoch()),
          provenance,
        });
      }
      return out;
    } finally {
      await session.close();
    }
  }

  /** Read :DrivePattern nodes (informational; not used for baseline reduction). */
  private async readDrivePatterns(): Promise<SelfAssessmentPayload['drivePatterns'][number][]> {
    const session = this.neo4j.getSession(Neo4jInstanceName.SELF, 'READ');
    try {
      const result = await session.run(
        `MATCH (p:DrivePattern)
         WHERE p.drive IS NOT NULL
         RETURN p.drive             AS drive,
                p.stimulus          AS stimulus,
                p.response_strength AS response_strength,
                p.examples          AS examples,
                p.last_observed     AS last_observed,
                p.confidence        AS confidence`,
      );

      const out: SelfAssessmentPayload['drivePatterns'][number][] = [];
      for (const rec of result.records) {
        const drive = toDriveName(asString(rec.get('drive')));
        if (!drive) continue; // unknown drive name → drop, never invent
        out.push({
          drive,
          stimulus: asString(rec.get('stimulus')),
          responseStrength: clamp01(asNumber(rec.get('response_strength'), 0)),
          examples: asStringArray(rec.get('examples')),
          lastObserved: asDate(rec.get('last_observed'), this.epoch()),
          confidence: clamp01(asNumber(rec.get('confidence'), 0)),
        });
      }
      return out;
    } finally {
      await session.close();
    }
  }

  /** Read :PredictionAccuracy nodes (informational; Integrity context). */
  private async readPredictionAccuracy(): Promise<
    SelfAssessmentPayload['predictionAccuracy'][number][]
  > {
    const session = this.neo4j.getSession(Neo4jInstanceName.SELF, 'READ');
    try {
      const result = await session.run(
        `MATCH (a:PredictionAccuracy)
         WHERE a.domain IS NOT NULL
         RETURN a.domain       AS domain,
                a.mae          AS mae,
                a.sample_count AS sample_count,
                a.confidence   AS confidence,
                a.last_updated AS last_updated`,
      );

      const out: SelfAssessmentPayload['predictionAccuracy'][number][] = [];
      for (const rec of result.records) {
        const domain = asString(rec.get('domain'));
        if (!domain) continue;
        out.push({
          domain,
          mae: Math.max(0, asNumber(rec.get('mae'), 0)),
          sampleCount: Math.max(0, Math.round(asNumber(rec.get('sample_count'), 0))),
          confidence: clamp01(asNumber(rec.get('confidence'), 0)),
          lastUpdated: asDate(rec.get('last_updated'), this.epoch()),
        });
      }
      return out;
    } finally {
      await session.close();
    }
  }

  /**
   * Aggregate per-datum provenance into a single payload-level provenance.
   * GUARDIAN if any datum is guardian-confirmed; GUARDIAN_APPROVED_INFERENCE if
   * any is guardian-approved; otherwise INFERENCE. (SYSTEM_BOOTSTRAP collapses
   * to INFERENCE at the payload level — bootstrap data is unverified.)
   */
  private aggregateProvenance(
    provenances: SelfAssessmentProvenance[],
  ): SelfAssessmentProvenance {
    if (provenances.includes('GUARDIAN')) return 'GUARDIAN';
    if (provenances.includes('GUARDIAN_APPROVED_INFERENCE')) {
      return 'GUARDIAN_APPROVED_INFERENCE';
    }
    return 'INFERENCE';
  }

  /** Stable epoch sentinel for missing timestamps. */
  private epoch(): Date {
    return new Date(0);
  }
}

// ---------------------------------------------------------------------------
// Neo4j driver value coercion helpers.
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

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => asString(x)).filter((s) => s.length > 0);
  return [];
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

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Coerce a Neo4j temporal / ISO string / Date to a JS Date, else fallback. */
function asDate(v: unknown, fallback: Date): Date {
  if (v == null) return fallback;
  if (v instanceof Date) return v;
  // neo4j-driver temporal types expose toString() → ISO-ish; Date can parse it.
  if (typeof v === 'object' && v !== null && 'toString' in v) {
    const parsed = new Date(String(v));
    return Number.isNaN(parsed.getTime()) ? fallback : parsed;
  }
  if (typeof v === 'string' || typeof v === 'number') {
    const parsed = new Date(v);
    return Number.isNaN(parsed.getTime()) ? fallback : parsed;
  }
  return fallback;
}
