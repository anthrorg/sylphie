import { Injectable, Logger, OnModuleInit, Optional, Inject } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  Neo4jService,
  Neo4jInstanceName,
  TimescaleService,
  type SceneSnapshot,
  type TrackedObjectDTO,
  verboseFor,
} from '@sylphie/shared';
import { FaceSnapshotService } from './face-snapshot.service';
import { PersonModelService } from './person-model.service';
import {
  BindingService,
  type BindingCandidate,
  type BindingObservation,
} from './binding.service';

const vlog = verboseFor('Perception');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Rolling window size (frames). At 15fps, 30 frames = 2 seconds. */
const PRESENCE_WINDOW_SIZE = 30;

/**
 * Presence ratio thresholds for state transitions.
 * An entity must be consistently present/absent across the rolling window
 * before transitioning — this eliminates per-frame flicker.
 */
const ENTER_RATIO = 0.70;   // Must be confirmed in 70%+ of recent frames to become 'present'
const EXIT_RATIO = 0.20;    // Must drop below 20% presence to start 'leaving'
const GONE_RATIO = 0.0;     // Must be completely absent to become 'gone'

/** Minimum time (ms) in 'leaving' before transitioning to 'gone'. */
const LEAVING_TIMEOUT_MS = 2000;

/**
 * How many nearest candidates to fetch for the multi-signal BindingService (#1).
 * The match / ambiguity thresholds now live in BindingConfig (this replaces the
 * old single-signal `OBJECT_MATCH_THRESHOLD = 0.75` cosine cutoff).
 */
const OBJECT_CANDIDATE_LIMIT = 5;

/** IoU threshold for re-associating a new track with a leaving entity. */
const REASSOCIATION_IOU_THRESHOLD = 0.3;

/** Max entities to keep in memory (prune oldest 'gone' entries). */
const MAX_SCENE_ENTITIES = 100;

/**
 * Current object-embedding version. P3.1 — the live embeddings are now 768-D
 * DINOv2-base = version 2 (was 1280-D EfficientNet-B0 = version 1). Persisted on
 * INSERT and stamped on every centroid fold; the fold GUARD refuses to mix
 * versions, so a 768-D DINOv2 observation can never fold into a legacy 1280-D
 * EfficientNet centroid — and the two legacy v1 rows (whose `embedding` is
 * NULLed by the P3.1 destructive migration) keep `embedding_version=1` and are
 * simply excluded from the candidate SELECT (`WHERE embedding IS NOT NULL`).
 */
const CURRENT_OBJECT_EMBEDDING_VERSION = 2;

/**
 * P3.A — default frame dims for bbox normalization when the sidecar omits
 * frameWidth/frameHeight (legacy / cassette frames). Mirrors the P2.1
 * convention so absent-and-defaulted is zero behavior change.
 */
const DEFAULT_FRAME_W = 640;
const DEFAULT_FRAME_H = 480;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A stable entity in Sylphie's visual working memory. */
interface SceneEntity {
  /** Stable ID (persists across track ID reassignments). */
  id: string;
  /** Current tracker track IDs associated with this entity. */
  trackIds: number[];
  /** YOLO class hint. */
  label: string;
  /** Human-readable name from WKG, or null if undiscovered. */
  displayName: string | null;
  /** WKG node_id, created on first stable appearance. */
  nodeId: string | null;
  /** Face-identified person ID (from OKG). */
  personId: string | null;
  /** Whether this entity has been identified/labeled by the guardian. */
  discovered: boolean;
  /** Bounding box (smoothed). */
  bbox: [number, number, number, number];
  /** When this entity first appeared in the stable scene. */
  enteredAt: number;
  /** When last seen (for departure detection). */
  lastSeenAt: number;
  /** Smoothed confidence. */
  confidence: number;
  /** Lifecycle state driven by rolling presence ratio. */
  state: 'entering' | 'present' | 'leaving' | 'gone';
  /** Rolling window: true = confirmed this frame, false = absent. */
  presenceHistory: boolean[];
  /** Computed presence ratio from the rolling window [0, 1]. */
  presenceRatio: number;
  /** When the entity entered 'leaving' state (for gone timeout). */
  leavingAt: number | null;
  /** Object embedding for cosine matching (from tracker); P3.1 = 768-D DINOv2-base. */
  embedding: number[] | null;
  /**
   * P3.2 — 512-D ArcFace FACE embedding for this entity (person tracks only),
   * carried from the track DTO (gateway → /crop-face). This is the OPEN-12
   * decontamination fix: person identity (identifyFace/matchFace) and the face
   * centroid fold use THIS, never `embedding` (the body-track object vector).
   * Null for non-person entities or when no face crop was available this frame.
   * Refreshed from the freshest sighting (kept, never clobbered to null).
   */
  faceEmbedding: number[] | null;
  /**
   * P3.A — top-K dominant colors of the bbox crop (`[r,g,b]` triples), carried
   * from the TrackedObjectDTO. Session-invariant appearance signal fed to the
   * BindingService (color scorer) and persisted to `dominant_colors`. Null when
   * the sidecar omitted it (legacy/cassette frames) → color signal dropped.
   */
  dominantColors: Array<[number, number, number]> | null;
  /**
   * P3.A — base64 JPEG crop of the bbox region (forward crop retention). Carried
   * from the DTO and persisted to `object_crop_b64` at node creation; NOT a
   * scorer input. Null when crop encoding failed or off-sidecar.
   */
  cropB64: string | null;
  /**
   * P3.A — real camera frame dims (P2.1) carried from the track, used to
   * normalize this entity's bbox to [0,1] before binding/persisting (atlas
   * BLOCKER-2). Undefined for legacy/cassette frames → normalizeBbox defaults
   * to 640×480, keeping cross-resolution comparisons valid.
   */
  frameWidth?: number;
  frameHeight?: number;
  /**
   * WS5 T0.8 — synthetic-frame discriminator carried from the detection DTO.
   * Real sensor frames leave it false; gate-injected (cassette) frames set it
   * true so the WORLD :VisualObject node is marked `synthetic:true` for clean
   * `perception-reset` deletion. provenance_type stays 'SENSOR' regardless
   * (atlas ruling 2026-06-13).
   */
  synthetic: boolean;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Visual Working Memory — stabilizes noisy tracker output into a coherent
 * scene model, cross-references with the WKG to determine what Sylphie
 * "knows," and creates nodes for unrecognized objects.
 *
 * This is the bridge between raw perception (retina) and cognitive awareness
 * (visual cortex). It provides:
 * - Stable scene entities with hysteresis (not per-frame noise)
 * - WKG-backed identity resolution ("that's Jim's coffee mug")
 * - Undiscovered object detection ("I see something I don't recognize")
 * - Text scene descriptions for the deliberation prompt
 */
@Injectable()
export class VisualWorkingMemoryService implements OnModuleInit {
  private readonly logger = new Logger(VisualWorkingMemoryService.name);

