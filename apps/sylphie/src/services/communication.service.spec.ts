/**
 * TK-115 — handleCycleResponse rejection is caught, not left unhandled.
 *
 * Direct-instantiation unit test (repo convention). All collaborators are
 * stubs except decisionMaking.response$, a real rxjs Subject so onModuleInit's
 * subscription wiring can be exercised end-to-end.
 */

import { Subject } from 'rxjs';
import { CommunicationService } from './communication.service';

function makeService(response$: Subject<any>) {
  const decisionMaking = { response$: response$.asObservable() } as any;
  const noop = {} as any;
  return new CommunicationService(
    decisionMaking,
    noop, // DRIVE_STATE_READER
    noop, // ACTION_OUTCOME_REPORTER
    noop, // LLM_SERVICE
    noop, // TimescaleService
    noop, // TtsService
    noop, // ConversationHistoryService
    noop, // PersonModelService
    noop, // VoiceLatentSpaceService
    noop, // FastFactWriterService
    noop, // TickSamplerService
    noop, // CycleGuardService
    noop, // WkgContextService
    noop, // CycleOutcomeReporterService
  );
}

describe('CommunicationService.onModuleInit — response$ subscription (TK-115)', () => {
  it('catches a handleCycleResponse rejection instead of leaving it unhandled', async () => {
    const response$ = new Subject<any>();
    const service = makeService(response$);

    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);

    jest.spyOn(service as any, 'handleCycleResponse').mockRejectedValue(new Error('boom'));
    const loggerErrorSpy = jest.spyOn((service as any).logger, 'error').mockImplementation(() => {});

    service.onModuleInit();
    response$.next({ turnId: 'turn-123' });

    // Let the rejected promise's .catch settle.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('handleCycleResponse rejected for turnId=turn-123'),
      expect.anything(),
    );
    expect(unhandled).not.toHaveBeenCalled();

    process.off('unhandledRejection', unhandled);
  });

  it('does not log an error on the normal (resolving) path', async () => {
    const response$ = new Subject<any>();
    const service = makeService(response$);

    jest.spyOn(service as any, 'handleCycleResponse').mockResolvedValue(true);
    const loggerErrorSpy = jest.spyOn((service as any).logger, 'error').mockImplementation(() => {});

    service.onModuleInit();
    response$.next({ turnId: 'turn-456' });

    await new Promise((resolve) => setImmediate(resolve));

    expect(loggerErrorSpy).not.toHaveBeenCalled();
  });
});
