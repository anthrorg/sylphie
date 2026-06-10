import { Controller, HttpCode, Inject, Logger, Post } from '@nestjs/common';
import { LLM_SERVICE, type ILlmService } from '@sylphie/shared';

/**
 * LlmController — Lesion Test control surface (CANON §The Lesion Test).
 *
 * Exposes the LLM availability flag over REST so the Provability Gate can take
 * the system's INTENDED "LLM unplugged" path rather than a transport-level
 * socket crash.
 *
 * The distinction is the whole point of the gate's correctness:
 *   - Severing the outbound socket (cassette lesion) throws mid-call, deep in
 *     OllamaLlmService.complete(). That bubbles out of deliberation as an
 *     unhandled error and the cycle produces no response — a *crash*, not
 *     graceful degradation.
 *   - Setting available=false here makes isAvailable() return false, so
 *     deliberation short-circuits to its no-LLM SHRUG path and the system stays
 *     coherent — the behavior the Lesion Test is meant to prove.
 *
 * The gate lesions BOTH (socket + this flag) as defense in depth; this flag is
 * what makes the degradation graceful.
 *
 * CANON §Theater Prohibition / no self-modification of evaluation: these routes
 * only toggle LLM availability. They do not alter drive state, metrics, or any
 * scoring/evaluation path.
 */
@Controller('llm')
export class LlmController {
  private readonly logger = new Logger(LlmController.name);

  constructor(
    @Inject(LLM_SERVICE)
    private readonly llm: ILlmService,
  ) {}

  /**
   * POST /llm/lesion
   *
   * Mark the LLM service unavailable for the Lesion Test. After this call,
   * isAvailable() returns false and every Type 2 / deliberation path must
   * degrade to a SHRUG or a Type 1 reflex.
   */
  @Post('lesion')
  @HttpCode(200)
  lesion(): { ok: true; available: boolean } {
    this.llm.enableLesionTest();
    this.logger.warn('LLM LESIONED via /api/llm/lesion — service marked unavailable.');
    return { ok: true, available: this.llm.isAvailable() };
  }

  /**
   * POST /llm/heal
   *
   * Restore LLM availability after the Lesion Test (also clears a tripped
   * circuit breaker). Leaves the running stack in a clean state.
   */
  @Post('heal')
  @HttpCode(200)
  heal(): { ok: true; available: boolean } {
    this.llm.resetCircuitBreaker();
    this.logger.log('LLM HEALED via /api/llm/heal — service marked available.');
    return { ok: true, available: this.llm.isAvailable() };
  }
}
