/**
 * P3.A — promote the A.5 BindingService from 2 live signals to 5, plus
 * object-crop retention. This spec proves the VWM-side wiring:
 *
 *   • normalizeBbox stores/compares boxes in [0,1] space (atlas BLOCKER-2):
 *     a frame-CENTER box normalizes to the SAME coords at 640×480 and 1280×720,
 *     so cross-resolution IoU is valid.
 *   • parseJsonOrNull drops a corrupt JSON column rather than throwing.
 *   • createUndiscoveredNode persists all four new columns (bounding_box NORMALIZED,
 *     dominant_colors, object_crop_b64, embedding_version = current = 2 at P3.1)
 *     and the WORLD :VisualObject MERGE SETs the SAME JSON STRINGS (byte-identical,
 *     not a list).
 *   • the centroid fold VERSION GUARD refuses a cross-version fold and upgrades a
 *     NULL/legacy version row (folds it as current).
 *
 * P3.1 — CURRENT_OBJECT_EMBEDDING_VERSION flipped 1 → 2 (EfficientNet-1280 →
 * DINOv2-base-768). These specs are version-sensitive: "current" is now 2, a
 * stored v1 row is the CROSS-version (legacy EfficientNet) case, and new
 * INSERT/MERGE writes stamp version 2.
 */

import {
  VisualWorkingMemoryService,
  normalizeBbox,
  parseJsonOrNull,
  parseVectorLiteral,
} from './visual-working-memory.service';
import { BindingService } from './binding.service';
import type { TrackedObjectDTO } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// normalizeBbox — cross-resolution IoU validity (atlas BLOCKER-2)
// ---------------------------------------------------------------------------

describe('normalizeBbox', () => {
  it('a frame-center box normalizes to the SAME [0,1] coords at 640×480 and 1280×720', () => {
    // A box covering the central quarter of the frame (x:[0.25,0.75], y:[0.25,0.75]).
    // 640×480 → x:[160,480], y:[120,360]. 1280×720 → x:[320,960], y:[180,540].
    const lo = normalizeBbox([160, 120, 480, 360], 640, 480); // 640×480
    const hi = normalizeBbox([320, 180, 960, 540], 1280, 720); // 1280×720
    expect(lo).not.toBeNull();
    expect(hi).not.toBeNull();
    // [0.25, 0.25, 0.75, 0.75] at BOTH resolutions → cross-resolution IoU = 1.
    [0.25, 0.25, 0.75, 0.75].forEach((v, i) => {
      expect(lo![i]).toBeCloseTo(v, 10);
      expect(hi![i]).toBeCloseTo(v, 10);
    });
    expect(lo).toEqual(hi);
  });

  it('defaults to 640×480 when frame dims are absent (P2.1 convention)', () => {
    const a = normalizeBbox([64, 48, 128, 96], undefined, undefined);
    const b = normalizeBbox([64, 48, 128, 96], 640, 480);
    expect(a).toEqual(b);
    expect(a).toEqual([0.1, 0.1, 0.2, 0.2]);
  });

  it('round-trips a normalized box back to pixels', () => {
    const norm = normalizeBbox([100, 90, 300, 240], 1000, 600);
    expect(norm).toEqual([0.1, 0.15, 0.3, 0.4]);
    // multiply back by the same dims → original pixels
    const back = norm!.map((v, i) => v * (i % 2 === 0 ? 1000 : 600));
    expect(back).toEqual([100, 90, 300, 240]);
  });

  it('returns null on a null/degenerate box or non-finite coords', () => {
    expect(normalizeBbox(null, 640, 480)).toBeNull();
    expect(normalizeBbox(undefined, 640, 480)).toBeNull();
    expect(normalizeBbox([NaN, 0, 1, 1], 640, 480)).toBeNull();
  });

  it('falls back to defaults when frame dims are non-positive (never divides by 0)', () => {
    const a = normalizeBbox([64, 48, 128, 96], 0, -5);
    expect(a).toEqual([0.1, 0.1, 0.2, 0.2]); // used 640×480
  });
});

