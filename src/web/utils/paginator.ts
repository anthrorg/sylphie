/**
 * Pagination utilities for Web module endpoints.
 *
 * Provides helpers for offset/limit-based pagination. Used by endpoints
 * that return large result sets (history, metrics, logs, etc.).
 *
 * CANON §Web API: Pagination is zero-indexed (offset=0 is the first item).
 * Default limit is 50 items per page. Maximum limit is 500 items per page.
 */

/**
 * PaginationParams — query parameters for pagination.
 *
 * offset: Zero-indexed position in the result set. Default: 0.
 * limit: Number of items to return. Default: 50. Maximum: 500.
 */
export interface PaginationParams {
  /** Zero-indexed offset. Default: 0. Range [0, infinity). */
  readonly offset?: number;

  /** Number of items to return. Default: 50. Range [1, 500]. */
  readonly limit?: number;
}

/**
 * PaginatedResult — response wrapper for paginated data.
 *
 * Includes the data array, total count, offset, and limit.
 * Enables frontend pagination UI (next/previous buttons, page info).
 */
export interface PaginatedResult<T> {
  /** Array of items in this page. */
  readonly data: T[];

  /** Total count of items across all pages. */
  readonly total: number;

  /** Zero-indexed offset used in this query. */
  readonly offset: number;

  /** Number of items returned in this page (may be less than limit). */
  readonly limit: number;
}

/**
 * Paginate — helper function to slice and wrap data.
 *
 * Given an array of items and pagination parameters, returns a paginated
 * result object with the sliced data and metadata.
 *
 * @param items - Full array of items to paginate.
 * @param params - Pagination parameters (offset and limit).
 * @returns PaginatedResult with sliced data and metadata.
 *
 * @example
 * const allItems = [1, 2, 3, 4, 5];
 * const result = paginate(allItems, { offset: 1, limit: 2 });
 * // result.data === [2, 3]
 * // result.total === 5
 * // result.offset === 1
 * // result.limit === 2
 */
export function paginate<T>(
  items: T[],
  params: PaginationParams,
): PaginatedResult<T> {
  const offset = Math.max(0, params.offset ?? 0);
  const limit = Math.min(500, Math.max(1, params.limit ?? 50));

  const sliced = items.slice(offset, offset + limit);

  return {
    data: sliced,
    total: items.length,
    offset,
    limit,
  };
}

/**
 * ValidatePaginationParams — validate and normalize pagination parameters.
 *
 * Ensures offset and limit are within acceptable ranges.
 * Used by controllers to sanitize client input.
 *
 * @param offset - Raw offset from query string (may be NaN, negative, etc.)
 * @param limit - Raw limit from query string (may be NaN, negative, etc.)
 * @returns Normalized { offset, limit }
 */
export function validatePaginationParams(
  offset?: unknown,
  limit?: unknown,
): { offset: number; limit: number } {
  let normalizedOffset = 0;
  let normalizedLimit = 50;

  if (typeof offset === 'number' && offset >= 0) {
    normalizedOffset = Math.floor(offset);
  } else if (typeof offset === 'string') {
    const parsed = parseInt(offset, 10);
    if (!isNaN(parsed) && parsed >= 0) {
      normalizedOffset = parsed;
    }
  }

  if (typeof limit === 'number' && limit > 0) {
    normalizedLimit = Math.min(500, Math.floor(limit));
  } else if (typeof limit === 'string') {
    const parsed = parseInt(limit, 10);
    if (!isNaN(parsed) && parsed > 0) {
      normalizedLimit = Math.min(500, parsed);
    }
  }

  return { offset: normalizedOffset, limit: normalizedLimit };
}
