/**
 * OllamaLlmService — ILlmService implementation via a local Ollama instance.
 *
 * Selected when LLM_PROVIDER=ollama (default). Calls Ollama's /api/chat
 * HTTP endpoint for local inference with zero API cost.
 *
 * Two-model routing based on request metadata.purpose:
 *   - GPU model (slow, capable): TYPE_2_DELIBERATION, EDGE_REFINEMENT,
 *     PLAN_CONSTRAINT_VALIDATION — anything requiring reasoning.
 *   - CPU model (fast, lightweight): RESPONSE_GENERATION, conversation —
 *     where latency matters more than depth.
 *
 * Token counting: Ollama returns eval_count (completion) and
 * prompt_eval_count (prompt) — mapped directly to tokensUsed.
 *
 * Cost: Always $0.00 for local inference. Cognitive effort pressure
 * still applies via latency + token count (drives Type 1 graduation).
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type {
  ILlmService,
  LlmRequest,
  LlmResponse,
  Type2CostEstimate,
} from '../../shared/types/llm.types';
import type { AppConfig } from '../../shared/config/app.config';
import type { IEventService, RecordResult } from '../../events';
import { EVENTS_SERVICE } from '../../events';
import type {
  IActionOutcomeReporter,
  SoftwareMetrics,
  IDriveStateReader,
} from '../../drive-engine';
import {
  ACTION_OUTCOME_REPORTER,
  DRIVE_STATE_READER,
} from '../../drive-engine';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout for Ollama calls (local inference can be slow on GPU) */
const DEFAULT_TIMEOUT_MS = 120_000;

const MAX_RETRIES = 3;

const CIRCUIT_BREAKER_THRESHOLD = 5;

/** Purposes routed to the GPU model */
const GPU_PURPOSES = new Set([
  'TYPE_2_DELIBERATION',
  'EDGE_REFINEMENT',
  'PLAN_CONSTRAINT_VALIDATION',
  'LEARNING_REFINEMENT',
  'CONTRADICTION_DETECTION',
]);

// ---------------------------------------------------------------------------
// Ollama API types
// ---------------------------------------------------------------------------

interface OllamaChatRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream: false;
  options?: {
    temperature?: number;
    num_predict?: number;
  };
}

interface OllamaChatResponse {
  model: string;
  message: { role: string; content: string };
  done: boolean;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

// ---------------------------------------------------------------------------
// OllamaLlmService
// ---------------------------------------------------------------------------

@Injectable()
export class OllamaLlmService implements ILlmService {
  private readonly logger = new Logger('OllamaLlmService');
  private readonly baseUrl: string;
  private readonly gpuModel: string;
  private readonly cpuModel: string;
  private readonly timeoutMs: number;
  private consecutiveFailures = 0;
  private circuitBreakerTripped = false;

