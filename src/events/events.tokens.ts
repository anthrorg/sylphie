/**
 * Injection tokens for the Events module.
 *
 * Consumers inject IEventService by referencing EVENTS_SERVICE:
 *
 *   @Inject(EVENTS_SERVICE) private readonly events: IEventService
 *
 * Using a Symbol prevents accidental token collisions with other modules
 * and makes the injection site self-documenting.
 */

/** DI token for IEventService. Provided by EventsModule. */
export const EVENTS_SERVICE = Symbol('EVENTS_SERVICE');

/** DI token for the TimescaleDB pg.Pool instance. Provided by EventsModule. */
export const TIMESCALEDB_POOL = Symbol('TIMESCALEDB_POOL');
