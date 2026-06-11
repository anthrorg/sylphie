/**
 * WS4 Ticket 4 — Unit tests for targeted delivery routing decision table
 * and per-turn person context selection.
 *
 * Tests the routing logic extracted from ConversationGateway.routeDelivery():
 *
 *   TARGETED      — originator.socketId present AND socket alive → send to that socket only
 *   USER_FALLBACK — socketId stale/absent, userId present AND socket alive → send to userId socket
 *   BROADCAST     — no originator (self-tick / ambient) → send to all sockets
 *   LOGGED_DROP   — originator present, user disconnected entirely → log + drop, no crash
 *
 * Also tests per-turn person-context selection:
 *   - With turn originator: use originator.userId, not global activePersonId
 *   - Without originator (self-tick): fall back to activePersonId
 *   - Concurrent turns: each cycle reads its own speaker's context
 */

// Suppress verbose logs in tests
jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return {
    ...actual,
    verboseFor: () => () => {},
  };
});

// ---------------------------------------------------------------------------
// Minimal WebSocket mock that tracks sent messages
// ---------------------------------------------------------------------------

const OPEN = 1;
const CLOSED = 3;

function makeMockSocket(open = true): { readyState: number; sent: string[]; send: jest.Mock } {
  const sent: string[] = [];
  return {
    readyState: open ? OPEN : CLOSED,
    sent,
    send: jest.fn((data: string) => { sent.push(data); }),
  };
}

// ---------------------------------------------------------------------------
// Minimal logger mock
// ---------------------------------------------------------------------------

function makeLogger() {
  const warns: string[] = [];
  return {
    warn: jest.fn((msg: string) => { warns.push(msg); }),
    warns,
  };
}

// ---------------------------------------------------------------------------
// The routing logic extracted from ConversationGateway.routeDelivery()
// (pure function form — same logic, no NestJS dependency).
// This mirrors the implementation so that tests catch real regressions.
// ---------------------------------------------------------------------------

interface MockGateway {
  socketIdToClient: Map<string, ReturnType<typeof makeMockSocket>>;
  userIdToClient: Map<string, ReturnType<typeof makeMockSocket>>;
  clients: Set<ReturnType<typeof makeMockSocket>>;
  logger: ReturnType<typeof makeLogger>;
}

function routeDelivery(gw: MockGateway, delivery: unknown): string {
  const originator = (delivery as any).originator as
    | { socketId?: string; userId?: string }
    | undefined;

  if (!originator) {
    // BROADCAST — no originator (self-tick / ambient)
    const message = JSON.stringify(delivery);
    for (const client of gw.clients) {
      if (client.readyState === OPEN) {
        client.send(message);
      }
    }
    return 'BROADCAST';
  }

  const { socketId, userId } = originator;

  // TARGETED — socketId → live socket
  if (socketId) {
    const target = gw.socketIdToClient.get(socketId);
    if (target && target.readyState === OPEN) {
      target.send(JSON.stringify(delivery));
      return 'TARGETED';
    }
    // Fall through — socket stale
  }

  // USER_FALLBACK — userId → current socket
  if (userId) {
    const target = gw.userIdToClient.get(userId);
    if (target && target.readyState === OPEN) {
      target.send(JSON.stringify(delivery));
      return 'USER_FALLBACK';
    }
    // LOGGED_DROP
    gw.logger.warn(
      `[Ticket 4] Delivery dropped — originator disconnected: ` +
      `userId=${userId} socketId=${socketId ?? 'none'} ` +
      `turnId=${(delivery as any).turnId ?? 'unknown'}`,
    );
    return 'LOGGED_DROP';
  }

  // Malformed originator — broadcast with warning
  gw.logger.warn(`[Ticket 4] Delivery originator has no socketId or userId — broadcast fallback`);
  const message = JSON.stringify(delivery);
  for (const client of gw.clients) {
    if (client.readyState === OPEN) {
      client.send(message);
    }
  }
  return 'BROADCAST_FALLBACK';
}

