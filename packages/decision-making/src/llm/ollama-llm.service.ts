/**
 * OllamaLlmService — Hybrid LLM service using local Ollama + DeepSeek API.
 *
 * CANON §Architecture: The LLM is Sylphie's voice, not her mind. This service
 * provides the chat completion capability that Type 2 deliberation, Learning
 * edge refinement, and Planning constraint validation consume.
 *
 * Tier routing:
 *   quick/medium → Local Ollama (CPU, num_gpu: 0). Free, ~5-10s.
 *   deep         → DeepSeek API if DEEPSEEK_API_KEY is set, else local Ollama GPU.
 *                   DeepSeek V3.2 via OpenAI-compatible API. ~2-4s, <$1/day.
 *
 * CANON §Dual-Process Cognition: Every LLM call carries explicit cost tracking
 * (token counts, latency, cognitive effort pressure). The Drive Engine uses
 * these to compute cognitive effort drive pressure.
 *
 * CANON §The Lesion Test: isAvailable() can return false to simulate LLM
 * unavailability, forcing the system to rely on Type 1 reflexes only.
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Ollama } from 'ollama';
import {
  verboseFor,
  type ILlmService,
  type LlmRequest,
  type LlmResponse,
  type LlmTier,
  type Type2CostEstimate,
} from '@sylphie/shared';

const vlog = verboseFor('LLM');

// ---------------------------------------------------------------------------
// Tool calling types
// ---------------------------------------------------------------------------

/** Definition of a tool available to the LLM during deliberation. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/** Function that executes a tool call and returns the result. */
export type ToolExecutor = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Average tokens per word estimate for cost pre-calculation. */
const TOKENS_PER_WORD = 1.3;

/** Estimated completion utilization ratio (how much of maxTokens will be used). */
const COMPLETION_UTILIZATION = 0.5;

/** Estimated latency per token in milliseconds (model-dependent rough average). */
const MS_PER_TOKEN = 15;

/** Cognitive effort cost per 1000 tokens. Maps token usage to drive pressure. */
const EFFORT_PER_1K_TOKENS = 0.05;

/** DeepSeek API cost per million tokens (for cost tracking). */
const DEEPSEEK_INPUT_COST_PER_M = 0.28;
const DEEPSEEK_OUTPUT_COST_PER_M = 0.42;

@Injectable()
export class OllamaLlmService implements ILlmService, OnModuleInit {
  private readonly logger = new Logger(OllamaLlmService.name);

  private client!: Ollama;
  private models!: Record<LlmTier, string>;
  private timeoutMs!: number;

  /** DeepSeek API configuration. */
  private deepseekApiKey = '';
  private deepseekBaseUrl = '';
  private deepseekModel = '';       // deep tier (reasoning)
  private deepseekMediumModel = ''; // medium tier (chat)

  /** Whether DeepSeek API is configured. */
  private useDeepSeek = false;

  /** Whether the medium tier also routes to DeepSeek. */
  private useDeepSeekMedium = false;

  /** Set to false for Lesion Test or when Ollama is unreachable. */
  private available = true;

  /** Consecutive failure count for circuit breaker. */
  private consecutiveFailures = 0;

  /** Circuit breaker trips after this many consecutive failures. */
  private readonly CIRCUIT_BREAKER_THRESHOLD = 5;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const host = this.config.get<string>('ollama.host', 'http://localhost:11434');
    this.models = {
      quick: this.config.get<string>('ollama.modelQuick', 'qwen2.5:3b'),
      medium: this.config.get<string>('ollama.modelMedium', 'qwen2.5:7b'),
      deep: this.config.get<string>('ollama.modelDeep', 'qwen2.5:14b'),
    };
    this.timeoutMs = this.config.get<number>('ollama.chatTimeoutMs', 30000);

    // DeepSeek API for deep + medium tiers
    this.deepseekApiKey = this.config.get<string>('ollama.deepseekApiKey', '');
    this.deepseekBaseUrl = this.config.get<string>('ollama.deepseekBaseUrl', 'https://api.deepseek.com');
    this.deepseekModel = this.config.get<string>('ollama.deepseekModel', 'deepseek-reasoner');
    this.deepseekMediumModel = this.config.get<string>('ollama.deepseekMediumModel', '');
    this.useDeepSeek = this.deepseekApiKey.length > 0;
    this.useDeepSeekMedium = this.useDeepSeek && this.deepseekMediumModel.length > 0;

