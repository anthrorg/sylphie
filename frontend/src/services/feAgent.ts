/**
 * FE Agent service — calls the backend proxy (TK-142 / item 20260702-005).
 *
 * The Anthropic API key used to live in this module, read from a Vite
 * "public" build-time env var and passed to an in-browser SDK client with
 * its explicit unsafe-browser-use opt-in flag set. Vite inlines that class
 * of env var into the built JS bundle, so anyone loading the dashboard's
 * public login page could extract the key.
 *
 * The key now lives ONLY in the backend process env (`ANTHROPIC_API_KEY`,
 * never a Vite-exposed name) — see
 * apps/sylphie/src/controllers/fe-agent.controller.ts. This module never
 * imports the Anthropic SDK and never sees the key.
 *
 * Read-only: never writes to Sylphie's graph, never sends commands to Sylphie.
 */

export interface FEAgentMessage {
  role: 'user' | 'assistant'
  content: string
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('sylphie_token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/**
 * Checks the BACKEND'S availability (whether ANTHROPIC_API_KEY is configured
 * server-side) — replaces the old synchronous client-side env-var check,
 * since the frontend no longer holds (or can hold) that information itself.
 */
export async function checkAvailable(): Promise<boolean> {
  try {
    const res = await fetch('/api/fe-agent/status')
    if (!res.ok) return false
    const data = (await res.json()) as { available?: boolean }
    return !!data.available
  } catch {
    return false
  }
}

export async function askFEAgent(
  question: string,
  telemetrySnapshot: string,
  history: FEAgentMessage[],
  onChunk: (text: string) => void,
): Promise<string> {
  const res = await fetch('/api/fe-agent/ask', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify({ question, telemetrySnapshot, history }),
  })

  if (!res.ok) {
    const body = await res.json().catch(() => null) as { message?: string } | null
    throw new Error(body?.message || `FE Agent request failed (${res.status})`)
  }

  const data = (await res.json()) as { response: string }

  // The backend proxy answers in one shot (no SSE) — see the controller's
  // docstring for why streaming parity was deferred rather than silently
  // dropped. Deliver the full text through the same onChunk callback so
  // existing callers (useFEAgentChat) don't need to change.
  onChunk(data.response)
  return data.response
}
