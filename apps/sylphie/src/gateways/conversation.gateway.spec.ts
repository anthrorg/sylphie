/**
 * TK-114 — trigger-phrase rejection client notification.
 *
 * Direct-instantiation unit test (repo convention). Exercises the real
 * @SubscribeMessage('message') handler against a mock CommunicationService
 * whose handleTriggerPhrase() rejects, proving the originating client is
 * notified instead of the spinner silently stalling at is_thinking:true.
 */

import { ConversationGateway } from './conversation.gateway';

function makeMockClient() {
  return { readyState: 1 /* WebSocket.OPEN */, send: jest.fn() };
}

function makeGateway(handleTriggerPhraseImpl: () => Promise<boolean>) {
  const communication = {
    handleTriggerPhrase: jest.fn(handleTriggerPhraseImpl),
    intakeTurn: jest.fn().mockReturnValue('turn-1'),
  } as any;
  const personModel = {} as any;
  const configService = { get: () => undefined } as any;
  return new ConversationGateway(communication, personModel, configService);
}

// Flush the microtask queue so the handler's async .then/.catch chain settles.
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('ConversationGateway.handleMessage — trigger-phrase rejection (TK-114)', () => {
  it('notifies the originating client with thinking_indicator error:true when handleTriggerPhrase rejects', async () => {
    const gateway = makeGateway(() => Promise.reject(new Error('personModel.loadFacts() threw')));
    const client = makeMockClient();

    gateway.handleMessage({ text: 'who am I?', type: 'text' }, client as any);
    await flush();
    await flush();

    const errorMessage = client.send.mock.calls
      .map(([raw]) => JSON.parse(raw as string))
      .find((msg) => msg.type === 'thinking_indicator' && msg.error === true);

    expect(errorMessage).toEqual({ type: 'thinking_indicator', is_thinking: false, error: true });
  });

  it('does NOT send an error notification on the normal (non-rejecting) path', async () => {
    const gateway = makeGateway(() => Promise.resolve(false));
    const client = makeMockClient();

    gateway.handleMessage({ text: 'hello', type: 'text' }, client as any);
    await flush();
    await flush();

    const errorMessage = client.send.mock.calls
      .map(([raw]) => JSON.parse(raw as string))
      .find((msg) => msg.type === 'thinking_indicator' && msg.error === true);

    expect(errorMessage).toBeUndefined();
  });
});

describe('ConversationGateway.routeDelivery — half-dead socket purge (TK-115)', () => {
  it('purges a half-dead socket found via socketIdToClient from ALL five maps, then falls back to userId/broadcast', () => {
    const gateway = makeGateway(() => Promise.resolve(false));
    const deadClient = { readyState: 3 /* CLOSED */, send: jest.fn(), close: jest.fn() };

    // Register the dead client directly into the gateway's internal maps
    // (bypassing handleConnection's JWT extraction — this test only cares
    // about routeDelivery's purge behavior, not connection auth).
    (gateway as any).clients.add(deadClient);
    (gateway as any).clientSocketIds.set(deadClient, 'sock-1');
    (gateway as any).socketIdToClient.set('sock-1', deadClient);
    (gateway as any).clientUsers.set(deadClient, { userId: 'u1', username: 'u1', isGuardian: false });
    (gateway as any).userIdToClient.set('u1', deadClient);

    expect((gateway as any).clients.size).toBe(1);

    (gateway as any).routeDelivery({ turnId: 't1', originator: { socketId: 'sock-1', userId: 'u1' }, text: 'hi' });

    expect((gateway as any).clients.has(deadClient)).toBe(false);
    expect((gateway as any).clientUsers.has(deadClient)).toBe(false);
    expect((gateway as any).clientSocketIds.has(deadClient)).toBe(false);
    expect((gateway as any).socketIdToClient.has('sock-1')).toBe(false);
    expect((gateway as any).userIdToClient.has('u1')).toBe(false);
  });

  it('a live socket found via socketIdToClient is NOT purged and receives the delivery', () => {
    const gateway = makeGateway(() => Promise.resolve(false));
    const liveClient = { readyState: 1 /* OPEN */, send: jest.fn() };

    (gateway as any).clients.add(liveClient);
    (gateway as any).clientSocketIds.set(liveClient, 'sock-2');
    (gateway as any).socketIdToClient.set('sock-2', liveClient);

    (gateway as any).routeDelivery({ turnId: 't2', originator: { socketId: 'sock-2' }, text: 'hi' });

    expect(liveClient.send).toHaveBeenCalledWith(JSON.stringify({ turnId: 't2', originator: { socketId: 'sock-2' }, text: 'hi' }));
    expect((gateway as any).clients.has(liveClient)).toBe(true);
    expect((gateway as any).socketIdToClient.has('sock-2')).toBe(true);
  });
});
