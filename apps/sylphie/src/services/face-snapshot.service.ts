/**
 * FaceSnapshotService — Automatic face gallery collection + latent face space.
 *
 * When Sylphie is talking to a user who lacks sufficient face snapshots,
 * this service opportunistically captures face crops from camera frames at
 * multiple head angles (frontal, left, right, up, down) and stores them:
 *
 *   OKG (Neo4j OTHER): FaceSnapshot nodes with crop images + angle metadata
 *   TimescaleDB (pgvector): face_embeddings table for cosine similarity search
 *   Hot layer (in-memory): person → centroid embedding for instant identification
 *
 * The latent face space enables Sylphie to recognize who she's looking at
 * by comparing live face embeddings against stored embeddings.
 */

import {
  Injectable,
  Logger,
  Optional,
  Inject,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Neo4jService,
  Neo4jInstanceName,
  TimescaleService,
  FaceDetection,
  verboseFor,
} from '@sylphie/shared';
import { randomUUID } from 'crypto';

const vlog = verboseFor('Perception');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AngleCategory = 'frontal' | 'left' | 'right' | 'up' | 'down';

const ALL_ANGLES: readonly AngleCategory[] = [
  'frontal',
  'left',
  'right',
  'up',
  'down',
] as const;

/** Face embedding dimension from EfficientNet-B0. */
const FACE_EMBEDDING_DIM = 1280;

/** Result from the Python /perception/crop-face endpoint. */
interface CropResult {
  face_crop_b64: string;
  embedding: number[];
}

/** Hot-layer entry: one person's face embedding centroid. */
interface FaceCentroid {
  personId: string;
  embedding: number[];
  snapshotCount: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Minimum interval between crop attempts (ms). */
const CROP_INTERVAL_MS = 1500;

/** Minimum face detection confidence to attempt a crop. */
const MIN_CONFIDENCE = 0.65;

/** Cosine similarity threshold for face identification. */
const IDENTIFICATION_THRESHOLD = 0.75;

// ---------------------------------------------------------------------------
// Angle classification thresholds
// ---------------------------------------------------------------------------

// Yaw proxy: negative = face turned left, positive = right, range ~[-1, 1]
// Pitch proxy: positive = looking down, negative = looking up, range ~[-0.1, 0.1]
const FRAME_W = 640;
const FRAME_H = 480;

// ---------------------------------------------------------------------------
// FaceSnapshotService
// ---------------------------------------------------------------------------

@Injectable()
export class FaceSnapshotService implements OnModuleInit {
  private readonly logger = new Logger(FaceSnapshotService.name);
  private readonly perceptionHost: string;

  /** Per-person collection state: which angles have been captured. */
  private readonly collectionState = new Map<
    string,
    Map<AngleCategory, boolean>
  >();

  /** Hot-layer face centroids for identification. personId → centroid. */
  private readonly centroids = new Map<string, FaceCentroid>();

  /** Rate limiting: last crop attempt timestamp. */
  private lastCropTime = 0;

  /** Whether the TimescaleDB schema is ready. */
  private schemaReady = false;

