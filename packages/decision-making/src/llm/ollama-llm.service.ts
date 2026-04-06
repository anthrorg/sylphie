/**
 * OllamaLlmService — Concrete ILlmService implementation using Ollama.
 *
 * CANON §Architecture: The LLM is Sylphie's voice, not her mind. This service
 * provides the chat completion capability that Type 2 deliberation, Learning
 * edge refinement, and Planning constraint validation consume.
 *
 * Uses the local Ollama API for chat completions. Configured via:
 *   OLLAMA_HOST         — Ollama server URL (default: http://localhost:11434)
 *   OLLAMA_CHAT_MODEL   — Chat model name (default: llama3.2)
 *   OLLAMA_CHAT_TIMEOUT_MS — Request timeout (default: 30000)
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
import type {
  ILlmService,
  LlmRequest,
  LlmResponse,
  Type2CostEstimate,
} from '@sylphie/shared';

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

@Injectable()
export class OllamaLlmService implements ILlmService, OnModuleInit {
  private readonly logger = new Logger(OllamaLlmService.name);

  private client!: Ollama;
  private model!: string;
  private timeoutMs!: number;

  /** Set to false for Lesion Test or when Ollama is unreachable. */
  private available = true;

  /** Consecutive failure count for circuit breaker. */
  private consecutiveFailures = 0;

  /** Circuit breaker trips after this many consecutive failures. */
  private readonly CIRCUIT_BREAKER_THRESHOLD = 5;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const host = this.config.get<string>('ollama.host', 'http://localhost:11434');
    this.model = this.config.get<string>('ollama.chatModel', 'llama3.2');
    this.timeoutMs = this.config.get<number>('ollama.chatTimeoutMs', 30000);

    this.client = new Ollama({ host });
    this.logger.log(`Ollama LLM configured: ${host} / model=${this.model} / timeout=${this.timeoutMs}ms`);
  }

  /**
   * Execute an LLM chat completion via Ollama.
   *
   * Converts the ILlmService request format to Ollama's chat API, measures
   * latency, and returns a structured LlmResponse with token counts.
   *
   * On success, resets the circuit breaker. On failure, increments the failure
   * count and trips the breaker after CIRCUIT_BREAKER_THRESHOLD consecutive failures.
   */
  async complete(request: LlmRequest): Promise<LlmResponse> {
    if (!this.available) {
      throw new Error('LLM service unavailable (circuit breaker tripped or lesion test active)');
    }

    // Build Ollama message array: system prompt + conversation messages.
    const ollamaMessages: Array<{ role: string; content: string }> = [];

    if (request.systemPrompt) {
      ollamaMessages.push({ role: 'system', content: request.systemPrompt });
    }

    for (const msg of request.messages) {
      ollamaMessages.push({ role: msg.role, content: msg.content });
    }

    const startMs = Date.now();

    try {
      const response = await this.client.chat({
        model: this.model,
        messages: ollamaMessages,
        options: {
          temperature: request.temperature,
          num_predict: request.maxTokens,
        },
      });

      const latencyMs = Date.now() - startMs;

      // Reset circuit breaker on success.
      this.consecutiveFailures = 0;

      const promptTokens = response.prompt_eval_count ?? 0;
      const completionTokens = response.eval_count ?? 0;

      this.logger.debug(
        `LLM complete: ${promptTokens}+${completionTokens} tokens, ${latencyMs}ms, ` +
          `purpose=${request.metadata.purpose}`,
      );

      return {
        content: response.message.content,
        tokensUsed: {
          prompt: promptTokens,
          completion: completionTokens,
        },
        latencyMs,
        model: response.model ?? this.model,
        cost: 0, // Local Ollama has no API cost.
      };
    } catch (err) {
      const latencyMs = Date.now() - startMs;
      this.consecutiveFailures++;

      if (this.consecutiveFailures >= this.CIRCUIT_BREAKER_THRESHOLD) {
        this.available = false;
        this.logger.error(
          `Circuit breaker tripped after ${this.consecutiveFailures} consecutive failures. ` +
            `LLM service marked unavailable.`,
        );
      }

      this.logger.error(
        `LLM call failed (${latencyMs}ms, failures=${this.consecutiveFailures}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  /**
   * Execute an LLM chat completion with tool calling support.
   *
   * When the model returns tool_calls, this method executes the tools via
   * the provided executor, feeds results back, and continues the conversation
   * until the model produces a final text response (no more tool calls).
   *
   * Max tool call rounds is capped to prevent infinite loops.
   *
   * @param request      - The LLM request (same as complete()).
   * @param tools        - Array of tool definitions (Ollama function calling format).
   * @param toolExecutor - Function that executes a tool call and returns the result.
   * @returns LlmResponse with accumulated token counts across all rounds.
   */
  async completeWithTools(
    request: LlmRequest,
    tools: ToolDefinition[],
    toolExecutor: ToolExecutor,
  ): Promise<LlmResponse> {
    if (!this.available) {
      throw new Error('LLM service unavailable');
    }

    const MAX_TOOL_ROUNDS = 5;
    const startMs = Date.now();
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    // Build initial message array
    const messages: Array<{ role: string; content: string; tool_calls?: any[] }> = [];
    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }
    for (const msg of request.messages) {
      messages.push({ role: msg.role, content: msg.content });
    }

    // Convert tool definitions to Ollama format
    const ollamaTools = tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    let finalContent = '';

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      try {
        const response = await this.client.chat({
          model: this.model,
          messages,
          tools: ollamaTools,
          options: {
            temperature: request.temperature,
            num_predict: request.maxTokens,
          },
        });

        totalPromptTokens += response.prompt_eval_count ?? 0;
        totalCompletionTokens += response.eval_count ?? 0;
        this.consecutiveFailures = 0;

        const msg = response.message;

        // Check if the model wants to call tools
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          // Add the assistant's message with tool calls to history
          messages.push({
            role: 'assistant',
            content: msg.content || '',
            tool_calls: msg.tool_calls,
          });

          // Execute each tool call
          for (const toolCall of msg.tool_calls) {
            const fn = toolCall.function;
            this.logger.debug(`Tool call: ${fn.name}(${JSON.stringify(fn.arguments)})`);

            try {
              const toolResult = await toolExecutor(fn.name, fn.arguments ?? {});
              // Add tool result as a tool message
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

          // Continue the loop — the model will process tool results
          continue;
        }

        // No tool calls — this is the final response
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

    this.logger.debug(
      `LLM completeWithTools: ${totalPromptTokens}+${totalCompletionTokens} tokens, ` +
        `${latencyMs}ms, purpose=${request.metadata.purpose}`,
    );

    return {
      content: finalContent,
      tokensUsed: { prompt: totalPromptTokens, completion: totalCompletionTokens },
      latencyMs,
      model: this.model,
      cost: 0,
    };
  }

  /**
   * Estimate the cost of an LLM call before making it.
   *
   * Pure estimation from request content — no API call. Used by the arbitrator
   * to apply pre-emptive cognitive effort pressure to the CognitiveAwareness drive.
   */
  estimateCost(request: LlmRequest): Type2CostEstimate {
    // Estimate prompt tokens from message content.
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

    return {
      tokenEstimate,
      latencyEstimate,
      cognitiveEffortCost,
    };
  }

  /**
   * Whether the LLM service is currently available.
   *
   * Returns false when the circuit breaker has tripped or during Lesion Test.
   * Call resetCircuitBreaker() to restore after investigation.
   */
  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Manually reset the circuit breaker.
   * Called after Ollama is confirmed healthy again, or to exit Lesion Test mode.
   */
  resetCircuitBreaker(): void {
    this.consecutiveFailures = 0;
    this.available = true;
    this.logger.log('Circuit breaker reset — LLM service marked available.');
  }

  /**
   * Disable the LLM for Lesion Test mode.
   * All callers will fall back to SHRUG or cached responses.
   */
  enableLesionTest(): void {
    this.available = false;
    this.logger.warn('Lesion Test mode enabled — LLM service marked unavailable.');
  }
}
