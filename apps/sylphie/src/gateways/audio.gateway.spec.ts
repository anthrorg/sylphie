/**
 * TK-114 — Deepgram abnormal-close client notification (mic_dead).
 *
 * Direct-instantiation unit test (repo convention). Exercises the private
 * handleDeepgramClose via bracket notation against a minimal ClientState.
 */

import { AudioGateway } from './audio.gateway';

function makeMockWs() {
  return { readyState: 1 /* WebSocket.OPEN */, send: jest.fn() };
}

function makeGateway() {
  const tickSampler = {} as any;
  const stt = { createSession: jest.fn() } as any;
  return new AudioGateway(tickSampler, stt);
}

describe('AudioGateway.handleDeepgramClose (TK-114)', () => {
  it('sends { type: "mic_dead", code } and does NOT auto-reconnect on a non-1000 close code', () => {
    const gateway = makeGateway();
    const ws = makeMockWs();
    (gateway as any).clients.set('audio-1', {
      ws,
      mimeType: null,
      totalBytes: 0,
      chunkCount: 0,
      interimBuffer: '',
    });

    (gateway as any).handleDeepgramClose('audio-1', 1011);

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'mic_dead', code: 1011 }));
    expect(ws.send).not.toHaveBeenCalledWith(JSON.stringify({ type: 'restart_audio' }));
    // No auto-reconnect: createSession should not be called again from this path.
    expect((gateway as any).stt.createSession).not.toHaveBeenCalled();
  });

  it('still auto-reconnects (restart_audio, new session) on a clean 1000 close — no regression', () => {
    const gateway = makeGateway();
    const ws = makeMockWs();
    (gateway as any).clients.set('audio-2', {
      ws,
      mimeType: null,
      totalBytes: 0,
      chunkCount: 0,
      interimBuffer: '',
    });

    (gateway as any).handleDeepgramClose('audio-2', 1000);

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'restart_audio' }));
    expect((gateway as any).stt.createSession).toHaveBeenCalledTimes(1);
  });

  it('does not throw when the socket is not OPEN (readyState mismatch)', () => {
    const gateway = makeGateway();
    const ws = { readyState: 3 /* CLOSED */, send: jest.fn() };
    (gateway as any).clients.set('audio-3', {
      ws,
      mimeType: null,
      totalBytes: 0,
      chunkCount: 0,
      interimBuffer: '',
    });

    expect(() => (gateway as any).handleDeepgramClose('audio-3', 1011)).not.toThrow();
    expect(ws.send).not.toHaveBeenCalled();
  });
});