describe('parseJsonOrNull', () => {
  it('parses array/object JSON columns', () => {
    expect(parseJsonOrNull('[0.1,0.2,0.3,0.4]')).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(parseJsonOrNull('[[200,50,50]]')).toEqual([[200, 50, 50]]);
  });
  it('returns null on null/empty/malformed/scalar input (drops the signal, never throws)', () => {
    expect(parseJsonOrNull(null)).toBeNull();
    expect(parseJsonOrNull(undefined)).toBeNull();
    expect(parseJsonOrNull('')).toBeNull();
    expect(parseJsonOrNull('{not json')).toBeNull();
    expect(parseJsonOrNull('"a bare string"')).toBeNull(); // scalar → malformed
    expect(parseJsonOrNull('42')).toBeNull(); // scalar
  });
});

// ---------------------------------------------------------------------------
// Component path — persistence of the 4 new columns + WORLD MERGE byte-identity
// ---------------------------------------------------------------------------

const flush = () => new Promise((r) => setImmediate(r));

/** Timescale fake. By default the cosine SELECT returns NO rows → a NEW node
 *  (INSERT) is created, so we can assert the INSERT column set. Sub-classes /
 *  field tweaks drive the fold path. */
class FakeTimescale {
  public queries: Array<{ sql: string; params?: unknown[] }> = [];
  /** When set, the cosine SELECT returns this single candidate row. */
  public selectRow: Record<string, unknown> | null = null;

  async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    this.queries.push({ sql, params });
    if (/embedding <=> \$1::vector/.test(sql)) {
      return { rows: (this.selectRow ? [this.selectRow] : []) as T[] };
    }
    return { rows: [] };
  }

  find(re: RegExp) {
    return this.queries.filter((q) => re.test(q.sql));
  }
}

/** Neo4j fake capturing every session.run(cypher, params). */
class FakeSession {
  constructor(private readonly sink: Array<{ cypher: string; params?: any }>) {}
  async run(cypher: string, params?: any) {
    this.sink.push({ cypher, params });
    return { records: [] };
  }
  async close() {
    /* no-op */
  }
}

class FakeNeo4j {
  public runs: Array<{ cypher: string; params?: any }> = [];
  getSession() {
    return new FakeSession(this.runs) as any;
  }
}

function makeTrack(over: Partial<TrackedObjectDTO> = {}): TrackedObjectDTO {
  return {
    trackId: 1,
    label: 'cup',
    state: 'confirmed',
    bbox: [160, 120, 480, 360], // central quarter of a 640×480 frame
    confidence: 0.9,
    embedding: [1, 0, 0, 0],
    dominantColors: [[200, 50, 50]],
    cropB64: 'ZmFrZS1qcGVn', // "fake-jpeg" base64
    frameWidth: 640,
    frameHeight: 480,
    ...over,
  } as TrackedObjectDTO;
}

function makeVwm(timescale: FakeTimescale, neo4j: FakeNeo4j | null) {
  const faceSnapshot = {
    identifyFace: jest.fn().mockReturnValue(null),
    matchFace: jest.fn().mockReturnValue(null),
    updateCentroid: jest.fn(),
  };
  return new VisualWorkingMemoryService(
    timescale as any,
    neo4j as any,
    faceSnapshot as any,
    {} as any,
    new BindingService(),
  );
}

/** Drive an object through two frames so it stabilizes → resolveEntityIdentity. */
async function sight(vwm: VisualWorkingMemoryService, track: TrackedObjectDTO) {
  const snap = { objects: [track] } as any;
  vwm.updateScene(snap); // create (entering)
  vwm.updateScene(snap); // ratio 1.0 → present → resolve
  await flush();
  await flush();
  await flush();
}

