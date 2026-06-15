/**
 * Throwaway measurement harness for P1 #0 visual_embedding calibration.
 * Replicates the REAL transform from visual-embedding.encoder.ts + sensory-fusion.ts:
 *   - mulberry32 PRNG (linear-algebra.ts)
 *   - xavierMatrix (same seed 0x71e0e for the 1280->768 JL projection)
 *   - L2-normalize before projection (HR2)
 * Measures cosine distributions on the real EfficientNet fixture.
 *
 * Run: node test/fixtures/vision/measure-visual-embedding.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');

const EMBEDDING_DIM = 768;
const OBJECT_EMBEDDING_DIM = 1280;
const VISUAL_EMBEDDING_PROJECTION_SEED = 0x71e0e;

// ---- copied verbatim from packages/decision-making/src/inputs/linear-algebra.ts ----
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function xavierMatrix(rows, cols, seed = 42) {
  const rng = mulberry32(seed);
  const limit = Math.sqrt(6 / (rows + cols));
  const W = new Array(rows);
  for (let r = 0; r < rows; r++) {
    W[r] = new Array(cols);
    for (let c = 0; c < cols; c++) W[r][c] = rng() * 2 * limit - limit;
  }
  return W;
}
function linearProject(W, x, b) {
  const outDim = W.length;
  const y = new Array(outDim);
  for (let r = 0; r < outDim; r++) {
    let sum = b[r];
    const row = W[r];
    for (let c = 0; c < row.length; c++) sum += row[c] * x[c];
    y[r] = sum;
  }
  return y;
}
// ---- copied from visual-embedding.encoder.ts ----
function l2Normalize(v) {
  let normSq = 0;
  for (let i = 0; i < v.length; i++) normSq += v[i] * v[i];
  if (normSq === 0) return null;
  const inv = 1 / Math.sqrt(normSq);
  return v.map((x) => x * inv);
}
function norm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---- load fixture ----
const fx = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'real-object-embeddings.json'), 'utf8'),
);
// Flatten into {scene, label, emb} records
const objs = [];
for (const scene of Object.keys(fx)) {
  fx[scene].forEach((o, i) => {
    objs.push({ scene, idx: i, label: o.label, emb: o.embedding });
  });
}

console.log('=== RAW EFFICIENTNET EMBEDDING STATS ===');
for (const o of objs) {
  console.log(
    `  ${o.scene}[${o.idx}] ${o.label.padEnd(12)} dim=${o.emb.length} rawNorm=${norm(o.emb).toFixed(3)}`,
  );
}

// Build the real JL projection matrix (same seed as the encoder).
const W = xavierMatrix(EMBEDDING_DIM, OBJECT_EMBEDDING_DIM, VISUAL_EMBEDDING_PROJECTION_SEED);
const b = new Array(EMBEDDING_DIM).fill(0);

// The encoder pipeline for a SINGLE object: L2-normalize raw -> project.
// (poolVisualEmbeddings means across confirmed tracks; for single-object cosine
//  geometry we treat each object as its own pooled scene of n=1.)
function encodeOne(rawEmb) {
  const unit = l2Normalize(rawEmb);
  return linearProject(W, unit, b);
}

const encoded = objs.map((o) => ({ ...o, proj: encodeOne(o.emb) }));

// ---- Build pair sets ----
// SAME-class: person-vs-person (across both scenes AND within scenes).
// DIFFERENT-class: person vs {bus, skateboard, tie}, and the non-person cross pairs.
const persons = encoded.filter((o) => o.label === 'person');
const nonPersons = encoded.filter((o) => o.label !== 'person');

function pairStats(label, pairs, vecKey) {
  const cosines = pairs.map(([x, y]) => cosine(x[vecKey], y[vecKey]));
  cosines.sort((a, b) => a - b);
  const n = cosines.length;
  const mean = cosines.reduce((s, v) => s + v, 0) / n;
  const min = cosines[0];
  const max = cosines[n - 1];
  const median = cosines[Math.floor(n / 2)];
  const variance = cosines.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  return { label, n, min, max, mean, median, std: Math.sqrt(variance), all: cosines };
}

function allPairs(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i++)
    for (let j = i + 1; j < arr.length; j++) out.push([arr[i], arr[j]]);
  return out;
}
function crossPairs(a, bArr) {
  const out = [];
  for (const x of a) for (const y of bArr) out.push([x, y]);
  return out;
}

// SAME-class person pairs (the collapse case #0): includes cross-scene person pairs.
const samePairs = allPairs(persons);
// DIFFERENT-class: every person vs every non-person.
const diffPairs = crossPairs(persons, nonPersons);
// Also: different-class among non-persons (bus vs skateboard vs tie) for completeness.
const diffNonPerson = allPairs(nonPersons);

for (const vecKey of ['emb', 'proj']) {
  const tag = vecKey === 'emb' ? 'RAW 1280-D (JL proxy)' : 'PROJECTED 768-D (real encoder out)';
  console.log(`\n=== COSINE DISTRIBUTION — ${tag} ===`);
  const same = pairStats('SAME-class person-person', samePairs, vecKey);
  const diff = pairStats('DIFF-class person-vs-other', diffPairs, vecKey);
  const diffNP = pairStats('DIFF-class other-vs-other', diffNonPerson, vecKey);
  for (const s of [same, diff, diffNP]) {
    console.log(
      `  ${s.label.padEnd(28)} n=${String(s.n).padEnd(3)} min=${s.min.toFixed(3)} max=${s.max.toFixed(3)} mean=${s.mean.toFixed(3)} median=${s.median.toFixed(3)} std=${s.std.toFixed(3)}`,
    );
  }
  // The gap: lowest SAME vs highest DIFF (person-vs-other is the discriminating axis).
  const gapMeans = same.mean - diff.mean;
  const sameMin = same.min;
  const diffMax = diff.max;
  const separated = sameMin > diffMax;
  console.log(`  --- mean(SAME) - mean(DIFF person-other) = ${gapMeans.toFixed(3)}`);
  console.log(`  --- min(SAME)=${sameMin.toFixed(3)}  max(DIFF person-other)=${diffMax.toFixed(3)}  cleanly separated=${separated}`);
  // Knee candidate threshold = midpoint of min(SAME) and max(DIFF) if separated,
  // else the overlap is reported.
  if (separated) {
    console.log(`  --- KNEE (midpoint min(SAME),max(DIFF)) = ${((sameMin + diffMax) / 2).toFixed(3)}`);
  } else {
    console.log(`  --- OVERLAP: max(DIFF)=${diffMax.toFixed(3)} >= min(SAME)=${sameMin.toFixed(3)} — bands overlap.`);
  }
  // List per-pair so we can see the cross-scene person pairs specifically.
  if (vecKey === 'proj') {
    console.log('  per-pair SAME (person-person):');
    samePairs.forEach(([x, y]) => {
      console.log(
        `     ${x.scene}[${x.idx}]<->${y.scene}[${y.idx}]  cos=${cosine(x.proj, y.proj).toFixed(3)}  ${x.scene === y.scene ? '(same-scene)' : '(CROSS-scene)'}`,
      );
    });
    console.log('  per-pair DIFF (person vs other):');
    diffPairs.forEach(([x, y]) => {
      console.log(
        `     ${x.scene}[${x.idx}]person <-> ${y.scene}[${y.idx}]${y.label}  cos=${cosine(x.proj, y.proj).toFixed(3)}`,
      );
    });
  }
}

// =====================================================================
// DOMINANCE CHECK — fused-vector norm with vs without the visual block.
// Replicates concatAndProject: each modality contributes an EMBEDDING_DIM
// block scaled by its fusion scale, concatenated, then projected by the
// fusion W (seed 0xf05e). We can't know the exact registry modality set
// without booting Nest, but the DOMINANCE question is purely about the
// L2 magnitude the visual block injects into the concat relative to a
// typical other-modality block. We measure the projected-block norm.
// =====================================================================
console.log('\n=== DOMINANCE CHECK (projected visual_embedding block norm) ===');
// For each scale candidate, the visual block = scale * project(L2unit(pooled)).
// Other modalities (text/audio/video/...) are also EMBEDDING_DIM blocks; a
// well-behaved nomic text embedding is itself L2-unit (norm ~1) but is NOT
// JL-projected — it enters the concat directly. So the fair comparison is:
//   visualBlockNorm(scale) = scale * || project(unit_1280) ||
//   vs a reference modality block norm ~ 1.0 (unit text/audio embedding).
const refUnitNorms = [];
for (const o of encoded) {
  refUnitNorms.push(norm(o.proj)); // norm of project(L2unit(raw)) — pre-scale
}
const meanProjNorm = refUnitNorms.reduce((s, v) => s + v, 0) / refUnitNorms.length;
console.log(`  ||project(L2unit(raw))||  mean=${meanProjNorm.toFixed(3)}  min=${Math.min(...refUnitNorms).toFixed(3)}  max=${Math.max(...refUnitNorms).toFixed(3)}`);
console.log('  (A reference L2-unit text/audio modality block has norm ~1.000.)');
for (const scale of [0.25, 0.5, 0.6, 0.75, 1.0]) {
  const blockNorm = scale * meanProjNorm;
  const ratio = blockNorm / 1.0;
  const swamps = ratio > 2.0;
  console.log(
    `  scale=${scale.toFixed(2)}  visualBlockNorm=${blockNorm.toFixed(3)}  ratio-vs-unit-modality=${ratio.toFixed(2)}x  ${swamps ? 'SWAMPS (>2x)' : 'bounded'}`,
  );
}
