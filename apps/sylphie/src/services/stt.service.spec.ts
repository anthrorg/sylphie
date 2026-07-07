/**
 * TK-113 — STT session-identity-guarded close handler.
 *
 * Mocks the `ws` module (no live Deepgram connection) so the reconnect-churn
 * race — a new session created for a clientId before the OLD session's close
 * event fires — can be deterministically reproduced.
 */

import { EventEmitter } from 'events';

class MockWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  send = jest.fn();
  close = jest.fn();

  constructor(_url: string, _opts?: unknown) {
    super();
    MockWebSocket.instances.push(this);
  }
}

jest.mock('ws', () => {
  return MockWebSocket;
});

import { SttService } from './stt.service';

function makeConfig(apiKey = 'test-key') {
  return { get: () => apiKey } as any;
}

describe('SttService — session-identity-guarded close handler (TK-113)', () => {
  beforeEach(() => {
    MockWebSocket.instances.length = 0;
    // The 'open' handler starts a real KeepAlive setInterval(...,5000) per
    // session. Fake timers keep it from ever firing/holding the event loop
    // open in this unit test (no real Deepgram connection to keep alive).
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('a stale close event (old session, reconnect churn) does NOT delete the replacement session\'s sessions/keepAliveTimers/pendingBuffers entries', () => {
    const service = new SttService(makeConfig());
    service.onModuleInit();

    // First session for clientId "abc".
    service.createSession('abc', jest.fn());
    const oldWs = MockWebSocket.instances[0];
    oldWs.readyState = MockWebSocket.OPEN;
    oldWs.emit('open');

    // Reconnect churn: a NEW session is created for the same clientId
    // BEFORE the old session's close event fires.
    service.createSession('abc', jest.fn());
    const newWs = MockWebSocket.instances[1];
    newWs.readyState = MockWebSocket.OPEN;
    newWs.emit('open');

    expect((service as any).sessions.get('abc')).toBe(newWs);
    expect((service as any).sessions.size).toBe(1);

    // NOW the old (superseded) session's close event fires late.
    oldWs.emit('close', 1006, Buffer.from(''));

    // The replacement session's entries must be untouched.
    expect((service as any).sessions.get('abc')).toBe(newWs);
    expect((service as any).sessions.has('abc')).toBe(true);
  });

  it('a session\'s own (non-superseded) close event fully cleans up all three maps', () => {
    const service = new SttService(makeConfig());
    service.onModuleInit();

    service.createSession('solo', jest.fn());
    const ws = MockWebSocket.instances[0];
    ws.readyState = MockWebSocket.OPEN;
    ws.emit('open');

    expect((service as any).sessions.has('solo')).toBe(true);
    expect((service as any).keepAliveTimers.has('solo')).toBe(true);

    ws.emit('close', 1000, Buffer.from(''));

    expect((service as any).sessions.has('solo')).toBe(false);
    expect((service as any).keepAliveTimers.has('solo')).toBe(false);
    expect((service as any).pendingBuffers.has('solo')).toBe(false);
  });

  it('the stale-close onClose callback still fires (caller is notified) even though maps are not touched', () => {
    const service = new SttService(makeConfig());
    service.onModuleInit();

    const oldOnClose = jest.fn();
    service.createSession('churny', jest.fn(), oldOnClose);
    const oldWs = MockWebSocket.instances[0];
    oldWs.readyState = MockWebSocket.OPEN;
    oldWs.emit('open');

    service.createSession('churny', jest.fn());
    const newWs = MockWebSocket.instances[1];
    newWs.readyState = MockWebSocket.OPEN;
    newWs.emit('open');

    oldWs.emit('close', 1006, Buffer.from(''));

    expect(oldOnClose).toHaveBeenCalledWith(1006, '');
    expect((service as any).sessions.get('churny')).toBe(newWs);
  });
});