describe('VWM P3.A — INSERT persists all 4 new columns (bbox NORMALIZED)', () => {
  it('createUndiscoveredNode writes bounding_box[0,1] / dominant_colors / object_crop_b64 / embedding_version=2 (P3.1)', async () => {
    const timescale = new FakeTimescale(); // SELECT → no rows → NEW node
    const vwm = makeVwm(timescale, null);
    await vwm.onModuleInit();

    await sight(vwm, makeTrack());

    const inserts = timescale.find(/INSERT INTO visual_object_embeddings/i);
    expect(inserts).toHaveLength(1);
    const sql = inserts[0].sql;
    expect(sql).toMatch(/bounding_box/);
    expect(sql).toMatch(/dominant_colors/);
    expect(sql).toMatch(/object_crop_b64/);
    expect(sql).toMatch(/embedding_version/);

    // Params: [id, node_id, label, embedding, confidence, bbox, colors, crop, ver]
    const p = inserts[0].params!;
    const bboxJson = p[5] as string;
    const colorsJson = p[6] as string;
    const cropB64 = p[7] as string;
    const embVersion = p[8] as number;

    // bbox is stored NORMALIZED to [0,1] (central quarter of 640×480).
    const bbox = JSON.parse(bboxJson);
    expect(bbox).toEqual([0.25, 0.25, 0.75, 0.75]);
    expect(JSON.parse(colorsJson)).toEqual([[200, 50, 50]]);
    expect(cropB64).toBe('ZmFrZS1qcGVn');
    expect(embVersion).toBe(2); // P3.1: CURRENT_OBJECT_EMBEDDING_VERSION = 2 (DINOv2-base)
  });

  it('stored normalized bbox round-trips: re-sighting compares in the SAME [0,1] space', async () => {
    // First sighting at 640×480 → stores [0.25,0.25,0.75,0.75]. A re-sighting at
    // 1280×720 of the same-centered object must produce an OBSERVATION box equal
    // to the stored one (cross-resolution IoU = 1). We assert via normalizeBbox
    // directly (the persisted value and the observation value coincide).
    const storedNorm = normalizeBbox([160, 120, 480, 360], 640, 480);
    const reSightNorm = normalizeBbox([320, 180, 960, 540], 1280, 720);
    expect(storedNorm).toEqual(reSightNorm);
    expect(storedNorm).toEqual([0.25, 0.25, 0.75, 0.75]);
  });

  it('a legacy-style track without colors/crop persists nulls (signal simply absent)', async () => {
    const timescale = new FakeTimescale();
    const vwm = makeVwm(timescale, null);
    await vwm.onModuleInit();

    await sight(
      vwm,
      makeTrack({ dominantColors: undefined, cropB64: undefined }),
    );

    const inserts = timescale.find(/INSERT INTO visual_object_embeddings/i);
    expect(inserts).toHaveLength(1);
    const p = inserts[0].params!;
    // bbox still present (track has a box), but colors + crop are null.
    expect(p[6]).toBeNull(); // dominant_colors
    expect(p[7]).toBeNull(); // object_crop_b64
    expect(p[8]).toBe(2); // embedding_version still stamped (P3.1 current = 2)
  });
});

