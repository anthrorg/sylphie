import { Injectable, Logger } from '@nestjs/common';
import { TickEvent } from './makes-choice';

/**
 * Executes the chosen action. This is where decisions become behavior.
 */
@Injectable()
export class SystemReactsService {
  private readonly logger = new Logger(SystemReactsService.name);

  async execute(tickEvent: TickEvent): Promise<void> {
    this.logger.debug(
      `Executing action: ${tickEvent.chosenAction.actionId}`,
    );
    // TODO: Route to appropriate output system (communication, motor, etc.)
  }
}
