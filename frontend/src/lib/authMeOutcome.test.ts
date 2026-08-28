import { describe, it, expect } from 'vitest'
import { classifyAuthMeStatus } from './authMeOutcome'

// AC (TK-147): given a stored auth token and a call to /api/auth/me, when
// the call returns a transient 5xx or times out, then the token is left
// intact; only a 401 clears it.

describe('classifyAuthMeStatus', () => {
  it('classifies 401 as unauthenticated (the ONLY status that should clear the token)', () => {
    expect(classifyAuthMeStatus(401)).toBe('unauthenticated')
  })

  it('classifies 2xx as authenticated', () => {
    expect(classifyAuthMeStatus(200)).toBe('authenticated')
    expect(classifyAuthMeStatus(204)).toBe('authenticated')
  })

  it('classifies transient 5xx as transient, NOT unauthenticated', () => {
    expect(classifyAuthMeStatus(500)).toBe('transient')
    expect(classifyAuthMeStatus(502)).toBe('transient')
    expect(classifyAuthMeStatus(503)).toBe('transient')
  })

  it('classifies other 4xx (e.g. 403, 404) as transient — only 401 is an auth rejection', () => {
    expect(classifyAuthMeStatus(403)).toBe('transient')
    expect(classifyAuthMeStatus(404)).toBe('transient')
  })
})