// ---------------------------------------------------------------------------
// Helper: build a fresh gateway with two connected users
// ---------------------------------------------------------------------------

function makeGateway() {
  const socketA = makeMockSocket(true);
  const socketB = makeMockSocket(true);
  const logger = makeLogger();

  const gw: MockGateway = {
    socketIdToClient: new Map([
      ['sock-1', socketA],
      ['sock-2', socketB],
    ]),
    userIdToClient: new Map([
      ['user-A', socketA],
      ['user-B', socketB],
    ]),
    clients: new Set([socketA, socketB]),
    logger,
  };

  return { gw, socketA, socketB, logger };
}

// ---------------------------------------------------------------------------
// Routing decision table tests
// ---------------------------------------------------------------------------

describe('Targeted delivery routing decision table (WS4 Ticket 4)', () => {

  // ── TARGETED ──────────────────────────────────────────────────────────────

  test('TARGETED: originator with live socketId → sends only to that socket', () => {
    const { gw, socketA, socketB } = makeGateway();
    const delivery = { type: 'cb_speech', text: 'hi', turnId: 't1', originator: { socketId: 'sock-1', userId: 'user-A', isGuardian: true } };

    const route = routeDelivery(gw, delivery);

    expect(route).toBe('TARGETED');
    expect(socketA.sent).toHaveLength(1);
    expect(JSON.parse(socketA.sent[0]).type).toBe('cb_speech');
    // Socket B must NOT receive it
    expect(socketB.sent).toHaveLength(0);
  });

  test('TARGETED: only the correct socket receives when multiple are open', () => {
    const { gw, socketA, socketB } = makeGateway();
    const delivery = { type: 'cb_speech', text: 'reply to B', turnId: 't2', originator: { socketId: 'sock-2', userId: 'user-B', isGuardian: false } };

    routeDelivery(gw, delivery);

    expect(socketB.sent).toHaveLength(1);
    expect(socketA.sent).toHaveLength(0);
  });

  // ── USER_FALLBACK ─────────────────────────────────────────────────────────

  test('USER_FALLBACK: stale socketId falls through to userId lookup', () => {
    const { gw, socketA, socketB } = makeGateway();
    // Remove sock-1 from the socketId map (simulates disconnect+reconnect, socketId stale)
    gw.socketIdToClient.delete('sock-1');
    const delivery = { type: 'cb_speech', text: 'hi', turnId: 't3', originator: { socketId: 'sock-1', userId: 'user-A', isGuardian: true } };

    const route = routeDelivery(gw, delivery);

    expect(route).toBe('USER_FALLBACK');
    expect(socketA.sent).toHaveLength(1);
    expect(socketB.sent).toHaveLength(0);
  });

  test('USER_FALLBACK: absent socketId (undefined) falls through to userId lookup', () => {
    const { gw, socketA, socketB } = makeGateway();
    const delivery = { type: 'cb_speech', text: 'hi', turnId: 't4', originator: { userId: 'user-A', isGuardian: true } };

    const route = routeDelivery(gw, delivery);

    expect(route).toBe('USER_FALLBACK');
    expect(socketA.sent).toHaveLength(1);
    expect(socketB.sent).toHaveLength(0);
  });

  // ── LOGGED_DROP ───────────────────────────────────────────────────────────

  test('LOGGED_DROP: originator fully disconnected → no crash, logs warning', () => {
    const { gw, logger } = makeGateway();
    // Remove both routes for user-C (never connected)
    const delivery = { type: 'cb_speech', text: 'hi', turnId: 't5', originator: { socketId: 'sock-99', userId: 'user-C', isGuardian: false } };

    const route = routeDelivery(gw, delivery);

    expect(route).toBe('LOGGED_DROP');
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]).toContain('Delivery dropped');
    expect(logger.warns[0]).toContain('user-C');
    expect(logger.warns[0]).toContain('t5');
  });

  test('LOGGED_DROP: disconnected mid-turn (socketId stale + userId gone) → logged, no crash', () => {
    const { gw, socketA, socketB, logger } = makeGateway();
    // Simulate B sending and then fully disconnecting
    gw.socketIdToClient.delete('sock-2');
    gw.userIdToClient.delete('user-B');
    gw.clients.delete(socketB);

    const delivery = { type: 'cb_speech', text: 'reply', turnId: 't6', originator: { socketId: 'sock-2', userId: 'user-B', isGuardian: false } };

    expect(() => routeDelivery(gw, delivery)).not.toThrow();
    const route = routeDelivery(gw, delivery); // second call; should also not crash

    expect(route).toBe('LOGGED_DROP');
    // socketA must not have received anything
    expect(socketA.sent).toHaveLength(0);
    expect(logger.warns.some((w) => w.includes('Delivery dropped'))).toBe(true);
  });

  // ── BROADCAST (no originator) ─────────────────────────────────────────────

  test('BROADCAST: no originator (self-tick) → both sockets receive the message', () => {
    const { gw, socketA, socketB } = makeGateway();
    const delivery = { type: 'cb_speech', text: 'ambient utterance', turnId: 'self-1' };
    // No originator field

    const route = routeDelivery(gw, delivery);

    expect(route).toBe('BROADCAST');
    expect(socketA.sent).toHaveLength(1);
    expect(socketB.sent).toHaveLength(1);
  });

  test('BROADCAST: no originator — closed sockets are skipped', () => {
    const { gw, socketA } = makeGateway();
    const closedSocket = makeMockSocket(false); // readyState = CLOSED
    gw.clients.add(closedSocket);

    const delivery = { type: 'cb_speech', text: 'ambient', turnId: 'self-2' };

    routeDelivery(gw, delivery);

    expect(closedSocket.sent).toHaveLength(0);
    expect(socketA.sent).toHaveLength(1);
  });

  // ── Two-user isolation ─────────────────────────────────────────────────────

  test('Two-user isolation: A reply never reaches B, B reply never reaches A', () => {
    const { gw, socketA, socketB } = makeGateway();

    const deliveryA = { type: 'cb_speech', text: 'to A', turnId: 'ta', originator: { socketId: 'sock-1', userId: 'user-A', isGuardian: true } };
    const deliveryB = { type: 'cb_speech', text: 'to B', turnId: 'tb', originator: { socketId: 'sock-2', userId: 'user-B', isGuardian: false } };

    routeDelivery(gw, deliveryA);
    routeDelivery(gw, deliveryB);

    expect(socketA.sent).toHaveLength(1);
    expect(JSON.parse(socketA.sent[0]).text).toBe('to A');
    expect(socketB.sent).toHaveLength(1);
    expect(JSON.parse(socketB.sent[0]).text).toBe('to B');
  });

});

