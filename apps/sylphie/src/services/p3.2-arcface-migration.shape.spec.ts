/**
 * P3.2 — destructive ArcFace face-embedding migration SCRIPT shape contract.
 *
 * The live migration is DEFERRED to a coordinated stack-down window (the
 * coordinator runs the scratch-DB test + clean-room smoke). This spec is the
 * STATIC shape gate on the SQL artifact so the script can't silently drift from
 * the four-pronged-decontamination + atomicity-trap contract atlas ratified:
 *
 *   • DELETE-all first (every existing row is body-track contamination);
 *   • DROP-then-ADD the embedding column re-keyed to vector(512) (ArcFace dim);
 *   • exactly one BEGIN/COMMIT transaction;
 *   • the header documents the count=4 audit precondition, the coordinated
 *     stack-down window, and the post-migration getCentroidCount() > 0 assertion
 *     (the silent-blackout atomicity trap).
 *
 * No DB is touched — this reads the file from disk and asserts its text shape.
 */

import * as fs from 'fs';
import * as path from 'path';

// jest runs with cwd = apps/sylphie; the SQL lives at <root>/test/fixtures/vision.
const MIGRATION_PATH = path.resolve(
  process.cwd(),
  '../../test/fixtures/vision/p3.2-arcface-migration.sql',
);

describe('P3.2 ArcFace migration script — shape contract', () => {
  let sql: string;

  beforeAll(() => {
    sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  });

  it('exists and is non-empty', () => {
    expect(sql.length).toBeGreaterThan(0);
  });

  it('PRONG 1 (data): DELETEs all rows from face_embeddings (contamination purge)', () => {
    expect(sql).toMatch(/DELETE\s+FROM\s+face_embeddings\s*;/i);
  });

  it('DROPs then ADDs the embedding column re-keyed to vector(512) (ArcFace dim)', () => {
    expect(sql).toMatch(
      /ALTER\s+TABLE\s+face_embeddings\s+DROP\s+COLUMN\s+embedding\s*;/i,
    );
    expect(sql).toMatch(
      /ALTER\s+TABLE\s+face_embeddings\s+ADD\s+COLUMN\s+embedding\s+vector\(512\)\s*;/i,
    );
    // Must NOT re-key to the legacy 1280 dim.
    expect(sql).not.toMatch(/ADD\s+COLUMN\s+embedding\s+vector\(1280\)/i);
  });

  it('DROP precedes ADD (drop-then-add ordering, atlas)', () => {
    const dropIdx = sql.search(/DROP\s+COLUMN\s+embedding/i);
    const addIdx = sql.search(/ADD\s+COLUMN\s+embedding\s+vector\(512\)/i);
    expect(dropIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeGreaterThan(-1);
    expect(dropIdx).toBeLessThan(addIdx);
  });

  it('DELETE precedes the column re-key (purge before drop)', () => {
    const delIdx = sql.search(/DELETE\s+FROM\s+face_embeddings/i);
    const dropIdx = sql.search(/DROP\s+COLUMN\s+embedding/i);
    expect(delIdx).toBeGreaterThan(-1);
    expect(delIdx).toBeLessThan(dropIdx);
  });

  it('wraps the destructive ops in exactly one BEGIN/COMMIT transaction', () => {
    expect((sql.match(/^\s*BEGIN\s*;/gim) ?? []).length).toBe(1);
    expect((sql.match(/^\s*COMMIT\s*;/gim) ?? []).length).toBe(1);
    const beginIdx = sql.search(/^\s*BEGIN\s*;/im);
    const commitIdx = sql.search(/^\s*COMMIT\s*;/im);
    expect(beginIdx).toBeLessThan(commitIdx);
    // The DELETE + DROP + ADD all sit inside the transaction.
    expect(sql.search(/DELETE\s+FROM\s+face_embeddings/i)).toBeGreaterThan(
      beginIdx,
    );
    expect(sql.search(/ADD\s+COLUMN\s+embedding\s+vector\(512\)/i)).toBeLessThan(
      commitIdx,
    );
  });

  it('is NOT auto-run on restart (stays out of ensureSchema): documents the manual stack-down window', () => {
    expect(sql).toMatch(/stack-down/i);
    expect(sql).toMatch(/coordinat/i);
  });

  it('documents the count=4 contamination audit precondition', () => {
    expect(sql).toMatch(/count\(\*\)\s+FROM\s+face_embeddings/i);
    expect(sql).toMatch(/\b4\b/);
  });

  it('documents the atomicity trap + the post-migration getCentroidCount() > 0 assertion', () => {
    expect(sql).toMatch(/atomic/i);
    expect(sql).toMatch(/getCentroidCount\(\)\s*>\s*0/);
    expect(sql).toMatch(/blackout/i);
  });
});
