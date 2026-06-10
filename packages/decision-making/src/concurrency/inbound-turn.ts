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
   * The raw text of this turn, as received at the gateway boundary.
   *
   * Minted at intake alongside turnId (WS4 Ticket 2). Every queued turn carries
   * its own text so that when the cycle drains and calls tickSampler.sample(),
   * it gets THIS turn's text — not whatever was last written to the global slot.
   * This is the fix for the text-smear defect: cycle N sampled the real text,
   * cycles N+1..N+K sampled null and re-answered stale history.
   *
   * Self-initiated ticks (no originator) carry an empty string; synthetic-text
   * turns use the injected text. The cycle runner writes this into the tick-sampler's
   * text slot via injectSyntheticText() (no-callback path) before sampling.
   */
  text: string;

  // ----- Extension slots for Ticket 3 ---------------------------------------
  // userId?: string;
  // username?: string;
  // socketId?: string;
  // -------------------------------------------------------------------------
}