  constructor(
    @Optional()
    @Inject(Neo4jService)
    private readonly neo4j: Neo4jService | null,
    @Optional()
    private readonly timescale: TimescaleService | null,
    private readonly config: ConfigService,
  ) {
    this.perceptionHost = this.config.get<string>(
      'PERCEPTION_HOST',
      'http://localhost:8430',
    );
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async onModuleInit(): Promise<void> {
    // OKG constraint
    if (this.neo4j) {
      const session = this.neo4j.getSession(Neo4jInstanceName.OTHER, 'WRITE');
      try {
        await session.run(
          `CREATE CONSTRAINT face_snapshot_id_unique IF NOT EXISTS
           FOR (fs:FaceSnapshot) REQUIRE fs.snapshot_id IS UNIQUE`,
        );
        this.logger.log('OKG FaceSnapshot constraint ensured.');
      } catch (err) {
        this.logger.warn(
          `OKG FaceSnapshot constraint failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        await session.close();
      }
    }

    // TimescaleDB schema for face embeddings
    await this.ensureSchema();

    // Hydrate hot layer from warm layer
    if (this.schemaReady) {
      await this.hydrate();
    }
  }

  // ---------------------------------------------------------------------------
  // Face Identification (public — used by external consumers)
  // ---------------------------------------------------------------------------

  /**
   * Identify who a face belongs to by comparing an embedding against
   * stored centroids. Returns personId if match found, null otherwise.
   */
  identifyFace(embedding: number[]): string | null {
    if (embedding.length === 0) return null;

    let bestPersonId: string | null = null;
    let bestSimilarity = -1;

    for (const centroid of this.centroids.values()) {
      if (centroid.embedding.length === 0) continue;
      const sim = cosineSimilarity(embedding, centroid.embedding);
      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        bestPersonId = centroid.personId;
      }
    }

    if (bestSimilarity >= IDENTIFICATION_THRESHOLD && bestPersonId) {
      this.logger.debug(
        `Face identified: ${bestPersonId} (similarity=${bestSimilarity.toFixed(3)})`,
      );
      return bestPersonId;
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Snapshot Collection (called from PerceptionGateway)
  // ---------------------------------------------------------------------------

  /**
   * Process a frame with face detections for potential snapshot collection.
   * Non-blocking, best-effort. Errors are logged but never thrown.
   *
   * @param personId - Active user ID (from JWT)
   * @param faces    - Face detections from the current frame
   * @param jpegData - Raw JPEG frame bytes
   */
  async processFaceFrame(
    personId: string,
    faces: FaceDetection[],
    jpegData: Buffer,
  ): Promise<void> {
    // Rate limit
    const now = Date.now();
    if (now - this.lastCropTime < CROP_INTERVAL_MS) return;

    // Check if collection is already complete for this person
    if (!this.needsSnapshots(personId)) return;

    // Pick the highest-confidence face
    const primary = faces.reduce((best, f) =>
      f.confidence > best.confidence ? f : best,
    );
    if (primary.confidence < MIN_CONFIDENCE) return;
    if (!primary.landmarks || primary.landmarks.length < 455) return;

    // Classify head angle
    const angle = this.classifyAngle(primary.landmarks);
    if (!angle) return;

    vlog('face frame processed', { personId, faceCount: faces.length, confidence: primary.confidence, angle });

    // Already have this angle?
    const state = this.getOrLoadState(personId);
    if (state.get(angle)) return;

    // Mark rate limit
    this.lastCropTime = now;

    // Request crop + embedding from Python service
    // Pass landmarks so the embedding can be masked to face-only pixels
    const [x1, y1, x2, y2] = primary.bbox;
    let url =
      `${this.perceptionHost}/perception/crop-face` +
      `?x_min=${x1}&y_min=${y1}&x_max=${x2}&y_max=${y2}`;
    if (primary.landmarks && primary.landmarks.length > 10) {
      url += `&landmarks=${encodeURIComponent(JSON.stringify(primary.landmarks))}`;
    }

    let cropResult: CropResult;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg' },
        body: new Uint8Array(jpegData),
      });
      if (!response.ok) return;
      cropResult = (await response.json()) as CropResult;
    } catch {
      return; // Python service unavailable
    }

    if (!cropResult.face_crop_b64) return;

    // Save to OKG + TimescaleDB
    await this.saveSnapshot(
      personId,
      angle,
      cropResult.face_crop_b64,
      cropResult.embedding,
    );

    // Update in-memory state
    state.set(angle, true);

    // Update centroid with new embedding
    if (cropResult.embedding.length > 0) {
      this.updateCentroid(personId, cropResult.embedding);
    }

    // Check completion
    const collected = [...state.values()].filter(Boolean).length;
    this.logger.log(
      `Captured ${angle} snapshot for ${personId} (${collected}/${ALL_ANGLES.length})`,
    );
    vlog('face snapshot stored', { personId, angle, collected, total: ALL_ANGLES.length });

    if (collected >= ALL_ANGLES.length) {
      this.logger.log(
        `Face snapshot collection complete for ${personId}`,
      );
      vlog('face snapshot collection complete', { personId });
    }
  }

  // ---------------------------------------------------------------------------
  // Angle Classification
  // ---------------------------------------------------------------------------

  /**
   * Classify head pose angle from MediaPipe landmarks.
   * Uses the same yaw/pitch proxy math as FaceEncoder.
   *
   * Landmarks used:
   *   1   = nose tip
   *   234 = left cheek
   *   454 = right cheek
   *   159 = left eye top
   *   386 = right eye top
   */
  classifyAngle(landmarks: number[][]): AngleCategory | null {
    const noseTip = landmarks[1];
    const leftCheek = landmarks[234];
    const rightCheek = landmarks[454];
    const leftEye = landmarks[159];
    const rightEye = landmarks[386];

    if (!noseTip || !leftCheek || !rightCheek || !leftEye || !rightEye) {
      return null;
    }

    // Yaw: asymmetry between left/right cheek distances from nose
    const distLeft = Math.abs((noseTip[0] ?? 0) - (leftCheek[0] ?? 0));
    const distRight = Math.abs((noseTip[0] ?? 0) - (rightCheek[0] ?? 0));
    const totalDist = distLeft + distRight;
    const yaw = totalDist > 0 ? (distRight - distLeft) / totalDist : 0;

    // Pitch: vertical offset of nose relative to eye line, normalized
    const eyeLineY = ((leftEye[1] ?? 0) + (rightEye[1] ?? 0)) / 2;
    const pitch = ((noseTip[1] ?? 0) - eyeLineY) / FRAME_H;

    // Classify with dead zones between categories
    const absYaw = Math.abs(yaw);
    const absPitch = Math.abs(pitch);

    if (absYaw < 0.15 && absPitch < 0.06) return 'frontal';
    if (yaw < -0.25 && absPitch < 0.10) return 'left';
    if (yaw > 0.25 && absPitch < 0.10) return 'right';
    if (pitch < -0.04 && absYaw < 0.25) return 'up';
    if (pitch > 0.08 && absYaw < 0.25) return 'down';

    return null; // In dead zone — not useful
  }

  // ---------------------------------------------------------------------------
  // State Management
  // ---------------------------------------------------------------------------

  /** Check whether a person still needs face snapshots. */
  needsSnapshots(personId: string): boolean {
    const state = this.getOrLoadState(personId);
    const collected = [...state.values()].filter(Boolean).length;
    return collected < ALL_ANGLES.length;
  }

  /** Check if collection is complete for a person. */
  isComplete(personId: string): boolean {
    return !this.needsSnapshots(personId);
  }

  /** Number of persons with face data in the hot layer. */
  get knownFaceCount(): number {
    return this.centroids.size;
  }

  private getOrLoadState(
    personId: string,
  ): Map<AngleCategory, boolean> {
    let state = this.collectionState.get(personId);
    if (!state) {
      state = new Map<AngleCategory, boolean>();
      for (const angle of ALL_ANGLES) {
        state.set(angle, false);
      }
      this.collectionState.set(personId, state);
      // Lazy load from OKG (fire-and-forget, will be available next check)
      void this.loadExistingSnapshots(personId).catch(() => {});
    }
    return state;
  }

  // ---------------------------------------------------------------------------
  // OKG Reads
  // ---------------------------------------------------------------------------

  private async loadExistingSnapshots(personId: string): Promise<void> {
    if (!this.neo4j) return;

    const session = this.neo4j.getSession(Neo4jInstanceName.OTHER, 'READ');
    try {
      const result = await session.run(
        `MATCH (p:Person {node_id: $personId})-[:HAS_FACE_SNAPSHOT]->(fs:FaceSnapshot)
         RETURN fs.angle AS angle`,
        { personId },
      );

      const state = this.collectionState.get(personId);
      if (!state) return;

      for (const record of result.records) {
        const angle = record.get('angle') as AngleCategory;
        if (ALL_ANGLES.includes(angle)) {
          state.set(angle, true);
        }
      }

      const collected = [...state.values()].filter(Boolean).length;
      if (collected > 0) {
        this.logger.log(
          `Loaded ${collected} existing snapshots for ${personId}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `OKG snapshot load failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      await session.close();
    }
  }

  // ---------------------------------------------------------------------------
  // OKG + TimescaleDB Writes
  // ---------------------------------------------------------------------------

  private async saveSnapshot(
    personId: string,
    angle: AngleCategory,
    cropB64: string,
    embedding: number[],
  ): Promise<void> {
    const snapshotId = `fsnap-${personId}-${angle}`;

    // Write to OKG
    if (this.neo4j) {
      const session = this.neo4j.getSession(Neo4jInstanceName.OTHER, 'WRITE');
      try {
        await session.run(
          `MATCH (p:Person {node_id: $personId})
           MERGE (fs:FaceSnapshot {snapshot_id: $snapshotId})
           ON CREATE SET
             fs.angle = $angle,
             fs.image_b64 = $cropB64,
             fs.captured_at = datetime()
           ON MATCH SET
             fs.image_b64 = $cropB64,
             fs.updated_at = datetime()
           MERGE (p)-[:HAS_FACE_SNAPSHOT]->(fs)`,
          { personId, snapshotId, angle, cropB64 },
        );
      } catch (err) {
        this.logger.warn(
          `OKG snapshot write failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        await session.close();
      }
    }

    // Write embedding to TimescaleDB warm layer
    if (
      this.timescale &&
      this.schemaReady &&
      embedding.length === FACE_EMBEDDING_DIM
    ) {
      const embeddingLiteral = `[${embedding.join(',')}]`;
      this.timescale
        .query(
          `INSERT INTO face_embeddings (id, person_id, angle, embedding, created_at)
           VALUES ($1, $2, $3, $4::vector, $5)
           ON CONFLICT (id) DO UPDATE SET
             embedding = $4::vector,
             updated_at = NOW()`,
          [
            snapshotId,
            personId,
            angle,
            embeddingLiteral,
            new Date(),
          ],
        )
        .catch((err) => {
          this.logger.warn(
            `Face embedding write failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }
  }

  // ---------------------------------------------------------------------------
  // Centroid Management (hot layer)
  // ---------------------------------------------------------------------------

  /**
   * Update the running centroid for a person by averaging in a new embedding.
   * Simple incremental mean: centroid = (centroid * n + new) / (n + 1)
   */
  updateCentroid(personId: string, embedding: number[]): void {
    const existing = this.centroids.get(personId);

    if (!existing || existing.embedding.length === 0) {
      this.centroids.set(personId, {
        personId,
        embedding: [...embedding],
        snapshotCount: 1,
      });
      return;
    }

    const n = existing.snapshotCount;
    const centroid = existing.embedding;
    for (let i = 0; i < centroid.length && i < embedding.length; i++) {
      centroid[i] = (centroid[i] * n + embedding[i]) / (n + 1);
    }
    existing.snapshotCount = n + 1;
  }

  // ---------------------------------------------------------------------------
  // TimescaleDB Schema + Hydration
  // ---------------------------------------------------------------------------

  private async ensureSchema(): Promise<void> {
    if (!this.timescale) return;

    try {
      await this.timescale.query(
        'CREATE EXTENSION IF NOT EXISTS vector',
      );

      await this.timescale.query(`
        CREATE TABLE IF NOT EXISTS face_embeddings (
          id          TEXT PRIMARY KEY,
          person_id   TEXT NOT NULL,
          angle       TEXT NOT NULL,
          embedding   vector(${FACE_EMBEDDING_DIM}),
          created_at  TIMESTAMPTZ NOT NULL,
          updated_at  TIMESTAMPTZ
        )
      `);

      await this.timescale.query(`
        CREATE INDEX IF NOT EXISTS face_embeddings_person_idx
        ON face_embeddings (person_id)
      `);

      this.schemaReady = true;
      this.logger.log(
        `face_embeddings schema verified (vector(${FACE_EMBEDDING_DIM}))`,
      );
    } catch (err) {
      this.logger.error(
        `Face embeddings schema creation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.schemaReady = false;
    }
  }

  /**
   * Hydrate hot-layer centroids from TimescaleDB on startup.
   * Computes per-person centroid from all stored embeddings.
   */
  private async hydrate(): Promise<void> {
    if (!this.timescale || !this.schemaReady) return;

    try {
      const result = await this.timescale.query<{
        person_id: string;
        angle: string;
        embedding: string;
      }>(
        `SELECT person_id, angle, embedding::text
         FROM face_embeddings
         ORDER BY person_id, created_at`,
      );

      for (const row of result.rows) {
        const embedding = parseEmbedding(row.embedding);
        if (embedding.length === FACE_EMBEDDING_DIM) {
          this.updateCentroid(row.person_id, embedding);
        }

        // Also hydrate collection state
        let state = this.collectionState.get(row.person_id);
        if (!state) {
          state = new Map<AngleCategory, boolean>();
          for (const angle of ALL_ANGLES) state.set(angle, false);
          this.collectionState.set(row.person_id, state);
        }
        if (ALL_ANGLES.includes(row.angle as AngleCategory)) {
          state.set(row.angle as AngleCategory, true);
        }
      }

      this.logger.log(
        `Face latent space hydrated: ${this.centroids.size} persons, ` +
          `${result.rows.length} embeddings`,
      );
    } catch (err) {
      this.logger.warn(
        `Face hydration failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Cosine similarity between two vectors. */
function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

/** Parse a pgvector text representation "[0.1,0.2,...]" into a number array. */
function parseEmbedding(text: string): number[] {
  if (!text || text.length < 3) return [];
  const inner = text.startsWith('[') ? text.slice(1, -1) : text;
  return inner.split(',').map(Number);
}
