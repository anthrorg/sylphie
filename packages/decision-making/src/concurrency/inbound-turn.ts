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
 * Per-turn identity and content for the CycleGuard queue.
 *
 * WS4 Ticket 1: turnId + isGuardian + receivedAt/enqueuedAt wired so the
 * two-lane queue can operate and declines are addressed.
 *
 * WS4 Ticket 2: `text` added so each queued turn carries its own text,
 * preventing the text-smear defect where burst turns clobber a shared slot.
 *
 * WS4 Ticket 3: `userId`, `username`, `socketId` added so identity is
 * available throughout the full cycle pipeline. Populated from the verified
 * JWT at the gateway boundary via intakeTurn(). The `isGuardian` flag is now
 * populated from the JWT `isGuardian` claim (previously always false).
 *
 * IMPORTANT: The tokenless legacy default (userId='guardian', isGuardian=true)
 * is preserved for backward compatibility with the gate until Ticket 4 lands
 * the full guest-default flip. Ticket 4 will change the default to
 * userId='guest', isGuardian=false.
 */
export interface InboundTurn {
  /** Stable identifier for this turn, minted at intake. */
  turnId: string;

  /**
   * Whether this turn originates from the guardian (authenticated).
   * Populated from the JWT `isGuardian` claim (WS4 Ticket 3).
   * Tokenless connections default to true for legacy compatibility (Ticket 4
   * will flip this to false once the gate mints guardian JWTs).
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

  // ----- Identity fields (WS4 Ticket 3) -------------------------------------

  /**
   * PostgreSQL User.id for this turn's speaker.
   * Populated from the verified JWT `sub` claim at the gateway boundary.
   * Tokenless connections default to 'guardian' (legacy — Ticket 4 changes to 'guest').
   */
  userId?: string;

  /**
   * Display name of the speaker.
   * Populated from the verified JWT `username` claim.
   * Tokenless connections default to 'Guardian' (legacy).
   */
  username?: string;

  /**
   * The WebSocket socket ID of the connection that sent this turn.
   * Populated at intake (gateway assigns a connection-local id).
   * Used for targeted delivery in Ticket 4; carried here for future use.
   */
  socketId?: string;

  // ----- Originator-less cycle triggers (WS5 T1.0) --------------------------

  /**
   * WS5 T1.0 — marks a cycle nudged by an exogenous SCENE CHANGE, not a human
   * speaker. The perception gateway enqueues one of these (deduped, see
   * PerceptionGateway) when a confirmed-object scene change occurs, so a
   * salient-but-CALM visual frame reaches the cognitive cycle even when drives
   * are cold (the self-tick is pressure-gated at IDLE_PRESSURE_THRESHOLD=4.0 and
   * would otherwise never sample the scene). The frame's scene is read from the
   * tick-sampler slot at drain via sample(), exactly like a self-tick.
   *
   * It carries NO originator: `runCycleForTurn` leaves `currentTurnContext` null
   * for a sceneNudge turn, so the resulting episode has `speakerId`/
   * `speakerIsGuardian` STRUCTURALLY ABSENT (T0.9 — a synthetic/exogenous
   * seen-fact never masquerades as guardian-told). It is non-guardian, so it
   * rides the evictable normal lane, never the guardian lane.
   *
   * Loop-safety (ashby, T1.0/finding-I): the trigger keys on an EXOGENOUS
   * scene-change predicate (the world, not Sylphie's drives) and writes NOTHING
   * to drives — so it does not by itself close a perception→drive→perception
   * loop. The cooldown bound on the gateway side is ashby's loop-gain sign-off
   * item (held conservative pending that sign-off).
   */
  sceneNudge?: boolean;
}
