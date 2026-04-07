/**
 * Vector math utilities shared across latent space services.
 */

/** Cosine similarity between two vectors. Returns value in [-1, 1]. */
export function cosineSimilarity(a: number[], b: number[]): number {
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
  return denom === 0 ? 0 : dot / denom;
}

/** Parse a pgvector text representation "[0.1,0.2,...]" into a number array. */
export function parseEmbedding(text: string): number[] {
  if (!text || text.length < 3) return [];
  const inner = text.startsWith('[') ? text.slice(1, -1) : text;
  return inner.split(',').map(Number);
}
