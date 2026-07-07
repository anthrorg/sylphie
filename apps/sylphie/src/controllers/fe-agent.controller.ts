import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '../guards/auth.guard';

/**
 * FE Agent proxy (TK-142 / item 20260702-005).
 *
 * The FE Agent used to call Anthropic directly FROM THE BROWSER with
 * `dangerouslyAllowBrowser: true`, reading `VITE_ANTHROPIC_API_KEY` — a
 * Vite env var gets INLINED into the built JS bundle, so the key was
 * extractable by anyone who loaded the (publicly reachable) login page.
 *
 * This controller moves the Anthropic call server-side: the key lives only
 * in the backend process env (`ANTHROPIC_API_KEY`, never `VITE_`-prefixed,
 * never shipped to the browser) and every request is guarded by the same
 * JWT AuthGuard the rest of the authenticated API uses.
 *
 * Read-only / advisory only — this never touches Sylphie's graph or drive
 * state (see feAgent.ts's SYSTEM_PROMPT), so it carries no CANON drive
 * isolation or provenance concerns.
 *
 * Simplification note (flagged, not silently decided): the original browser
 * client streamed the response token-by-token via the Anthropic SDK's
 * `.messages.stream()`. This proxy answers with the full text in one
 * response (no SSE) — the simplest server-side implementation that gets the
 * key out of the bundle. Streaming parity was explicitly left open at
 * refine/plan time (see plan.md's HIGH finding on TK-142) for `forge`/`ashby`
 * to weigh in on; this build makes the security fix now and defers
 * streaming as a possible follow-up, not a silent regression — the FE agent
 * still fully answers, just without the incremental token animation.
 */
export interface FeAgentMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface FeAgentAskRequest {
  question: string;
  telemetrySnapshot?: string;
  history?: FeAgentMessage[];
}

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';
const FE_AGENT_MODEL = 'claude-haiku-4-5-20251001';
const FE_AGENT_MAX_TOKENS = 1024;

export const FE_AGENT_SYSTEM_PROMPT = `You are the FE Agent, a real-time assistant embedded in the Sylphie guardian interface. Your role is to help the guardian understand what Sylphie is doing, feeling, and learning.

Sylphie is an AI companion that develops genuine personality through experience. It has:
- 12 drives (4 core: system_health, moral_valence, integrity, cognitive_awareness; 8 complement: guilt, curiosity, boredom, anxiety, satisfaction, sadness, focus, social)
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

You are READ-ONLY. You cannot control Sylphie, send it commands, or modify its graph.`;

interface AnthropicMessagesResponse {
  content?: Array<{ type: string; text?: string }>;
}

@Controller('fe-agent')
export class FeAgentController {
  private readonly logger = new Logger(FeAgentController.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * GET /fe-agent/status — lets the FE Agent panel decide whether to render
   * at all, WITHOUT ever exposing the key itself (replaces the old
   * `isAvailable()` client-side env-var check).
   */
  @Get('status')
  status(): { available: boolean } {
    return { available: !!this.configService.get<string>('ANTHROPIC_API_KEY') };
  }

  /**
   * POST /fe-agent/ask — guardian-only (AuthGuard). Proxies a single
   * question + telemetry snapshot + short history to Anthropic and returns
   * the full text response.
   */
  @Post('ask')
  @UseGuards(AuthGuard)
  async ask(@Body() body: FeAgentAskRequest): Promise<{ response: string }> {
    if (!body?.question || typeof body.question !== 'string') {
      throw new BadRequestException('question is required');
    }

    const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY');
    if (!apiKey) {
      throw new ServiceUnavailableException('FE Agent unavailable — ANTHROPIC_API_KEY not set on the server');
    }

    const history = Array.isArray(body.history) ? body.history : [];
    const messages = [
      ...history,
      {
        role: 'user' as const,
        content: `[TELEMETRY SNAPSHOT]\n${body.telemetrySnapshot ?? ''}\n\n[GUARDIAN QUESTION]\n${body.question}`,
      },
    ];

    let res: Response;
    try {
      res = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_API_VERSION,
        },
        body: JSON.stringify({
          model: FE_AGENT_MODEL,
          max_tokens: FE_AGENT_MAX_TOKENS,
          system: FE_AGENT_SYSTEM_PROMPT,
          messages,
        }),
      });
    } catch (err) {
      this.logger.error(`FE Agent upstream request failed: ${err instanceof Error ? err.message : String(err)}`);
      throw new BadGatewayException('FE Agent upstream request failed');
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      this.logger.error(`FE Agent upstream error ${res.status}: ${errText}`);
      throw new BadGatewayException('FE Agent upstream request failed');
    }

    const data = (await res.json()) as AnthropicMessagesResponse;
    const text = (data.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');

    return { response: text };
  }
}
