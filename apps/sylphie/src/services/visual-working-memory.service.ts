import { Injectable, Logger, OnModuleInit, Optional, Inject } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  Neo4jService,
  Neo4jInstanceName,
  TimescaleService,
  type SceneSnapshot,
  type TrackedObjectDTO,
} from '@sylphie/shared';
import { FaceSnapshotService } from './face-snapshot.service';
import { PersonModelService } from './person-model.service';

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

/** Cosine similarity threshold for matching against stored object embeddings. */
const OBJECT_MATCH_THRESHOLD = 0.75;

/** IoU threshold for re-associating a new track with a leaving entity. */
const REASSOCIATION_IOU_THRESHOLD = 0.3;

/** Max entities to keep in memory (prune oldest 'gone' entries). */
const MAX_SCENE_ENTITIES = 100;

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
  /** 1280D embedding for cosine matching (from tracker). */
  embedding: number[] | null;
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
      await this.timescale.query(`
        CREATE TABLE IF NOT EXISTS visual_object_embeddings (
          id              TEXT PRIMARY KEY,
          node_id         TEXT NOT NULL,
          label           TEXT NOT NULL,
          display_name    TEXT,
          embedding       vector(1280),
          confidence      FLOAT NOT NULL DEFAULT 0.40,
          discovered      BOOLEAN NOT NULL DEFAULT false,
          created_at      TIMESTAMPTZ NOT NULL,
          last_seen_at    TIMESTAMPTZ,
          sighting_count  INTEGER DEFAULT 1
        )
      `);
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

      // Person identification (sticky — try on each frame while unidentified)
      if (entity.state !== 'gone' && !entity.personId && entity.label === 'person' && entity.embedding) {
        const personId = this.faceSnapshot.identifyFace(entity.embedding);
        if (personId) {
          entity.personId = personId;
          entity.discovered = true;
          entity.displayName = personId;
          this.logger.log(`VWM: face identified → ${personId} for entity ${entity.id}`);
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
  }

  // ---------------------------------------------------------------------------
  // Entity creation
  // ---------------------------------------------------------------------------

  private createEntity(track: TrackedObjectDTO, now: number): void {
    const entityId = randomUUID();

    // Check for person identification immediately
    let personId: string | null = null;
    let discovered = false;
    if (track.label === 'person' && track.embedding) {
      personId = this.faceSnapshot.identifyFace(track.embedding);
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
      } else {
        // Unknown person — create a placeholder OKG node and start collecting snapshots
        await this.createUnknownPersonNode(entity);
      }
      return;
    }

    // Search visual_object_embeddings by cosine similarity
    if (entity.embedding && this.schemaReady && this.timescale) {
      try {
        const result = await this.timescale.query<{
          node_id: string;
          label: string;
          display_name: string | null;
          discovered: boolean;
          distance: number;
        }>(
          `SELECT node_id, label, display_name, discovered,
                  embedding <=> $1::vector AS distance
           FROM visual_object_embeddings
           WHERE embedding IS NOT NULL
           ORDER BY distance
           LIMIT 1`,
          [`[${entity.embedding.join(',')}]`],
        );

        if (result.rows.length > 0) {
          const match = result.rows[0];
          const similarity = 1 - match.distance;

          if (similarity >= OBJECT_MATCH_THRESHOLD) {
            // Known object — associate with existing WKG node
            entity.nodeId = match.node_id;
            entity.displayName = match.display_name;
            entity.discovered = match.discovered;

            // Update sighting count
            await this.timescale.query(
              `UPDATE visual_object_embeddings
               SET last_seen_at = NOW(), sighting_count = sighting_count + 1
               WHERE node_id = $1`,
              [match.node_id],
            ).catch(() => {});

            this.logger.log(
              `VWM: matched known object: ${entity.displayName ?? entity.label} ` +
              `(sim=${similarity.toFixed(3)}, node=${entity.nodeId})`,
            );
            return;
          }
        }
      } catch (err) {
        this.logger.debug(`VWM: embedding search failed: ${err}`);
      }
    }

    // No match — create new WKG node for undiscovered object
    await this.createUndiscoveredNode(entity);
  }

  private async createUndiscoveredNode(entity: SceneEntity): Promise<void> {
    const nodeId = `vobj-${randomUUID().substring(0, 8)}`;
    entity.nodeId = nodeId;
    entity.discovered = false;

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
             n.created_at = datetime()
           RETURN n.node_id AS id`,
          { nodeId, label: entity.label },
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
          `INSERT INTO visual_object_embeddings
             (id, node_id, label, embedding, confidence, discovered, created_at)
           VALUES ($1, $2, $3, $4::vector, $5, false, NOW())
           ON CONFLICT (id) DO NOTHING`,
          [
            randomUUID(),
            nodeId,
            entity.label,
            `[${entity.embedding.join(',')}]`,
            entity.confidence,
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

    // Store face embedding in face_embeddings table for future matching
    if (entity.embedding && this.timescale) {
      try {
        await this.timescale.query(
          `INSERT INTO face_embeddings (id, person_id, angle, embedding, created_at)
           VALUES ($1, $2, 'frontal', $3::vector, NOW())
           ON CONFLICT (id) DO NOTHING`,
          [randomUUID(), placeholderId, `[${entity.embedding.join(',')}]`],
        );
        // Update FaceSnapshotService hot layer centroid
        this.faceSnapshot.updateCentroid(placeholderId, entity.embedding);
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
