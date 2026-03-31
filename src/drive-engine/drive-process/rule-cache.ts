/**
 * LRU cache for rule matching results.
 *
 * CANON §Subsystem 4 (Drive Engine), step 3: Caching.
 *
 * Rule matching can be expensive when there are many rules. This LRU cache
 * stores matching results keyed by event type + drive state hash, reducing
 * recomputation for repeated patterns.
 *
 * Cache is invalidated when rules are reloaded from the database.
 */

/**
 * Cached rule matching result.
 */
export interface CacheEntry {
  ruleIds: string[];
  timestamp: number;
}

/**
 * Simple LRU cache with a maximum size.
 *
 * When capacity is exceeded, the least-recently-used entry is evicted.
 */
export class RuleMatchCache {
  private cache: Map<string, CacheEntry> = new Map();
  private maxSize: number;

  constructor(maxSize: number = 500) {
    this.maxSize = maxSize;
  }

  /**
   * Get a cached rule match result.
   *
   * Returns null if the key is not in the cache.
   * Updates the LRU order (moves entry to end, making it most-recently-used).
   *
   * @param key - The cache key (from generateCacheKey)
   * @returns The matched rule IDs, or null if not cached
   */
  get(key: string): string[] | null {
    if (!this.cache.has(key)) {
      return null;
    }

    const entry = this.cache.get(key)!;

    // Update LRU order: delete and re-add to move to end
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.ruleIds;
  }

  /**
   * Set a cached rule match result.
   *
   * If cache is at capacity, evicts the least-recently-used entry.
   *
   * @param key - The cache key
   * @param ruleIds - The matched rule IDs
   */
  set(key: string, ruleIds: string[]): void {
    // If key already exists, delete it to update LRU order
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Cache is full; evict the first (least-recently-used) entry
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    // Add to cache (at the end, making it most-recently-used)
    this.cache.set(key, {
      ruleIds,
      timestamp: Date.now(),
    });
  }

  /**
   * Clear the entire cache.
   *
   * Called when rules are reloaded from the database.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get the current cache size.
   * @returns Number of entries in the cache
   */
  size(): number {
    return this.cache.size;
  }
}
