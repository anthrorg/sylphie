import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { askFEAgent, checkAvailable } from './feAgent'

// AC (TK-142): given a production build of the frontend, when the bundle is
// searched for the Anthropic key prefix, it is absent, and the FE agent's
// requests go to a backend proxy route.
//
// A full `vite build` is exercised as part of this ticket's manual build
// check (frontend `yarn build`); this spec covers the fast, deterministic
// half of the AC that CAN run as a unit test: the SOURCE this module ships
// from contains no browser-side Anthropic client construction at all, so
// there is nothing for any bundler to inline.

describe('feAgent service — no browser-side Anthropic key (TK-142)', () => {
  it('never imports the Anthropic SDK or constructs a browser client', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'feAgent.ts'), 'utf-8')
    expect(source).not.toContain('@anthropic-ai/sdk')
    expect(source).not.toContain('dangerouslyAllowBrowser')
    expect(source).not.toContain('VITE_ANTHROPIC_API_KEY')
  })

  it('the frontend package no longer declares @anthropic-ai/sdk as a dependency', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8'),
    ) as { dependencies?: Record<string, string> }
    expect(pkg.dependencies?.['@anthropic-ai/sdk']).toBeUndefined()
  })
})

describe('feAgent service — requests go through the backend proxy', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    localStorage.setItem('sylphie_token', 'test-token')
  })

  afterEach(() => {
    global.fetch = originalFetch
    localStorage.removeItem('sylphie_token')
    vi.restoreAllMocks()
  })

  it('askFEAgent POSTs to /api/fe-agent/ask with the guardian auth header, never to Anthropic directly', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: 'Sylphie is idle.' }),
    })
    global.fetch = fetchSpy as unknown as typeof fetch

    const onChunk = vi.fn()
    const result = await askFEAgent('What is Sylphie doing?', 'pressure=0.4', [], onChunk)

    expect(result).toBe('Sylphie is idle.')
    expect(onChunk).toHaveBeenCalledWith('Sylphie is idle.')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('/api/fe-agent/ask')
    expect(String(url)).not.toContain('anthropic.com')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer test-token' })
  })

  it('checkAvailable reflects the backend /status route', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ available: true }),
    }) as unknown as typeof fetch

    await expect(checkAvailable()).resolves.toBe(true)
  })

  it('checkAvailable degrades to false on a network error (never throws)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch
    await expect(checkAvailable()).resolves.toBe(false)
  })
})
