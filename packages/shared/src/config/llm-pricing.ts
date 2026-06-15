/**
 * Shared LLM cost/pricing utility.
 *
 * Single source of truth for converting token counts into a USD cost estimate.
 * The Supervisor's CostTrackerService and the Drive Engine's
 * ActionOutcomeReporterService both need to price LLM usage; rather than
 * duplicate the math (and risk the two drifting), the computation lives here.
 *
 * Pricing rates are operator-configurable via the same environment variables
 * the Supervisor already reads, so a rate change is an env update — not a code
 * deploy — and both consumers stay in lockstep:
 *
 *   DEEPSEEK_INPUT_PRICE_PER_M   — input/prompt price in USD per 1M tokens
 *   DEEPSEEK_OUTPUT_PRICE_PER_M  — output/completion price in USD per 1M tokens
 *
 * Defaults reflect DeepSeek pricing as of 2026-04 ($0.28/M in, $0.42/M out).
 * If the env vars are absent we fall back to these documented defaults and the
 * resolver reports `usedDefault: true` so callers can log loudly that no
 * configured rate was found (CANON theater prohibition — never a silent $0).
 */

/** DeepSeek pricing as of 2026-04, used when env config is absent. */
export const DEEPSEEK_DEFAULT_INPUT_PRICE_PER_M = 0.28;
export const DEEPSEEK_DEFAULT_OUTPUT_PRICE_PER_M = 0.42;

/** Environment variable names for operator-configurable LLM pricing. */
export const LLM_INPUT_PRICE_ENV = 'DEEPSEEK_INPUT_PRICE_PER_M';
export const LLM_OUTPUT_PRICE_ENV = 'DEEPSEEK_OUTPUT_PRICE_PER_M';

/** Resolved per-million-token pricing rates. */
export interface LlmPricingRates {
  /** Input/prompt price in USD per 1,000,000 tokens. */
  readonly inputPricePerM: number;
  /** Output/completion price in USD per 1,000,000 tokens. */
  readonly outputPricePerM: number;
  /**
   * True when one or both rates fell back to the documented DeepSeek default
   * because the corresponding env var was missing or unparseable. Callers
   * should log this so a silent default is never mistaken for configured pricing.
   */
  readonly usedDefault: boolean;
}

/**
 * Resolve LLM pricing rates from the environment, falling back to documented
 * DeepSeek defaults when an env var is absent or unparseable.
 *
 * Reads the same env vars as the Supervisor's CostTrackerService so the two
 * cost paths cannot drift.
 *
 * @param env - Environment source (defaults to process.env). Injectable for tests.
 */
export function resolveLlmPricingFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LlmPricingRates {
  const parsed = (
    raw: string | undefined,
    fallback: number,
  ): { value: number; usedDefault: boolean } => {
    if (raw === undefined || raw === '') {
      return { value: fallback, usedDefault: true };
    }
    const n = parseFloat(raw);
    if (!Number.isFinite(n) || n < 0) {
      return { value: fallback, usedDefault: true };
    }
    return { value: n, usedDefault: false };
  };

  const input = parsed(env[LLM_INPUT_PRICE_ENV], DEEPSEEK_DEFAULT_INPUT_PRICE_PER_M);
  const output = parsed(env[LLM_OUTPUT_PRICE_ENV], DEEPSEEK_DEFAULT_OUTPUT_PRICE_PER_M);

  return {
    inputPricePerM: input.value,
    outputPricePerM: output.value,
    usedDefault: input.usedDefault || output.usedDefault,
  };
}

/**
 * Compute the USD cost of LLM usage from token counts and pricing rates.
 *
 * Mirrors the Supervisor's CostTrackerService.recordCost math exactly:
 *   cost = (inputTokens / 1M) * inputPricePerM + (outputTokens / 1M) * outputPricePerM
 *
 * @param inputTokens  - Prompt tokens consumed.
 * @param outputTokens - Completion tokens consumed.
 * @param rates        - Resolved pricing rates (see resolveLlmPricingFromEnv).
 * @returns Estimated cost in USD, rounded to 6 decimal places.
 */
export function estimateLlmCostUsd(
  inputTokens: number,
  outputTokens: number,
  rates: LlmPricingRates,
): number {
  const safeInput = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0;
  const safeOutput = Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0;

  const cost =
    (safeInput / 1_000_000) * rates.inputPricePerM +
    (safeOutput / 1_000_000) * rates.outputPricePerM;

  // Round to 6 dp to match LlmResponse.cost convention.
  return Math.round(cost * 1_000_000) / 1_000_000;
}