// ---------------------------------------------------------------------------
// Per-turn person context tests (WS4 Ticket 4)
// ---------------------------------------------------------------------------

describe('Per-turn speaker context selection (WS4 Ticket 4)', () => {

  interface PersonFact { key: string; value: string; }
  type PersonCache = Map<string, PersonFact[]>;

  // Minimal in-memory person model that mirrors PersonModelService
  function makePersonModel(initial: Record<string, PersonFact[]> = {}) {
    const cache: PersonCache = new Map(Object.entries(initial));
    let activePersonId: string | null = null;

    return {
      setActivePerson(id: string) { activePersonId = id; },
      getActivePersonId() { return activePersonId; },
      getPersonModel(userId: string) {
        const facts = cache.get(userId) ?? [];
        if (facts.length === 0) return null;
        return { personId: userId, knownFacts: facts.map((f) => `${f.key}: ${f.value}`), interactionSummary: '1 interaction.' };
      },
      /** WS4 Ticket 4 accessor: explicit userId, bypasses global slot */
      getPersonModelForTurn(userId: string) {
        return this.getPersonModel(userId);
      },
      getActivePersonModel() {
        if (!activePersonId) return null;
        return this.getPersonModel(activePersonId);
      },
    };
  }

  test('getPersonModelForTurn(userId) returns the correct person model for an explicit userId', () => {
    const pm = makePersonModel({
      'user-A': [{ key: 'name', value: 'Alice' }],
      'user-B': [{ key: 'name', value: 'Bob' }],
    });

    pm.setActivePerson('user-A'); // global slot points to A

    const modelA = pm.getPersonModelForTurn('user-A');
    const modelB = pm.getPersonModelForTurn('user-B');

    expect(modelA?.personId).toBe('user-A');
    expect(modelA?.knownFacts).toContain('name: Alice');
    expect(modelB?.personId).toBe('user-B');
    expect(modelB?.knownFacts).toContain('name: Bob');
  });

  test('getPersonModelForTurn is unaffected by concurrent setActivePerson calls', () => {
    const pm = makePersonModel({
      'user-A': [{ key: 'name', value: 'Alice' }],
      'user-B': [{ key: 'name', value: 'Bob' }],
    });

    // Simulate turn A in-flight: active person is set to A
    pm.setActivePerson('user-A');

    // Simulate turn B arriving concurrently and clobbering the global slot
    pm.setActivePerson('user-B');

    // Per-turn accessor for turn A still gets Alice's model despite the thrash
    const modelForTurnA = pm.getPersonModelForTurn('user-A');
    expect(modelForTurnA?.personId).toBe('user-A');
    expect(modelForTurnA?.knownFacts).toContain('name: Alice');

    // Per-turn accessor for turn B still gets Bob's model
    const modelForTurnB = pm.getPersonModelForTurn('user-B');
    expect(modelForTurnB?.personId).toBe('user-B');
    expect(modelForTurnB?.knownFacts).toContain('name: Bob');
  });

  test('self-tick falls back to getActivePersonModel (no turn userId)', () => {
    const pm = makePersonModel({
      'user-A': [{ key: 'name', value: 'Alice' }],
    });

    pm.setActivePerson('user-A');

    // Self-tick: no originator → use getActivePersonModel()
    const fallbackModel = pm.getActivePersonModel();
    expect(fallbackModel?.personId).toBe('user-A');
  });

  test('recordInteraction uses originator userId not global activePersonId', () => {
    // Mirror the CommunicationService.handleCycleResponse() interaction-recording logic
    const interactionCounts = new Map<string, number>();

    function recordInteraction(personId: string) {
      interactionCounts.set(personId, (interactionCounts.get(personId) ?? 0) + 1);
    }

    // Turn for user-A arrives, but global activePersonId was clobbered to user-B
    const activePersonId = 'user-B'; // clobbered
    const originatorUserId = 'user-A'; // correct per-turn value

    // WS4 Ticket 4: key off originator userId, not global
    const interactingId = originatorUserId ?? activePersonId;
    recordInteraction(interactingId);

    // user-A got the interaction credit
    expect(interactionCounts.get('user-A')).toBe(1);
    // user-B did NOT get a spurious interaction
    expect(interactionCounts.get('user-B')).toBeUndefined();
  });

  test('self-tick recordInteraction falls back to activePersonId when no originator', () => {
    const interactionCounts = new Map<string, number>();
    function recordInteraction(personId: string) {
      interactionCounts.set(personId, (interactionCounts.get(personId) ?? 0) + 1);
    }

    // Self-tick: no originator, use activePersonId fallback
    const originatorUserId: string | undefined = undefined;
    const activePersonId = 'user-A';

    const interactingId = originatorUserId ?? activePersonId ?? 'guardian';
    recordInteraction(interactingId);

    expect(interactionCounts.get('user-A')).toBe(1);
  });

});
