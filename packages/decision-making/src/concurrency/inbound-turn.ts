/**
 * InboundTurn — the minimal queue entry for WS4 Ticket 1.
 *
 * Carries the identity-lite fields that Ticket 1 needs to route declines and
 * watchdog SHRUGs back to the originating turn. Tickets 2/3 will thread real
 * socket / userId / username through; the shape here is intentionally
 * extension-friendly — add fields to InboundTurn without touching CycleGuard.
 *
 * CANON §Theater Prohibition: every admitted turn must receive exactly one
 * honest outcome. This type is the unit of admission.
 */

/**
 * Minimum per-turn identity for Ticket 1.
 *
 * Tickets 2/3 will replace the opaque `payload` with `text: string` and add
 * `userId`, `username`, `socketId` once identity threading lands. The `isGuardian`
 * flag is wired now so the two-lane queue can operate from day one, even though
 * Ticket 3 is what populates it from a real JWT claim.
 */
export interface InboundTurn {
  /** Stable identifier for this turn, minted at intake. */
  turnId: string;

  /**
   * Whether this turn originates from the guardian (authenticated Jim).
   * Defaults to false. Ticket 3 will populate from the JWT isGuardian claim.
   * Guardian turns are never evicted and always drain first.
   */
  isGuardian: boolean;

  /** Wall-clock time the turn arrived at the gateway. */
  receivedAt: number;

  /** Wall-clock time the turn was enqueued into CycleGuard. */
  enqueuedAt: number;

  /**
   * Opaque text payload. Tickets 2/3 will replace this with a typed field
   * on the InboundTurn itself. For Ticket 1 the field is required so the
   * watchdog SHRUG can be emitted with useful context even without full
   * identity threading.
   */
  text?: string;

  // ----- Extension slots for Tickets 2/3 ------------------------------------
  // userId?: string;
  // username?: string;
  // socketId?: string;
  // -------------------------------------------------------------------------
}