  /** Stable scene entities, keyed by entity ID. */
  private readonly entities = new Map<string, SceneEntity>();

  /** Map from tracker track ID → scene entity ID for fast lookup. */
  private readonly trackToEntity = new Map<number, string>();

  /** Schema ready flag for TimescaleDB table. */
  private schemaReady = false;

  constructor(
    @Optional() @Inject(TimescaleService)
    private readonly timescale: TimescaleService | null,
    @Optional() @Inject(Neo4jService)
    private readonly neo4j: Neo4jService | null,
    private readonly faceSnapshot: FaceSnapshotService,
    private readonly personModel: PersonModelService,
    private readonly binding: BindingService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.timescale) {
      await this.ensureSchema();
    } else {
      this.logger.warn('TimescaleService unavailable — VWM will operate without persistence.');
    }
    this.logger.log('Visual Working Memory initialized.');
  }

  // ---------------------------------------------------------------------------
  // Schema
  // ---------------------------------------------------------------------------

  private async ensureSchema(): Promise<void> {
    if (!this.timescale) return;
    try {
      // P3.1 — FRESH installs get vector(768) (DINOv2-base CLS dim). NOTE: this
      // CREATE is IF-NOT-EXISTS, so it does NOT alter an EXISTING table that
      // still has vector(1280) — re-keying a live install is the standalone
      // destructive migration's job (test/fixtures/vision/p3.1-dinov2-migration.sql),
      // deliberately NOT auto-run on restart (atlas: auto-destructive-on-restart
      // is dangerous). ensureSchema stays purely additive.
      await this.timescale.query(`
        CREATE TABLE IF NOT EXISTS visual_object_embeddings (
          id              TEXT PRIMARY KEY,
          node_id         TEXT NOT NULL,
          label           TEXT NOT NULL,
          display_name    TEXT,
          embedding       vector(768),
          confidence      FLOAT NOT NULL DEFAULT 0.40,
          discovered      BOOLEAN NOT NULL DEFAULT false,
          created_at      TIMESTAMPTZ NOT NULL,
          last_seen_at    TIMESTAMPTZ,
          sighting_count  INTEGER DEFAULT 1
        )
      `);
      // P3.A — additive, idempotent upgrade. Existing installs gain the four new
      // A.5 columns; fresh installs already had the base CREATE above and now get
      // these too. bounding_box / dominant_colors are JSON-string TEXT (the exact
      // string is reused byte-for-byte in the WORLD :VisualObject MERGE so the
      // Timescale TEXT and the Neo4j property stay identical). object_crop_b64 is
      // the forward crop-retention blob (NOT a scorer input — never selected on
      // the hot re-ID path). embedding_version defaults to 1 (the legacy
      // EfficientNet rows); P3.1's DINOv2 swap now writes version 2 on every new
      // INSERT (see CURRENT_OBJECT_EMBEDDING_VERSION).
      await this.timescale.query(
        `ALTER TABLE visual_object_embeddings ADD COLUMN IF NOT EXISTS bounding_box      TEXT`,
      );
      await this.timescale.query(
        `ALTER TABLE visual_object_embeddings ADD COLUMN IF NOT EXISTS dominant_colors   TEXT`,
      );
      await this.timescale.query(
        `ALTER TABLE visual_object_embeddings ADD COLUMN IF NOT EXISTS object_crop_b64   TEXT`,
      );
      await this.timescale.query(
        `ALTER TABLE visual_object_embeddings ADD COLUMN IF NOT EXISTS embedding_version INTEGER DEFAULT 1`,
      );
      // Index creation may fail if not enough rows yet for ivfflat; catch gracefully.
      try {
        await this.timescale.query(`
          CREATE INDEX IF NOT EXISTS visual_object_embedding_idx
            ON visual_object_embeddings
            USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
        `);
      } catch {
        // ivfflat index needs data to build; will retry later
        this.logger.debug('ivfflat index deferred (needs data).');
      }
      await this.timescale.query(`
        CREATE INDEX IF NOT EXISTS visual_object_node_idx
          ON visual_object_embeddings (node_id)
      `);
      this.schemaReady = true;
      this.logger.log('visual_object_embeddings schema verified.');
    } catch (err) {
      this.logger.warn(`VWM schema creation failed: ${err}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Main update — called each frame from PerceptionGateway
  // ---------------------------------------------------------------------------

  /**
   * Process a scene snapshot from the SceneEventDetector.
   *
   * Uses a **rolling presence window** instead of per-frame reactions.
   * Each entity tracks whether it was confirmed in each of the last N frames.
   * State transitions are driven by the presence ratio across the window:
   *
   *   entering → present: ratio >= 0.70 (confirmed in 70%+ of recent frames)
   *   present → leaving:  ratio <  0.20 (confirmed in <20% of recent frames)
   *   leaving → gone:     ratio == 0.00 AND timeout exceeded
   *
   * This eliminates flicker from objects that bounce between CONFIRMED and
   * LOST every few frames (e.g., edge-of-frame detections near the
   * confidence threshold).
   */
  updateScene(snapshot: SceneSnapshot): void {
    const now = Date.now();
    const confirmedTracks = snapshot.objects.filter(o => o.state === 'confirmed');
    const confirmedTrackIds = new Set(confirmedTracks.map(o => o.trackId));

    // --- Step 1: Create entities for new track IDs ---
    for (const track of confirmedTracks) {
      if (!this.trackToEntity.has(track.trackId)) {
        // Try re-association with a leaving entity first
        const reassociated = this.tryReassociate(track, now);
        if (!reassociated) {
          this.createEntity(track, now);
        }
      }
    }

    // --- Step 2: Update rolling presence window for all entities ---
    for (const [, entity] of this.entities) {
      if (entity.state === 'gone') continue;

      const isPresent = entity.trackIds.some(tid => confirmedTrackIds.has(tid));

      // Push presence into rolling window
      entity.presenceHistory.push(isPresent);
      if (entity.presenceHistory.length > PRESENCE_WINDOW_SIZE) {
        entity.presenceHistory.shift();
      }

      // Compute presence ratio
      const presentCount = entity.presenceHistory.filter(Boolean).length;
      entity.presenceRatio = presentCount / entity.presenceHistory.length;

      // Update bbox/confidence/embedding from the latest matching track
      if (isPresent) {
        entity.lastSeenAt = now;
        const matchingTrack = confirmedTracks.find(t => entity.trackIds.includes(t.trackId));
        if (matchingTrack) {
          entity.bbox = matchingTrack.bbox;
          entity.confidence = matchingTrack.confidence;
          if (matchingTrack.embedding) entity.embedding = matchingTrack.embedding;
          // P3.2 — refresh the ArcFace FACE embedding from the freshest sighting
          // (kept if this frame omitted it; never clobbered to null). This is the
          // person-identity signal, distinct from the body-track `embedding`.
          if (matchingTrack.faceEmbedding) {
            entity.faceEmbedding = matchingTrack.faceEmbedding;
          }
          // P3.A — refresh the appearance color/crop from the freshest sighting
          // (keep the prior value if this frame omitted it, never clobber to null).
          if (matchingTrack.dominantColors) {
            entity.dominantColors = matchingTrack.dominantColors;
          }
          if (matchingTrack.cropB64) entity.cropB64 = matchingTrack.cropB64;
          // Keep frame dims aligned with the latest box's source resolution.
          if (matchingTrack.frameWidth) entity.frameWidth = matchingTrack.frameWidth;
          if (matchingTrack.frameHeight) entity.frameHeight = matchingTrack.frameHeight;
        }
      }

      // --- Step 3: State transitions based on ratio ---
      if (entity.state === 'entering' && entity.presenceRatio >= ENTER_RATIO) {
        entity.state = 'present';
        entity.leavingAt = null;
        this.logger.log(
          `VWM: entity stabilized → present: ${entity.displayName ?? entity.label} ` +
          `(ratio=${entity.presenceRatio.toFixed(2)}, node=${entity.nodeId ?? 'pending'})`,
        );
        vlog('entity stabilized to present', {
          entityId: entity.id,
          label: entity.label,
          displayName: entity.displayName,
          presenceRatio: parseFloat(entity.presenceRatio.toFixed(2)),
          nodeId: entity.nodeId,
        });
        // Trigger WKG matching on transition to present
        void this.resolveEntityIdentity(entity).catch(err =>
          this.logger.warn(`VWM identity resolution failed: ${err}`),
        );
      }

      if (entity.state === 'present' && entity.presenceRatio < EXIT_RATIO) {
        entity.state = 'leaving';
        entity.leavingAt = now;
      }

      // Recover: leaving → present if ratio climbs back
      if (entity.state === 'leaving' && entity.presenceRatio >= ENTER_RATIO) {
        entity.state = 'present';
        entity.leavingAt = null;
      }

      if (entity.state === 'leaving' &&
          entity.presenceRatio <= GONE_RATIO &&
          entity.leavingAt && (now - entity.leavingAt) >= LEAVING_TIMEOUT_MS) {
        entity.state = 'gone';
        this.logger.log(
          `VWM: entity gone: ${entity.displayName ?? entity.label} (${entity.id})`,
        );
        vlog('entity gone', { entityId: entity.id, label: entity.label, displayName: entity.displayName });
        for (const tid of entity.trackIds) {
          this.trackToEntity.delete(tid);
        }
      }

      // Entering entities that drop out before stabilizing
      if (entity.state === 'entering' && entity.presenceHistory.length >= PRESENCE_WINDOW_SIZE &&
          entity.presenceRatio < EXIT_RATIO) {
        entity.state = 'gone';
        for (const tid of entity.trackIds) {
          this.trackToEntity.delete(tid);
        }
      }

      // Person identification (sticky — try on each frame while unidentified).
      // P3.2 PRONG 4 — identify on the ArcFace FACE embedding, NOT the body-track
      // `embedding`. No face crop this frame → no identification attempt (we do
      // NOT fall back to the body track; that was the OPEN-12 contamination).
      if (entity.state !== 'gone' && !entity.personId && entity.label === 'person' && entity.faceEmbedding) {
        const personId = this.faceSnapshot.identifyFace(entity.faceEmbedding);
        if (personId) {
          entity.personId = personId;
          entity.discovered = true;
          entity.displayName = personId;
          this.logger.log(`VWM: face identified → ${personId} for entity ${entity.id}`);
          vlog('person identified in scene', { entityId: entity.id, personId });
        }
      }
    }

    // --- Step 4: Prune old gone entities ---
    if (this.entities.size > MAX_SCENE_ENTITIES) {
      const gone = [...this.entities.entries()]
        .filter(([, e]) => e.state === 'gone')
        .sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
      for (const [id] of gone.slice(0, gone.length - 20)) {
        this.entities.delete(id);
      }
    }

    const presentEntities = [...this.entities.values()].filter(e => e.state === 'present');
    const undiscoveredCount = presentEntities.filter(e => !e.discovered && e.label !== 'person').length;
    const unknownPersonCount = presentEntities.filter(e => !e.discovered && e.label === 'person').length;
    if (presentEntities.length > 0) {
      vlog('scene update', {
        trackedTotal: this.entities.size,
        presentCount: presentEntities.length,
        undiscoveredObjects: undiscoveredCount,
        unknownPersons: unknownPersonCount,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Entity creation
  // ---------------------------------------------------------------------------

  private createEntity(track: TrackedObjectDTO, now: number): void {
    const entityId = randomUUID();

    // Check for person identification immediately. P3.2 PRONG 4 — identify on the
    // ArcFace FACE embedding, NOT the body-track `embedding` (OPEN-12 fix).
    let personId: string | null = null;
    let discovered = false;
    if (track.label === 'person' && track.faceEmbedding) {
      personId = this.faceSnapshot.identifyFace(track.faceEmbedding);
      if (personId) discovered = true;
    }

    const entity: SceneEntity = {
      id: entityId,
      trackIds: [track.trackId],
      label: track.label,
      displayName: personId ? personId : null,
      nodeId: null,
      personId,
      discovered,
      bbox: track.bbox,
      enteredAt: now,
      lastSeenAt: now,
      confidence: track.confidence,
      state: 'entering',
      presenceHistory: [true],
      presenceRatio: 1.0,
      leavingAt: null,
      embedding: track.embedding,
      // P3.2 — carry the ArcFace FACE embedding (person-identity signal).
      faceEmbedding: track.faceEmbedding ?? null,
      // P3.A — carry the appearance color signature + crop from the DTO.
      dominantColors: track.dominantColors ?? null,
      cropB64: track.cropB64 ?? null,
      // P3.A — real frame dims for bbox normalization (atlas BLOCKER-2).
      frameWidth: track.frameWidth,
      frameHeight: track.frameHeight,
      // WS5 T0.8 — carry the synthetic discriminator from the detection DTO.
      synthetic: track.synthetic ?? false,
    };

    this.entities.set(entityId, entity);
    this.trackToEntity.set(track.trackId, entityId);

    this.logger.debug(
      `VWM: new entity entering: ${entity.label} #${track.trackId}` +
      `${personId ? ` (identified: ${personId})` : ''}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Re-association (new track ID for same physical object)
  // ---------------------------------------------------------------------------

  private tryReassociate(track: TrackedObjectDTO, now: number): boolean {
    for (const [, entity] of this.entities) {
      if (entity.state !== 'leaving') continue;
      if (entity.label !== track.label) continue;

      const iou = bboxIoU(entity.bbox, track.bbox);
      if (iou >= REASSOCIATION_IOU_THRESHOLD) {
        // Re-associate
        entity.trackIds.push(track.trackId);
        entity.lastSeenAt = now;
        entity.bbox = track.bbox;
        entity.confidence = track.confidence;
        entity.state = 'present';
        if (track.embedding) entity.embedding = track.embedding;
        // P3.2 — carry the fresh ArcFace FACE embedding on re-association too.
        if (track.faceEmbedding) entity.faceEmbedding = track.faceEmbedding;
        // P3.A — carry the fresh appearance color/crop on re-association too.
        if (track.dominantColors) entity.dominantColors = track.dominantColors;
        if (track.cropB64) entity.cropB64 = track.cropB64;
        if (track.frameWidth) entity.frameWidth = track.frameWidth;
        if (track.frameHeight) entity.frameHeight = track.frameHeight;
        // WS5 T0.8 — once a synthetic track re-associates onto an entity, the
        // entity is synthetic (so its WORLD node, if/when created, is reset-clean).
        if (track.synthetic) entity.synthetic = true;

        this.trackToEntity.set(track.trackId, entity.id);

        this.logger.debug(
          `VWM: re-associated track #${track.trackId} → entity ${entity.id} (${entity.label}, IoU=${iou.toFixed(2)})`,
        );
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // WKG identity resolution (async, fire-and-forget on state transition)
  // ---------------------------------------------------------------------------

  private async resolveEntityIdentity(entity: SceneEntity): Promise<void> {
    // Persons use face identification, not object embedding matching
    if (entity.label === 'person') {
      if (entity.personId) {
        entity.discovered = true;
        entity.displayName = entity.personId;
        return;
      }

      // Try to match this face against ALL known centroids (known + unknown)
      // before creating a new node. This prevents duplicate unknown person
      // nodes when the same face gets a new track ID from re-detection.
      //
      // P3.2 PRONG 4 — match on the ArcFace FACE embedding, NOT the body-track
      // `embedding`. No face crop → fall through to createUnknownPersonNode
      // (which itself no longer writes the body track — see prongs 1+2). We do
      // NOT match on the body track as a fallback; that was the contamination.
      if (entity.faceEmbedding) {
        const match = this.faceSnapshot.matchFace(entity.faceEmbedding);
        if (match) {
          entity.nodeId = match.personId;
          entity.discovered = !match.personId.startsWith('unknown-person-');
          entity.personId = match.personId;
          entity.displayName = entity.discovered ? match.personId : null;
          // P3.2 PRONG 3 — fold the ArcFace FACE embedding into the centroid for
          // better accuracy (NOT the body-track `embedding`). updateCentroid's
          // dim guard refuses anything != FACE_EMBEDDING_DIM, so a stray vector
          // can never corrupt the centroid.
          this.faceSnapshot.updateCentroid(match.personId, entity.faceEmbedding);
          this.logger.log(
            `VWM: face matched existing ${entity.discovered ? 'known' : 'unknown'} person: ` +
            `${match.personId} (sim=${match.similarity.toFixed(3)})`,
          );
          return;
        }
      }

      // No match — genuinely new face. Create a placeholder OKG node.
      await this.createUnknownPersonNode(entity);
      return;
    }

    // #1 — Multi-signal re-identification. Fetch the top-K nearest candidates by
    // cosine, then let the BindingService decide via the weighted A.5 score
    // (embedding/spatial/color/size/label, Piaget dynamic weights, ambiguity
    // band, surprise flag) — replacing the old single-signal cosine 0.75 cutoff.
    if (entity.embedding && this.schemaReady && this.timescale) {
      try {
        const result = await this.timescale.query<{
          id: string;
          node_id: string;
          label: string;
          display_name: string | null;
          discovered: boolean;
          embedding: string | null;
          // P3.A — JSON-string columns; null on legacy rows (pre-P3.A).
          bounding_box: string | null;
          dominant_colors: string | null;
          embedding_version: number | null;
          sighting_count: number;
          last_seen_ms: number | null;
          distance: number;
        }>(
          // P3.A — fetch bounding_box + dominant_colors (the box/color scorer
          // inputs) and embedding_version (the fold guard). object_crop_b64 is
          // deliberately NOT selected: it's a retention blob, never a scorer
          // input, and pulling a base64 JPEG on every hot re-ID is pure waste.
          `SELECT id, node_id, label, display_name, discovered, embedding,
                  bounding_box, dominant_colors, embedding_version, sighting_count,
                  EXTRACT(EPOCH FROM COALESCE(last_seen_at, created_at)) * 1000 AS last_seen_ms,
                  embedding <=> $1::vector AS distance
           FROM visual_object_embeddings
           WHERE embedding IS NOT NULL
           ORDER BY distance
           LIMIT $2`,
          [`[${entity.embedding.join(',')}]`, OBJECT_CANDIDATE_LIMIT],
        );

        if (result.rows.length > 0) {
          // P3.A — bbox + dominant_colors now ride alongside embedding + label,
          // so all 5 A.5 signals can engage. The stored bounding_box was
          // persisted ALREADY NORMALIZED to [0,1] (see createUndiscoveredNode),
          // so it's directly comparable to the normalized observation box below.
          // parseJsonOrNull drops a corrupt row's box/colors (→ that signal is
          // simply absent for that candidate) rather than throwing. BindingService
          // still renormalizes over the AVAILABLE signals, so a legacy row with
          // null box/colors degrades cleanly to {embedding,label} (atlas #1).
          const candidates: BindingCandidate[] = result.rows.map((r) => ({
            nodeId: r.node_id,
            embedding: parseVectorLiteral(r.embedding),
            bbox: parseJsonOrNull<[number, number, number, number]>(r.bounding_box),
            dominantColors: parseJsonOrNull<Array<[number, number, number]>>(
              r.dominant_colors,
            ),
            labelRaw: r.label,
            confirmationCount: Number(r.sighting_count) || 1,
            lastSeenAtMs: r.last_seen_ms != null ? Number(r.last_seen_ms) : null,
          }));
          const observation: BindingObservation = {
            embedding: entity.embedding,
            // P3.A — normalize the observation box to [0,1] (atlas BLOCKER-2) so
            // it lives in the same space as the stored candidates; cross-resolution
            // IoU/size stay valid (640×480 stored vs 1280×720 obs).
            bbox: normalizeBbox(entity.bbox, entity.frameWidth, entity.frameHeight),
            dominantColors: entity.dominantColors ?? null,
            labelRaw: entity.label,
          };
          const match = this.binding.findMatch(observation, candidates, Date.now());

          // surprise_flag is COMPUTED but deliberately NOT forwarded to a drive
          // event here: its consumer is Fork C (P4), sequenced last. Emitting to
          // a non-existent consumer would violate the theater gate (atlas #4).
          if (match.surpriseFlag) {
            vlog('binding surprise (no drive consumer until P4)', {
              entityId: entity.id,
              label: entity.label,
              confidence: parseFloat(match.confidence.toFixed(3)),
            });
          }

          if (match.matchedNodeId) {
            const row = result.rows.find((r) => r.node_id === match.matchedNodeId);
            if (row) {
              // Known object — associate with existing WKG node.
              entity.nodeId = row.node_id;
              entity.displayName = row.display_name;
              entity.discovered = row.discovered;

              // #2 — Mutable instance centroid. Fold this sighting's embedding
              // into the matched row's stored running mean (incremental mean,
              // mirroring FaceSnapshotService.updateCentroid). Bounded
              // assimilation within the FIXED DINOv2-base space (P3.1) — NOT a
              // learned-backbone drift (stability invariant #2); same fixed dim,
              // so the fused-latent fingerprint is untouched. Mutated in place
              // (no new node) → accommodation without a duplicate :VisualObject.
              // CONCURRENCY: read-in-JS / write-absolute-value, safe under the
              // current SERIAL per-frame resolveEntityIdentity. If ever
              // parallelized, two re-sightings on this row could overwrite each
              // other's fold (count still right via server-side +1, but desyncs
              // from effective N) — guard then with `SELECT … FOR UPDATE` (pgvector
              // 0.8.1 has no scalar ops, so an atomic server-side fold is
              // unavailable). FaceSnapshot shares this shape.
              //
              // P3.A — VERSION GUARD (atlas item 4). Only fold when the stored
              // row's embedding_version matches the CURRENT version (or is
              // NULL/legacy → treated as current and upgraded in the same write).
              // This closes the pre-acknowledged P3 TODO and prevents a 768-D
              // DINOv2 observation (P3.1, version 2) from folding into a legacy
              // 1280-D EfficientNet centroid (version 1) — mixing dims would
              // corrupt the centroid (and pgvector would reject the dim mismatch).
              // On a genuine version mismatch we DON'T fold the embedding — only
              // bump the count + last_seen — and we DON'T overwrite the stored
              // version (the row keeps its own version until a same-version
              // observation or an explicit migration re-bases it).
              const n = Number(row.sighting_count) || 1;
              const storedVersion =
                row.embedding_version == null
                  ? CURRENT_OBJECT_EMBEDDING_VERSION // NULL/legacy → adopt current
                  : Number(row.embedding_version);
              const versionMatches =
                storedVersion === CURRENT_OBJECT_EMBEDDING_VERSION;
              const stored = parseVectorLiteral(row.embedding);
              const updated =
                versionMatches && stored && entity.embedding
                  ? foldObjectCentroid(stored, entity.embedding, n)
                  : null;

              await this.timescale
                .query(
                  updated
                    ? `UPDATE visual_object_embeddings
                       SET last_seen_at = NOW(),
                           sighting_count = sighting_count + 1,
                           embedding = $2::vector,
                           embedding_version = $3
                       WHERE id = $1`
                    : `UPDATE visual_object_embeddings
                       SET last_seen_at = NOW(), sighting_count = sighting_count + 1
                       WHERE id = $1`,
                  updated
                    ? [
                        row.id,
                        `[${updated.join(',')}]`,
                        CURRENT_OBJECT_EMBEDDING_VERSION,
                      ]
                    : [row.id],
                )
                .catch(() => {});

              this.logger.log(
                `VWM: matched known object (binding): ${entity.displayName ?? entity.label} ` +
                  `(score=${match.confidence.toFixed(3)}, node=${entity.nodeId}, ` +
                  `centroid n=${n}→${n + 1}${
                    updated
                      ? ''
                      : versionMatches
                        ? ' (hold)'
                        : ` (version-guard: stored v${storedVersion} ≠ current v${CURRENT_OBJECT_EMBEDDING_VERSION}, count-only)`
                  })`,
              );
              return;
            }
          }

          if (match.ambiguousCandidates.length > 0) {
            // Ambiguous (score in [0.45, 0.75)) — not a confident re-ID. Day-one
            // we surface it and fall through to a new node (the prior sub-0.75
            // behavior); guardian disambiguation of the ambiguous set is future UX.
            vlog('binding ambiguous (no confident re-id)', {
              entityId: entity.id,
              label: entity.label,
              confidence: parseFloat(match.confidence.toFixed(3)),
              candidates: match.ambiguousCandidates.length,
            });
          }
        }
      } catch (err) {
        this.logger.debug(`VWM: embedding search failed: ${err}`);
      }
    }

    // No confident match — create a new WKG node for the undiscovered object.
    await this.createUndiscoveredNode(entity);
  }

  private async createUndiscoveredNode(entity: SceneEntity): Promise<void> {
    const nodeId = `vobj-${randomUUID().substring(0, 8)}`;
    entity.nodeId = nodeId;
    entity.discovered = false;

    // P3.A — serialize the A.5 box/color signals ONCE. The bbox is stored
    // NORMALIZED to [0,1] (atlas BLOCKER-2) so it's directly comparable to a
    // future re-sighting's normalized observation box across resolutions. The
    // EXACT same JSON strings are reused for both the Timescale TEXT columns and
    // the WORLD :VisualObject MERGE properties (byte-identical between stores).
    // dominant_colors / bounding_box are `null` (SQL NULL / Cypher null) when the
    // signal is absent, so a row without color/box simply drops those signals.
    const normalizedBbox = normalizeBbox(
      entity.bbox,
      entity.frameWidth,
      entity.frameHeight,
    );
    const bboxJson = normalizedBbox ? JSON.stringify(normalizedBbox) : null;
    const colorsJson = entity.dominantColors
      ? JSON.stringify(entity.dominantColors)
      : null;
    const cropB64 = entity.cropB64 ?? null;
    const embVersion = CURRENT_OBJECT_EMBEDDING_VERSION;

    // Write to WKG
    if (this.neo4j) {
      const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');
      try {
        await session.run(
          `MERGE (n:Entity:VisualObject {node_id: $nodeId})
           ON CREATE SET
             n.label = $label,
             n.node_type = 'VisualObject',
             n.schema_level = 'instance',
             n.provenance_type = 'SENSOR',
             n.confidence = 0.40,
             n.discovered = false,
             n.yolo_class = $label,
             n.sighting_count = 1,
             n.synthetic = $synthetic,
             n.bounding_box = $bboxJson,
             n.dominant_colors = $colorsJson,
             n.object_crop_b64 = $cropB64,
             n.embedding_version = $embVersion,
             n.created_at = datetime()
           RETURN n.node_id AS id`,
          // WS5 T0.8 (atlas ruling 2026-06-13): provenance_type stays 'SENSOR';
          // the synthetic:true boolean is the SOLE discriminator. Real frames
          // leave entity.synthetic false. perception-reset deletes synthetic nodes.
          // P3.A — bboxJson/colorsJson are the SAME JSON STRINGS persisted to the
          // Timescale TEXT columns (NOT a Cypher list/map — passing a string keeps
          // the WORLD property byte-identical to the TEXT column; a native list
          // would diverge in representation).
          {
            nodeId,
            label: entity.label,
            synthetic: entity.synthetic,
            bboxJson,
            colorsJson,
            cropB64,
            embVersion,
          },
        );
      } catch (err) {
        this.logger.warn(`VWM: WKG node creation failed: ${err}`);
      } finally {
        await session.close();
      }
    }

    // Store embedding in TimescaleDB
    if (entity.embedding && this.schemaReady && this.timescale) {
      try {
        await this.timescale.query(
          // P3.A — persist the four new A.5 columns. bounding_box/dominant_colors
          // are the SAME serialized strings written to the WORLD node above (one
          // serialize, reused). object_crop_b64 is the retention blob.
          // embedding_version = CURRENT_OBJECT_EMBEDDING_VERSION (P3.1: 2 = DINOv2-base-768).
          `INSERT INTO visual_object_embeddings
             (id, node_id, label, embedding, confidence, discovered, created_at,
              bounding_box, dominant_colors, object_crop_b64, embedding_version)
           VALUES ($1, $2, $3, $4::vector, $5, false, NOW(), $6, $7, $8, $9)
           ON CONFLICT (id) DO NOTHING`,
          [
            randomUUID(),
            nodeId,
            entity.label,
            `[${entity.embedding.join(',')}]`,
            entity.confidence,
            bboxJson,
            colorsJson,
            cropB64,
            embVersion,
          ],
        );
      } catch (err) {
        this.logger.warn(`VWM: embedding storage failed: ${err}`);
      }
    }

    this.logger.log(
      `VWM: created undiscovered node: ${entity.label} (node=${nodeId})`,
    );
  }

  /**
   * Create a placeholder Person node in the OKG for an unidentified face.
   * Enables face snapshot collection so the person can be recognized later.
   */
  private async createUnknownPersonNode(entity: SceneEntity): Promise<void> {
    const placeholderId = `unknown-person-${randomUUID().substring(0, 8)}`;
    entity.nodeId = placeholderId;
    entity.discovered = false;
    entity.displayName = null;

    // Create placeholder Person node in OKG
    if (this.neo4j) {
      const session = this.neo4j.getSession(Neo4jInstanceName.OTHER, 'WRITE');
      try {
        await session.run(
          `MERGE (p:Person {node_id: $nodeId})
           ON CREATE SET
             p.username = $placeholderName,
             p.label = $placeholderName,
             p.is_guardian = false,
             p.discovered = false,
             p.created_at = datetime()`,
          { nodeId: placeholderId, placeholderName: `Unknown Person` },
        );
      } catch (err) {
        this.logger.warn(`VWM: OKG placeholder person creation failed: ${err}`);
      } finally {
        await session.close();
      }
    }

    // P3.2 PRONGS 1 + 2 (OPEN-12 decontamination) — store the ArcFace FACE
    // embedding for future matching, NEVER the body-track `entity.embedding`.
    //
    // BEFORE: this INSERTed `entity.embedding` (the 1280-D EfficientNet / 768-D
    // DINOv2 OBJECT-TRACK vector) into face_embeddings (prong 1) AND folded it
    // into the hot-layer centroid (prong 2) — contaminating the face identity
    // space with object-appearance vectors. AFTER: we write/fold ONLY the
    // ArcFace `entity.faceEmbedding`. No face crop this frame → we write NOTHING
    // (the placeholder Person node still exists for snapshot collection to fill
    // in via FaceSnapshotService.processFaceFrame, the proper face-crop path).
    // embedding_version is stamped (2 = ArcFace) for parity with FaceSnapshotService.
    if (entity.faceEmbedding && this.timescale) {
      try {
        await this.timescale.query(
          `INSERT INTO face_embeddings (id, person_id, angle, embedding, created_at, embedding_version)
           VALUES ($1, $2, 'frontal', $3::vector, NOW(), 2)
           ON CONFLICT (id) DO NOTHING`,
          [randomUUID(), placeholderId, `[${entity.faceEmbedding.join(',')}]`],
        );
        // Update FaceSnapshotService hot layer centroid with the FACE embedding.
        // updateCentroid's dim guard (== FACE_EMBEDDING_DIM) refuses any stray
        // non-512-D vector, so contamination cannot re-enter even by accident.
        this.faceSnapshot.updateCentroid(placeholderId, entity.faceEmbedding);
      } catch (err) {
        this.logger.warn(`VWM: face embedding storage for unknown person failed: ${err}`);
      }
    }

    this.logger.log(
      `VWM: created unknown person placeholder (id=${placeholderId})`,
    );
  }

  /**
   * Discover a person — link their placeholder to a real name.
   * Called when someone introduces themselves after Sylphie asks "Who are you?"
   */
  async discoverPerson(placeholderId: string, name: string): Promise<void> {
    // Update in-memory entity
    for (const entity of this.entities.values()) {
      if (entity.nodeId === placeholderId) {
        entity.displayName = name;
        entity.discovered = true;
        break;
      }
    }

    // Update OKG Person node
    if (this.neo4j) {
      const session = this.neo4j.getSession(Neo4jInstanceName.OTHER, 'WRITE');
      try {
        await session.run(
          `MATCH (p:Person {node_id: $nodeId})
           SET p.username = $name,
               p.label = $name,
               p.discovered = true,
               p.updated_at = datetime()`,
          { nodeId: placeholderId, name },
        );
      } catch (err) {
        this.logger.warn(`VWM: discover person update failed: ${err}`);
      } finally {
        await session.close();
      }
    }

    this.logger.log(`VWM: person discovered: ${name} (id=${placeholderId})`);
  }

  // ---------------------------------------------------------------------------
  // Public API — scene description for deliberation
  // ---------------------------------------------------------------------------

  /**
   * Get a human-readable description of the current stable scene.
   * Used in the deliberation prompt "What I see:" section.
   */
  getSceneDescription(): string {
    const visible = [...this.entities.values()]
      .filter(e => e.state === 'present');

    if (visible.length === 0) return '';

    const lines: string[] = [];
    for (const entity of visible) {
      const duration = this.formatDuration(Date.now() - entity.enteredAt);
      const name = entity.displayName ?? entity.label;
      const status = entity.discovered ? '' : ' (unrecognized)';
      const personTag = entity.personId ? ` [${entity.personId}]` : '';

      lines.push(`- ${name}${personTag}${status}, ${entity.state} ${duration}`);
    }

    return lines.join('\n');
  }

  /**
   * Get structured entity data for the frontend recognized-items widget.
   * Returns all visible entities with VWM-resolved identity and state.
   */
  getVisibleEntities(): Array<{
    id: string;
    label: string;
    displayName: string | null;
    type: 'object' | 'face';
    confidence: number;
    discovered: boolean;
    nodeId: string | null;
    personId: string | null;
    state: string;
    duration: number;
    trackIds: number[];
  }> {
    const now = Date.now();
    // Only return entities that have stabilized through the rolling window.
    // 'entering' entities haven't proven consistent enough yet.
    return [...this.entities.values()]
      .filter(e => e.state === 'present')
      .map(e => ({
        id: e.id,
        label: e.label,
        displayName: e.displayName,
        type: (e.label === 'person' ? 'face' : 'object') as 'object' | 'face',
        confidence: e.confidence,
        discovered: e.discovered,
        nodeId: e.nodeId,
        personId: e.personId,
        state: e.state,
        duration: now - e.enteredAt,
        trackIds: e.trackIds,
      }));
  }

  /**
   * Get undiscovered entities currently in view (objects only).
   * Used for curiosity drive routing — each undiscovered object sustains curiosity pressure.
   */
  getUndiscoveredEntities(): SceneEntity[] {
    return [...this.entities.values()]
      .filter(e =>
        !e.discovered &&
        e.label !== 'person' &&
        (e.state === 'present' || e.state === 'entering'),
      );
  }

  /**
   * Get unknown persons currently in view (unidentified faces).
   * Used for social drive routing — unknown people drive social pressure.
   */
  getUnknownPersons(): SceneEntity[] {
    return [...this.entities.values()]
      .filter(e =>
        !e.discovered &&
        e.label === 'person' &&
        (e.state === 'present' || e.state === 'entering'),
      );
  }

  /**
   * Mark an entity as discovered with a human-given name.
   * Called when the guardian answers "What is that?"
   */
  async discoverEntity(nodeId: string, displayName: string): Promise<void> {
    // Update in-memory entity
    for (const entity of this.entities.values()) {
      if (entity.nodeId === nodeId) {
        entity.displayName = displayName;
        entity.discovered = true;
        break;
      }
    }

    // Update WKG node
    if (this.neo4j) {
      const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');
      try {
        await session.run(
          `MATCH (n:VisualObject {node_id: $nodeId})
           SET n.label = $displayName,
               n.discovered = true,
               n.confidence = CASE WHEN 0.60 > n.confidence THEN 0.60 ELSE n.confidence END,
               n.provenance_type = 'GUARDIAN',
               n.updated_at = datetime()`,
          { nodeId, displayName },
        );
      } catch (err) {
        this.logger.warn(`VWM: discover node update failed: ${err}`);
      } finally {
        await session.close();
      }
    }

    // Update TimescaleDB embedding record
    if (this.timescale) {
      try {
        await this.timescale.query(
          `UPDATE visual_object_embeddings
           SET display_name = $1, discovered = true, last_seen_at = NOW()
           WHERE node_id = $2`,
          [displayName, nodeId],
        );
      } catch (err) {
        this.logger.warn(`VWM: discover embedding update failed: ${err}`);
      }
    }

    this.logger.log(`VWM: entity discovered: ${displayName} (node=${nodeId})`);
  }

  // ---------------------------------------------------------------------------
  // WS5 T0.7 — gate hermeticity reset
  // ---------------------------------------------------------------------------

  /**
   * Reset visual perception state for a hermetic gate run (WS5 T0.7).
   *
   * Three coupled deletions so a synthetic gate frame leaves NO residue that
   * could contaminate the next run's surprise/novelty (finding 4):
   *   1. Clear the in-memory entity Map + trackToEntity index (VWM has no other
   *      `clear()` today — without this, prior-run entities persist in-process).
   *   2. DETACH DELETE the synthetic WORLD :VisualObject nodes (T0.8). Scoped to
   *      `{synthetic:true}` so genuine SENSOR-grounded world facts are untouched.
   *      WORLD instance is physically separate (isolation-sound per atlas).
   *   3. TRUNCATE visual_object_embeddings — the companion Timescale rows written
   *      at createUndiscoveredNode; without this the embedding store leaks across
   *      runs even after the Neo4j nodes are gone.
   *
   * Returns counts for gate audit. Read-then-write only on the WORLD instance;
   * never touches SELF/OTHER.
   */
  async resetForGate(): Promise<{ entitiesCleared: number; syntheticNodesDeleted: number; embeddingsTruncated: boolean }> {
    const entitiesCleared = this.entities.size;
    this.entities.clear();
    this.trackToEntity.clear();

    let syntheticNodesDeleted = 0;
    if (this.neo4j) {
      const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');
      try {
        const res = await session.run(
          `MATCH (n:VisualObject {synthetic: true})
           DETACH DELETE n
           RETURN count(n) AS deleted`,
        );
        const rec = res.records[0];
        syntheticNodesDeleted = rec ? (rec.get('deleted') as { toNumber(): number }).toNumber() : 0;
      } catch (err) {
        this.logger.warn(`VWM: synthetic WORLD node reset failed: ${err}`);
      } finally {
        await session.close();
      }
    }

    let embeddingsTruncated = false;
    if (this.timescale) {
      try {
        await this.timescale.query('TRUNCATE visual_object_embeddings');
        embeddingsTruncated = true;
      } catch (err) {
        this.logger.warn(`VWM: visual_object_embeddings truncate failed: ${err}`);
      }
    }

    this.logger.warn(
      `VWM reset for gate: cleared ${entitiesCleared} in-memory entit${entitiesCleared === 1 ? 'y' : 'ies'}, ` +
        `deleted ${syntheticNodesDeleted} synthetic WORLD node(s), ` +
        `embeddings truncated=${embeddingsTruncated}.`,
    );
    return { entitiesCleared, syntheticNodesDeleted, embeddingsTruncated };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private formatDuration(ms: number): string {
    if (ms < 1000) return '<1s';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return remainingSeconds > 0 ? `${minutes}m${remainingSeconds}s` : `${minutes}m`;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function bboxIoU(
  a: [number, number, number, number],
  b: [number, number, number, number],
): number {
  const xLeft = Math.max(a[0], b[0]);
  const yTop = Math.max(a[1], b[1]);
  const xRight = Math.min(a[2], b[2]);
  const yBottom = Math.min(a[3], b[3]);

  if (xRight <= xLeft || yBottom <= yTop) return 0;

  const intersection = (xRight - xLeft) * (yBottom - yTop);
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  const union = areaA + areaB - intersection;

  return union > 0 ? intersection / union : 0;
}

/**
 * #2 — Fold a new sighting's embedding into a stored object centroid via the
 * incremental mean `centroid[i] = (centroid[i]*n + next[i]) / (n+1)`, where `n`
 * is the sighting count BEFORE this sighting. Mirrors
 * `FaceSnapshotService.updateCentroid` (face-snapshot.service.ts:535-553) for
 * objects.
 *
 * Because the centroid started equal to the first sighting with `n=1`, repeated
 * folding yields the true running mean of all sightings. This is bounded
 * assimilation within a FIXED embedding space — never a learned-backbone drift
 * (stability invariant #2). Returns a NEW vector (does not mutate `centroid`);
 * defensively no-ops (returns the original centroid) on dimension mismatch or
 * non-positive/NaN `n`, so a malformed stored row never corrupts the centroid.
 */
export function foldObjectCentroid(
  centroid: number[],
  next: number[],
  n: number,
): number[] {
  if (centroid.length === 0) return next.slice();
  if (next.length !== centroid.length || !Number.isFinite(n) || n < 1) {
    return centroid;
  }
  const out = centroid.slice();
  for (let i = 0; i < out.length; i++) {
    out[i] = (out[i] * n + next[i]) / (n + 1);
  }
  return out;
}

/**
 * P3.A (atlas BLOCKER-2) — normalize a pixel-space bbox `[xMin,yMin,xMax,yMax]`
 * to `[0,1]` by the frame dims, so spatial IoU / size ratios are comparable
 * across resolutions (a 640×480 stored box vs a 1280×720 observation would
 * otherwise never overlap in raw pixels). Both the persisted box and the
 * observation box go through this, so they live in the SAME normalized space.
 *
 * `frameWidth`/`frameHeight` default to 640×480 (P2.1 convention) when absent.
 * Returns `null` on a null/degenerate box or non-positive frame dims, so a
 * malformed box simply drops the spatial/size signals rather than poisoning them.
 */
export function normalizeBbox(
  bbox: [number, number, number, number] | null | undefined,
  frameWidth: number | null | undefined,
  frameHeight: number | null | undefined,
): [number, number, number, number] | null {
  if (!bbox || bbox.length !== 4) return null;
  const w = frameWidth && frameWidth > 0 ? frameWidth : DEFAULT_FRAME_W;
  const h = frameHeight && frameHeight > 0 ? frameHeight : DEFAULT_FRAME_H;
  const [xMin, yMin, xMax, yMax] = bbox;
  if (![xMin, yMin, xMax, yMax].every((v) => Number.isFinite(v))) return null;
  return [xMin / w, yMin / h, xMax / w, yMax / h];
}

/**
 * P3.A — parse a JSON-string DB column (`bounding_box`, `dominant_colors`) into
 * its value, mirroring `parseVectorLiteral`'s defensive contract: returns `null`
 * on null/empty/malformed input so a corrupt row DROPS that binding signal
 * rather than throwing on the hot re-ID path. Only arrays/objects are accepted
 * (a bare scalar string column is treated as malformed).
 */
export function parseJsonOrNull<T = unknown>(
  raw: string | null | undefined,
): T | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    return parsed as T;
  } catch {
    return null;
  }
}

/**
 * Parse a pgvector text literal (`'[1,2,3]'`) into a `number[]`. pgvector's text
 * format is valid JSON, so `JSON.parse` suffices. Returns `null` on
 * empty/invalid/non-finite input so the caller falls back to a count-only update
 * rather than writing a corrupted centroid.
 */
export function parseVectorLiteral(
  literal: string | null | undefined,
): number[] | null {
  if (!literal) return null;
  try {
    const parsed: unknown = JSON.parse(literal);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    if (!parsed.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      return null;
    }
    return parsed as number[];
  } catch {
    return null;
  }
}
