import { Injectable, Logger } from '@nestjs/common';
import { SensoryFrame } from '@sylphie/shared';
import { TickSamplerService } from '../inputs/sampling/tick-sampler';
import {
  InnerMonologueService,
  MonologueOutput,
} from '../monologue/inner-monologue';
import { MakePredictionService, Prediction } from '../prediction/make-prediction';
import { Type1Handler } from '../reasoning/type-1.handler';
import { Type2Handler } from '../reasoning/type-2.handler';
import { ReasoningEngine } from '../reasoning/reasoning-engine';
import { MakesChoiceService, TickEvent } from '../action/makes-choice';
import { SystemReactsService } from '../action/system-reacts';

/**
 * The main decision loop.
 *
 * Each tick:
 *   1. Sample sensory inputs → SensoryFrame
 *   2. Run inner monologue (reads episodic memory + WKG)
 *   3. Generate predictions from WKG
 *   4. Route to Type 1 (reflex) and Type 2 (deliberative) paths in parallel
 *   5. Reasoning engine arbitrates between candidates
 *   6. Makes choice → emits tick event
 *   7. System reacts → executes chosen action
 *
 * Failed predictions from the drive engine shift weight toward Type 2.
 */
@Injectable()
export class ExecutorEngine {
  private readonly logger = new Logger(ExecutorEngine.name);
  private type2Weight = 0;

  constructor(
    private readonly tickSampler: TickSamplerService,
    private readonly innerMonologue: InnerMonologueService,
    private readonly makePrediction: MakePredictionService,
    private readonly type1Handler: Type1Handler,
    private readonly type2Handler: Type2Handler,
    private readonly reasoningEngine: ReasoningEngine,
    private readonly makesChoice: MakesChoiceService,
    private readonly systemReacts: SystemReactsService,
  ) {}

  /**
   * Execute a single decision cycle.
   * Called on each tick by the application's tick loop.
   */
  async tick(): Promise<TickEvent | null> {
    // 1. Sample sensory inputs into a fused SensoryFrame
    const frame = await this.tickSampler.sample();
    this.logger.debug(
      `Tick: ${frame.active_modalities.length} active modalities`,
    );

    // 2. Inner monologue — reason about what to do
    const monologue = await this.innerMonologue.process(frame);

    // 3. Generate predictions
    const predictions = await this.makePrediction.predict(frame);

    // 4. Route to Type 1 and Type 2 paths in parallel
    const [type1Candidate, type2Candidate] = await Promise.all([
      this.type1Handler.evaluate(frame, monologue),
      this.type2Handler.evaluate(frame, monologue),
    ]);

    // 5. Reasoning engine arbitrates
    const chosenAction = await this.reasoningEngine.evaluate(
      type1Candidate,
      type2Candidate,
    );

    if (!chosenAction) {
      this.logger.debug('No action candidate produced this tick');
      return null;
    }

    // 6. Commit the choice — write tick event
    const tickEvent = await this.makesChoice.commit(
      frame,
      chosenAction,
      predictions,
    );

    // 7. Execute the chosen action
    await this.systemReacts.execute(tickEvent);

    return tickEvent;
  }

  /**
   * Called by the drive engine when predictions fail.
   * Increases weight given to Type 2 (deliberative) path.
   */
  onPredictionFailed() {
    this.type2Weight = Math.min(this.type2Weight + 1, 10);
    this.logger.debug(`Prediction failed — type2Weight now ${this.type2Weight}`);
  }

  /**
   * Called by the drive engine when predictions succeed.
   * Decreases weight toward Type 2, favoring Type 1 reflexes.
   */
  onPredictionSucceeded() {
    this.type2Weight = Math.max(this.type2Weight - 1, 0);
    this.logger.debug(
      `Prediction succeeded — type2Weight now ${this.type2Weight}`,
    );
  }
}
