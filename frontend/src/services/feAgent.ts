/**
 * FE Agent service — Claude API integration for real-time Sylphie state assistant.
 *
 * Read-only: never writes to Sylphie's graph, never sends commands to Sylphie.
 * Telemetry buffer in, text response out.
 *
 * Uses the Anthropic JS SDK with dangerouslyAllowBrowser since this runs
 * in the guardian's browser (trusted environment, not public-facing).
 */

import Anthropic from '@anthropic-ai/sdk'

const SYSTEM_PROMPT = `You are the FE Agent, a real-time assistant embedded in the Sylphie guardian interface. Your role is to help the guardian understand what Sylphie is doing, feeling, and learning.

Sylphie is an AI companion that develops genuine personality through experience. It has:
- 12 drives (4 core: system_health, moral_valence, integrity, cognitive_awareness; 8 complement: guilt, curiosity, boredom, anxiety, satisfaction, sadness, information_integrity, social)
- A pressure-driven executor engine that selects actions based on drive pressures
- A World Knowledge Graph (Neo4j) where all learning accumulates
- Dual-process cognition: Type 1 (graph reflexes) and Type 2 (LLM-assisted deliberation)

Key concepts:
- "pressure" = internal drive intensity (0.0-1.0). High pressure drives action selection.
- "executor state" = idle, categorizing, querying, selecting, executing
- "action" = what Sylphie chose to do
- "category" = which drive triggered the action
- "Type 1/Type 2" = reflex vs deliberative cognition

You have access to a real-time telemetry snapshot. Use it to give specific, data-grounded answers. Be concise. Reference actual pressure values and action history when relevant.

You are READ-ONLY. You cannot control Sylphie, send it commands, or modify its graph.`

let client: Anthropic | null = null

function getClient(): Anthropic | null {
  if (client) return client

  const apiKey = (import.meta as unknown as { env: Record<string, string> }).env?.VITE_ANTHROPIC_API_KEY
  if (!apiKey) return null

  client = new Anthropic({
    apiKey,
    dangerouslyAllowBrowser: true,
  })
  return client
}

export function isAvailable(): boolean {
  return !!(import.meta as unknown as { env: Record<string, string> }).env?.VITE_ANTHROPIC_API_KEY
}

export interface FEAgentMessage {
  role: 'user' | 'assistant'
  content: string
}

export async function askFEAgent(
  question: string,
  telemetrySnapshot: string,
  history: FEAgentMessage[],
  onChunk: (text: string) => void,
): Promise<string> {
  const anthropic = getClient()
  if (!anthropic) {
    throw new Error('FE Agent unavailable — VITE_ANTHROPIC_API_KEY not set')
  }

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    ...history,
    {
      role: 'user',
      content: `[TELEMETRY SNAPSHOT]\n${telemetrySnapshot}\n\n[GUARDIAN QUESTION]\n${question}`,
    },
  ]

  const stream = anthropic.messages.stream({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages,
  })

  let fullResponse = ''

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      fullResponse += event.delta.text
      onChunk(fullResponse)
    }
  }

  return fullResponse
}