describe('VWM P3.A — WORLD :VisualObject MERGE SETs the SAME JSON STRINGS', () => {
  it('MERGE passes bboxJson/colorsJson as STRINGS byte-identical to the TEXT columns (not a Cypher list)', async () => {
    const timescale = new FakeTimescale();
    const neo4j = new FakeNeo4j();
    const vwm = makeVwm(timescale, neo4j);
    await vwm.onModuleInit();

    await sight(vwm, makeTrack());

    const merge = neo4j.runs.find((r) => /MERGE \(n:Entity:VisualObject/.test(r.cypher));
    expect(merge).toBeDefined();
    expect(merge!.cypher).toMatch(/n\.bounding_box = \$bboxJson/);
    expect(merge!.cypher).toMatch(/n\.dominant_colors = \$colorsJson/);
    expect(merge!.cypher).toMatch(/n\.object_crop_b64 = \$cropB64/);
    expect(merge!.cypher).toMatch(/n\.embedding_version = \$embVersion/);

    // The Neo4j property values are JSON STRINGS, not native arrays — and they
    // equal the strings written to Timescale (byte-identity across both stores).
    expect(typeof merge!.params.bboxJson).toBe('string');
    expect(typeof merge!.params.colorsJson).toBe('string');
    expect(merge!.params.embVersion).toBe(2); // P3.1 current = 2 (DINOv2-base)

    const insert = timescale.find(/INSERT INTO visual_object_embeddings/i)[0];
    expect(merge!.params.bboxJson).toBe(insert.params![5]); // same bbox string
    expect(merge!.params.colorsJson).toBe(insert.params![6]); // same colors string
    expect(merge!.params.cropB64).toBe(insert.params![7]);
  });
});

// ---------------------------------------------------------------------------
// Centroid fold — version guard (atlas item 4)
// ---------------------------------------------------------------------------

/** A candidate row that re-IDs the [1,0,0,0] observation, with a configurable
 *  stored embedding_version. */
function knownRow(embeddingVersion: number | null) {
  return {
    id: 'row-1',
    node_id: 'vobj-known',
    label: 'cup',
    display_name: 'coffee mug',
    discovered: true,
    embedding: '[1,0,0,0]',
    bounding_box: '[0.25,0.25,0.75,0.75]',
    dominant_colors: '[[200,50,50]]',
    embedding_version: embeddingVersion,
    sighting_count: 1,
    last_seen_ms: null,
    distance: 0.1,
  };
}

describe('VWM P3.A — centroid fold version guard', () => {
  it('SAME-version row folds the embedding AND stamps embedding_version', async () => {
    const timescale = new FakeTimescale();
    timescale.selectRow = knownRow(2); // current version (P3.1: 2 = DINOv2-base)
    const vwm = makeVwm(timescale, null);
    await vwm.onModuleInit();

    // Re-sight with a slightly different embedding so the fold visibly moves.
    await sight(vwm, makeTrack({ embedding: [0.9, 0.1, 0, 0] }));

    // No INSERT (it re-IDed); an embedding-carrying UPDATE that also stamps version.
    expect(timescale.find(/INSERT INTO visual_object_embeddings/i)).toHaveLength(0);
    const embUpdate = timescale
      .find(/UPDATE visual_object_embeddings/i)
      .find((q) => /embedding = \$2::vector/.test(q.sql));
    expect(embUpdate).toBeDefined();
    expect(embUpdate!.sql).toMatch(/embedding_version = \$3/);
    expect(embUpdate!.params?.[2]).toBe(2); // stamped current version (P3.1)
    // folded centroid = mean([1,0,0,0],[0.9,0.1,0,0]) at n=1 → [0.95,0.05,0,0]
    const written = parseVectorLiteral(embUpdate!.params?.[1] as string);
    [0.95, 0.05, 0, 0].forEach((v, i) => expect(written![i]).toBeCloseTo(v, 10));
  });

  it('NULL/legacy-version row is folded as current (upgrade in place)', async () => {
    const timescale = new FakeTimescale();
    timescale.selectRow = knownRow(null); // legacy: no version
    const vwm = makeVwm(timescale, null);
    await vwm.onModuleInit();

    await sight(vwm, makeTrack({ embedding: [0.9, 0.1, 0, 0] }));

    const embUpdate = timescale
      .find(/UPDATE visual_object_embeddings/i)
      .find((q) => /embedding = \$2::vector/.test(q.sql));
    // NULL/legacy is adopted as current → fold proceeds and stamps version 2 (P3.1).
    expect(embUpdate).toBeDefined();
    expect(embUpdate!.params?.[2]).toBe(2);
  });

  it('CROSS-version row REFUSES the fold: count-only UPDATE, embedding untouched', async () => {
    const timescale = new FakeTimescale();
    // P3.1 — a stored v1 row is the LEGACY EfficientNet-1280 case; current is v2
    // (DINOv2-768). The dims/space differ, so the fold must be refused. (After the
    // destructive migration these legacy rows have a NULL embedding anyway and are
    // excluded by `WHERE embedding IS NOT NULL`; this guards the in-memory path.)
    timescale.selectRow = knownRow(1); // legacy EfficientNet version (!= current v2)
    const vwm = makeVwm(timescale, null);
    await vwm.onModuleInit();

    await sight(vwm, makeTrack({ embedding: [0.9, 0.1, 0, 0] }));

    // It still re-IDed (no INSERT), but the UPDATE must be count-only — NO
    // embedding rewrite and NO version stamp (never mix a legacy v1 EfficientNet
    // centroid with a v2 DINOv2 observation — different dims and spaces).
    expect(timescale.find(/INSERT INTO visual_object_embeddings/i)).toHaveLength(0);
    const updates = timescale.find(/UPDATE visual_object_embeddings/i);
    expect(updates.length).toBeGreaterThanOrEqual(1);
    // NO update carries an embedding rewrite.
    expect(updates.every((q) => !/embedding = \$2::vector/.test(q.sql))).toBe(true);
    // The count-only UPDATE does not touch embedding_version either.
    const countOnly = updates.find((q) => /sighting_count = sighting_count \+ 1/.test(q.sql));
    expect(countOnly).toBeDefined();
    expect(countOnly!.sql).not.toMatch(/embedding_version/);
  });
});