    this.client = new Ollama({ host });
    this.logger.log(
      `LLM configured: ${host} / ` +
        `quick=${this.models.quick}, ` +
        `medium=${this.useDeepSeekMedium ? `DeepSeek(${this.deepseekMediumModel})` : this.models.medium}, ` +
        `deep=${this.useDeepSeek ? `DeepSeek(${this.deepseekModel})` : this.models.deep} / ` +
        `timeout=${this.timeoutMs}ms`,
    );
  }

  /** Resolve the Ollama model name for a given tier. */
  private resolveModel(tier: LlmTier = 'medium'): string {
    return this.models[tier];
  }

  /**
   * Resolve GPU layer count for a given tier.
   * medium/quick → CPU only (num_gpu: 0), deep → GPU (default).
   */
  private resolveNumGpu(tier: LlmTier = 'medium'): number | undefined {
    return tier === 'deep' ? undefined : 0;
  }

  // ---------------------------------------------------------------------------
  // DeepSeek API (OpenAI-compatible)
  // ---------------------------------------------------------------------------

  /**
   * Execute a chat completion via DeepSeek API.
   * Uses the OpenAI-compatible /v1/chat/completions endpoint.
   *
   * @param request - LLM request
   * @param modelOverride - Override the model (e.g., deepseek-chat for medium tier)
   */
  private async completeViaDeepSeek(
    request: LlmRequest,
    modelOverride?: string,
  ): Promise<LlmResponse> {
    const model = modelOverride ?? this.deepseekModel;
    const messages: Array<{ role: string; content: string }> = [];

    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }
    for (const msg of request.messages) {
      messages.push({ role: msg.role, content: msg.content });
    }

    const startMs = Date.now();

    const response = await fetch(`${this.deepseekBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.deepseekApiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: request.maxTokens,
        temperature: request.temperature,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`DeepSeek API error ${response.status}: ${body}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string; reasoning_content?: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number };
      model: string;
    };

    const latencyMs = Date.now() - startMs;
    const promptTokens = data.usage?.prompt_tokens ?? 0;
    const completionTokens = data.usage?.completion_tokens ?? 0;

    // Compute actual API cost
    const cost = (promptTokens / 1_000_000) * DEEPSEEK_INPUT_COST_PER_M
      + (completionTokens / 1_000_000) * DEEPSEEK_OUTPUT_COST_PER_M;

    // For reasoning models, content may be in reasoning_content
    const choice = data.choices[0]?.message;
    const content = choice?.content || choice?.reasoning_content || '';

    const tier = request.tier ?? 'deep';

    vlog('DeepSeek complete', {
      model,
      tier,
      purpose: request.metadata.purpose,
      promptTokens,
      completionTokens,
      latencyMs,
      cost: +cost.toFixed(6),
      responseLength: content.length,
    });

    this.logger.debug(
      `LLM complete [${tier}/DeepSeek/${model}]: ` +
        `${promptTokens}+${completionTokens} tokens, ${latencyMs}ms, ` +
        `$${cost.toFixed(6)}, purpose=${request.metadata.purpose}`,
    );

    return {
      content,
      tokensUsed: { prompt: promptTokens, completion: completionTokens },
      latencyMs,
      model: data.model ?? model,
      cost,
    };
  }

  // ---------------------------------------------------------------------------
  // Main complete() — routes by tier
  // ---------------------------------------------------------------------------

  /**
   * Execute an LLM chat completion.
   * Routes deep tier to DeepSeek API when configured, else Ollama.
   */
  async complete(request: LlmRequest): Promise<LlmResponse> {
    if (!this.available) {
      vlog('LLM unavailable', { reason: 'circuit breaker or lesion test' });
      throw new Error('LLM service unavailable (circuit breaker tripped or lesion test active)');
    }

    vlog('LLM request', {
      tier: request.tier ?? 'medium',
      purpose: request.metadata.purpose,
      promptChars: (request.systemPrompt?.length ?? 0) + request.messages.reduce((s, m) => s + m.content.length, 0),
      messageCount: request.messages.length,
      maxTokens: request.maxTokens,
      routeDeepSeek: (request.tier === 'deep' && this.useDeepSeek) || (request.tier === 'medium' && this.useDeepSeekMedium),
    });

    // Route deep tier to DeepSeek (reasoning model)
    if (request.tier === 'deep' && this.useDeepSeek) {
      try {
        const result = await this.completeViaDeepSeek(request);
        this.consecutiveFailures = 0;
        return result;
      } catch (err) {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.CIRCUIT_BREAKER_THRESHOLD) {
          this.available = false;
          this.logger.error(
            `Circuit breaker tripped after ${this.consecutiveFailures} DeepSeek failures.`,
          );
        }
        vlog('DeepSeek deep FAILED', {
          consecutiveFailures: this.consecutiveFailures,
          circuitBroken: !this.available,
          error: err instanceof Error ? err.message : String(err),
        });
        this.logger.error(
          `DeepSeek call failed (failures=${this.consecutiveFailures}): ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
    }

    // Route medium tier to DeepSeek (chat model) if configured
    if (request.tier === 'medium' && this.useDeepSeekMedium) {
      try {
        const result = await this.completeViaDeepSeek(request, this.deepseekMediumModel);
        this.consecutiveFailures = 0;
        return result;
      } catch (err) {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.CIRCUIT_BREAKER_THRESHOLD) {
          this.available = false;
          this.logger.error(
            `Circuit breaker tripped after ${this.consecutiveFailures} DeepSeek medium failures.`,
          );
        }
        vlog('DeepSeek medium FAILED', {
          consecutiveFailures: this.consecutiveFailures,
          circuitBroken: !this.available,
          error: err instanceof Error ? err.message : String(err),
        });
        this.logger.error(
          `DeepSeek medium call failed (failures=${this.consecutiveFailures}): ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
    }

    // Local Ollama path (quick/medium, or deep when DeepSeek not configured)
    const model = this.resolveModel(request.tier);
    const ollamaMessages: Array<{ role: string; content: string }> = [];

    if (request.systemPrompt) {
      ollamaMessages.push({ role: 'system', content: request.systemPrompt });
    }
    for (const msg of request.messages) {
      ollamaMessages.push({ role: msg.role, content: msg.content });
    }

    const startMs = Date.now();
    const numGpu = this.resolveNumGpu(request.tier);

    try {
      const response = await this.client.chat({
        model,
        messages: ollamaMessages,
        options: {
          temperature: request.temperature,
          num_predict: request.maxTokens,
          ...(numGpu !== undefined && { num_gpu: numGpu }),
        },
      });

      const latencyMs = Date.now() - startMs;
      this.consecutiveFailures = 0;

      const promptTokens = response.prompt_eval_count ?? 0;
      const completionTokens = response.eval_count ?? 0;

      vlog('Ollama complete', {
        model,
        tier: request.tier ?? 'medium',
        purpose: request.metadata.purpose,
        promptTokens,
        completionTokens,
        latencyMs,
        responseLength: response.message.content.length,
        numGpu,
      });

      this.logger.debug(
        `LLM complete [${request.tier ?? 'medium'}/${model}]: ` +
          `${promptTokens}+${completionTokens} tokens, ${latencyMs}ms, ` +
          `purpose=${request.metadata.purpose}`,
      );

      return {
        content: response.message.content,
        tokensUsed: { prompt: promptTokens, completion: completionTokens },
        latencyMs,
        model: response.model ?? model,
        cost: 0,
      };
    } catch (err) {
      const latencyMs = Date.now() - startMs;
      this.consecutiveFailures++;

      if (this.consecutiveFailures >= this.CIRCUIT_BREAKER_THRESHOLD) {
        this.available = false;
        this.logger.error(
          `Circuit breaker tripped after ${this.consecutiveFailures} consecutive failures.`,
        );
      }

      vlog('Ollama FAILED', {
        model,
        tier: request.tier ?? 'medium',
        purpose: request.metadata.purpose,
        latencyMs,
        consecutiveFailures: this.consecutiveFailures,
        error: err instanceof Error ? err.message : String(err),
      });

      this.logger.error(
        `LLM call failed [${request.tier ?? 'medium'}/${model}] ` +
          `(${latencyMs}ms, failures=${this.consecutiveFailures}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Tool calling (Ollama only — DeepSeek tool calls not needed yet)
  // ---------------------------------------------------------------------------

  /**
   * Execute an LLM chat completion with tool calling support.
   * Always uses local Ollama (tool calling is only used in candidate gen, medium tier).
   */
  async completeWithTools(
    request: LlmRequest,
    tools: ToolDefinition[],
    toolExecutor: ToolExecutor,
  ): Promise<LlmResponse> {
    if (!this.available) {
      throw new Error('LLM service unavailable');
    }

    const model = this.resolveModel(request.tier);
    const MAX_TOOL_ROUNDS = 5;
    const startMs = Date.now();
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    const messages: Array<{ role: string; content: string; tool_calls?: any[] }> = [];
    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }
    for (const msg of request.messages) {
      messages.push({ role: msg.role, content: msg.content });
    }

    const ollamaTools = tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    let finalContent = '';
    const numGpu = this.resolveNumGpu(request.tier);

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      try {
        const response = await this.client.chat({
          model,
          messages,
          tools: ollamaTools,
          options: {
            temperature: request.temperature,
            num_predict: request.maxTokens,
            ...(numGpu !== undefined && { num_gpu: numGpu }),
          },
        });

        totalPromptTokens += response.prompt_eval_count ?? 0;
        totalCompletionTokens += response.eval_count ?? 0;
        this.consecutiveFailures = 0;

        const msg = response.message;

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          messages.push({
            role: 'assistant',
            content: msg.content || '',
            tool_calls: msg.tool_calls,
          });

          for (const toolCall of msg.tool_calls) {
            const fn = toolCall.function;
            this.logger.debug(`Tool call: ${fn.name}(${JSON.stringify(fn.arguments)})`);

            try {
              const toolResult = await toolExecutor(fn.name, fn.arguments ?? {});
              messages.push({
                role: 'tool',
                content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
              });
            } catch (toolErr) {
              this.logger.warn(`Tool ${fn.name} failed: ${toolErr}`);
              messages.push({
                role: 'tool',
                content: JSON.stringify({ error: String(toolErr) }),
              });
            }
          }
          continue;
        }

        finalContent = msg.content || '';
        break;
      } catch (err) {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.CIRCUIT_BREAKER_THRESHOLD) {
          this.available = false;
        }
        throw err;
      }
    }

    const latencyMs = Date.now() - startMs;

    vlog('Ollama completeWithTools', {
      model,
      tier: request.tier ?? 'medium',
      purpose: request.metadata.purpose,
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      latencyMs,
      toolCount: tools.length,
      responseLength: finalContent.length,
    });

    this.logger.debug(
      `LLM completeWithTools [${request.tier ?? 'medium'}/${model}]: ` +
        `${totalPromptTokens}+${totalCompletionTokens} tokens, ` +
        `${latencyMs}ms, purpose=${request.metadata.purpose}`,
    );

    return {
      content: finalContent,
      tokensUsed: { prompt: totalPromptTokens, completion: totalCompletionTokens },
      latencyMs,
      model,
      cost: 0,
    };
  }

  // ---------------------------------------------------------------------------
  // Cost estimation
  // ---------------------------------------------------------------------------

  estimateCost(request: LlmRequest): Type2CostEstimate {
    let totalWords = 0;
    if (request.systemPrompt) {
      totalWords += request.systemPrompt.split(/\s+/).length;
    }
    for (const msg of request.messages) {
      totalWords += msg.content.split(/\s+/).length;
    }

    const promptTokenEstimate = Math.ceil(totalWords * TOKENS_PER_WORD);
    const completionTokenEstimate = Math.ceil(request.maxTokens * COMPLETION_UTILIZATION);
    const tokenEstimate = promptTokenEstimate + completionTokenEstimate;

    const latencyEstimate = tokenEstimate * MS_PER_TOKEN;
    const cognitiveEffortCost = Math.min(1.0, (tokenEstimate / 1000) * EFFORT_PER_1K_TOKENS);

    return { tokenEstimate, latencyEstimate, cognitiveEffortCost };
  }

  // ---------------------------------------------------------------------------
  // Availability
  // ---------------------------------------------------------------------------

  isAvailable(): boolean {
    return this.available;
  }

  resetCircuitBreaker(): void {
    this.consecutiveFailures = 0;
    this.available = true;
    this.logger.log('Circuit breaker reset — LLM service marked available.');
  }

  enableLesionTest(): void {
    this.available = false;
    this.logger.warn('Lesion Test mode enabled — LLM service marked unavailable.');
  }
}