  constructor(
    private readonly configService: ConfigService<{ app: AppConfig }>,
    @Inject(EVENTS_SERVICE) private readonly eventService: IEventService,
    @Inject(ACTION_OUTCOME_REPORTER)
    private readonly metricsReporter: IActionOutcomeReporter,
    @Inject(DRIVE_STATE_READER)
    private readonly driveStateReader: IDriveStateReader,
  ) {
    const config = this.configService.get<AppConfig>('app');
    if (!config) {
      throw new Error('AppConfig not loaded');
    }

    this.baseUrl = config.ollama.baseUrl;
    this.gpuModel = config.ollama.gpuModel;
    this.cpuModel = config.ollama.cpuModel;
    this.timeoutMs = DEFAULT_TIMEOUT_MS;

    this.logger.log(
      `Ollama LLM service initialized: base=${this.baseUrl}, gpu=${this.gpuModel}, cpu=${this.cpuModel}`,
    );
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    if (!this.isAvailable()) {
      throw new Error('Ollama LLM service is not available');
    }

    const model = this.selectModel(request.metadata.purpose);
    const startMs = Date.now();
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await this.callOllamaWithTimeout(request, model);
        const latencyMs = Date.now() - startMs;

        const llmResponse: LlmResponse = {
          content: response.message.content,
          tokensUsed: {
            prompt: response.prompt_eval_count ?? this.estimateTokens(request),
            completion: response.eval_count ?? Math.ceil(response.message.content.length / 4),
          },
          latencyMs,
          model,
          cost: 0, // Local inference, zero dollar cost
        };

        // Emit cost event for tracking (even though cost is $0)
        const config = this.configService.get<AppConfig>('app');
        if (config?.llm.costTrackingEnabled) {
          try {
            await this.emitCostEvent(
              request,
              llmResponse.tokensUsed.prompt + llmResponse.tokensUsed.completion,
              latencyMs,
            );
          } catch (error) {
            this.logger.warn(
              `Failed to emit cost event: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        // Report cognitive effort to Drive Engine
        this.reportCognitiveEffort(
          1,
          latencyMs,
          llmResponse.tokensUsed.prompt + llmResponse.tokensUsed.completion,
        );

        this.consecutiveFailures = 0;
        return llmResponse;
      } catch (error) {
        lastError = error as Error;
        if (!this.shouldRetry(error as Error, attempt)) {
          this.consecutiveFailures++;
          if (this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
            this.circuitBreakerTripped = true;
            this.logger.warn('Circuit breaker tripped after consecutive failures');
          }
          throw lastError;
        }

        const backoffMs = Math.pow(2, attempt) * 1000;
        this.logger.debug(`Retry attempt ${attempt + 1} after ${backoffMs}ms`);
        await this.sleep(backoffMs);
      }
    }

    throw lastError || new Error('Ollama call failed after all retries');
  }

  estimateCost(request: LlmRequest): Type2CostEstimate {
    const inputTokens = this.estimateTokens(request);
    const estimatedCompletionTokens = Math.ceil(request.maxTokens * 0.75);
    const totalTokens = inputTokens + estimatedCompletionTokens;

    // Local inference: latency is higher than API (model loading, GPU compute)
    const isGpu = GPU_PURPOSES.has(request.metadata.purpose);
    const latencyEstimate = isGpu
      ? 500 + Math.ceil(totalTokens / 50) * 10 // GPU: slower per-token
      : 200 + Math.ceil(totalTokens / 100) * 10; // CPU: faster smaller model

    const cognitiveEffortCost = Math.min(
      1.0,
      (totalTokens / 10000) * (latencyEstimate / 10000),
    );

    return { tokenEstimate: totalTokens, latencyEstimate, cognitiveEffortCost };
  }

  isAvailable(): boolean {
    if (!this.baseUrl) {
      this.logger.warn('Ollama service unavailable: base URL not configured');
      return false;
    }

    if (this.circuitBreakerTripped) {
      this.logger.warn('Ollama service unavailable: circuit breaker tripped');
      return false;
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  private selectModel(purpose: string): string {
    return GPU_PURPOSES.has(purpose) ? this.gpuModel : this.cpuModel;
  }

  private async callOllamaWithTimeout(
    request: LlmRequest,
    model: string,
  ): Promise<OllamaChatResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const messages: Array<{ role: string; content: string }> = [
        { role: 'system', content: request.systemPrompt },
        ...request.messages.map((msg) => ({
          role: msg.role,
          content: msg.content,
        })),
      ];

      const body: OllamaChatRequest = {
        model,
        messages,
        stream: false,
        options: {
          temperature: request.temperature,
          num_predict: request.maxTokens,
        },
      };

      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as OllamaChatResponse;

      if (!data.message?.content) {
        throw new Error('No content in Ollama response');
      }

      return data;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private shouldRetry(error: Error, attempt: number): boolean {
    if (attempt >= MAX_RETRIES - 1) return false;

    const message = error.message || '';

    // Retry on network/connection errors
    if (
      message.includes('ECONNREFUSED') ||
      message.includes('ETIMEDOUT') ||
      message.includes('ENOTFOUND') ||
      message.includes('timeout') ||
      message.includes('fetch failed')
    ) {
      return true;
    }

    // Retry on server errors (5xx)
    if (message.includes('500') || message.includes('503')) {
      return true;
    }

    return false;
  }

  private estimateTokens(request: LlmRequest): number {
    const systemTokens = Math.ceil(request.systemPrompt.length / 4);
    const messageTokens = request.messages.reduce(
      (sum, msg) => sum + Math.ceil(msg.content.length / 4),
      0,
    );
    return systemTokens + messageTokens + 10;
  }

  private async emitCostEvent(
    request: LlmRequest,
    tokenCount: number,
    latencyMs: number,
  ): Promise<RecordResult> {
    const event: any = {
      type: 'RESPONSE_GENERATED',
      subsystem: 'COMMUNICATION',
      sessionId: request.metadata.sessionId,
      driveSnapshot: this.driveStateReader.getCurrentState(),
      schemaVersion: 1,
      correlationId: request.metadata.correlationId || undefined,
      provenance: 'LLM_GENERATED',
    };

    return this.eventService.record(event);
  }

  private reportCognitiveEffort(
    callCount: number,
    latencyMs: number,
    tokenCount: number,
  ): void {
    const cognitiveEffortPressure = Math.min(
      1.0,
      (tokenCount + latencyMs / 10) / 10000,
    );

    const metrics: SoftwareMetrics = {
      llmCallCount: callCount,
      llmLatencyMs: latencyMs,
      tokenCount,
      cognitiveEffortPressure,
    };

    this.metricsReporter.reportMetrics(metrics);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
