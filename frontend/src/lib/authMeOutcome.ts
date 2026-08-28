/**
 * TK-147 (item 20260702-005) — classifies a `GET /api/auth/me` response so
 * the caller can decide whether to clear the stored auth token.
 *
 * Before this fix, App.tsx's AuthGate treated ANY failure — a 401 (actually
 * invalid/expired token) OR a transient 5xx/network blip — identically:
 * `.catch(() => clearAuth())`. That logs the guardian out on a momentary
 * backend hiccup, which is a much worse failure mode than just leaving the
 * stale UI state for a moment.
 *
 * Only a 401 means the token itself is rejected. Everything else that isn't
 * a 2xx is transient and must NOT clear the token.
 */
export type AuthMeOutcome = 'authenticated' | 'unauthenticated' | 'transient'

export function classifyAuthMeStatus(status: number): AuthMeOutcome {
  if (status === 401) return 'unauthenticated'
  if (status >= 200 && status < 300) return 'authenticated'
  return 'transient'
}
