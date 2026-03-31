/**
 * Unit tests for ChatboxGateway.
 *
 * Tests WebSocket connection management, message routing, thread tracking,
 * and broadcast functionality.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ChatboxGateway } from '../chatbox.gateway';
import type { ConversationThread, ConversationMessage } from '../../interfaces/communication.interfaces';

// Type aliases for socket.io (using any since socket.io may not be directly available in test deps)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Socket = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Server = any;

/**
 * Mock Socket implementation for testing.
 */
class MockSocket {
  id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handshake: any;

  emitted: Array<{ event: string; payload: unknown }> = [];

  constructor() {
    this.id = `mock-socket-${Math.random().toString(36).substr(2, 9)}`;
    this.handshake = {
      query: {} as Record<string, string | string[]>,
    };
  }

  emit(event: string, payload: unknown): void {
    this.emitted.push({ event, payload });
  }

  on(): void {
    // Mock on listener
  }
}

/**
 * Mock Server (socket.io Server) implementation for testing.
 */
class MockServer {
  broadcastEmissions: Array<{ event: string; payload: unknown }> = [];

  to(): any {
    return this;
  }

  emit(event: string, payload: unknown): void {
    this.broadcastEmissions.push({ event, payload });
  }
}

describe('ChatboxGateway', () => {
  let gateway: ChatboxGateway;
  let mockSocket: MockSocket;
  let mockServer: MockServer;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ChatboxGateway],
    }).compile();

    gateway = module.get<ChatboxGateway>(ChatboxGateway);
    mockSocket = new MockSocket();
    mockServer = new MockServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).server = mockServer as any;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('connection management', () => {
    it('should register a client on connection', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      gateway.handleConnection(mockSocket as any);

      const clientInfo = gateway.getClientInfo(mockSocket.id);
      expect(clientInfo).toBeDefined();
      expect(clientInfo?.personId).toBe('Person_Jim');
      expect(clientInfo?.socket).toBe(mockSocket);
    });

    it('should create a new thread on connection if not provided', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      gateway.handleConnection(mockSocket as any);

      const emitted = mockSocket.emitted.find((e) => e.event === 'connection_status');
      expect(emitted).toBeDefined();
      expect(emitted?.payload).toHaveProperty('status', 'connected');
      expect(emitted?.payload).toHaveProperty('threadId');
    });

    it('should resume an existing thread if threadId is provided', () => {
      const threadId = 'existing-thread-123';
      mockSocket.handshake.query = { threadId };

      // Pre-create thread
      gateway.getThread(threadId) ?? gateway['conversationThreads'].set(threadId, {
        threadId,
        personId: 'Person_Jim',
        messages: [],
        topics: [],
        startedAt: new Date(),
        lastMessageAt: new Date(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      gateway.handleConnection(mockSocket as any);

      const emitted = mockSocket.emitted.find((e) => e.event === 'connection_status');
      expect(emitted?.payload).toHaveProperty('threadId', threadId);
    });

    it('should unregister a client on disconnect', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      gateway.handleConnection(mockSocket as any);
      expect(gateway.getClientInfo(mockSocket.id)).toBeDefined();

      gateway.handleDisconnect(mockSocket as any);
      expect(gateway.getClientInfo(mockSocket.id)).toBeNull();
    });

    it('should track multiple concurrent connections', () => {
      const socket1 = new MockSocket();
      const socket2 = new MockSocket();

      gateway.handleConnection(socket1 as any);
      gateway.handleConnection(socket2 as any);

      expect(gateway.getAllClients().size).toBe(2);
      expect(gateway.getClientInfo(socket1.id)).toBeDefined();
      expect(gateway.getClientInfo(socket2.id)).toBeDefined();
    });
  });

  describe('message handling', () => {
    beforeEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      gateway.handleConnection(mockSocket as any);
    });

    it('should reject empty messages', async () => {
      const emittedBefore = mockSocket.emitted.length;

      await gateway.handleMessage(mockSocket as any, {
        threadId: 'thread-1',
        text: '',
      });

      const errorEmitted = mockSocket.emitted.find((e) => e.event === 'error');
      expect(errorEmitted).toBeDefined();
      expect(errorEmitted?.payload).toHaveProperty('code', 'INVALID_MESSAGE');
    });

    it('should reject messages with missing threadId', async () => {
      await gateway.handleMessage(mockSocket as any, {
        threadId: '',
        text: 'hello',
      });

      const errorEmitted = mockSocket.emitted.find((e) => e.event === 'error');
      expect(errorEmitted).toBeDefined();
    });

    it('should reject messages for non-existent threads', async () => {
      await gateway.handleMessage(mockSocket as any, {
        threadId: 'non-existent-thread',
        text: 'hello',
      });

      const errorEmitted = mockSocket.emitted.find((e) => e.event === 'error');
      expect(errorEmitted).toBeDefined();
      expect(errorEmitted?.payload).toHaveProperty('code', 'THREAD_NOT_FOUND');
    });

    it('should add a guardian message to the thread', async () => {
      const threadId = mockSocket.handshake.query.threadId
        ? String(mockSocket.handshake.query.threadId)
        : 'default-thread';

      // Ensure thread exists
      gateway['conversationThreads'].set(threadId, {
        threadId,
        personId: 'Person_Jim',
        messages: [],
        topics: [],
        startedAt: new Date(),
        lastMessageAt: new Date(),
      });

      const text = 'Hello Sylphie!';
      await gateway.handleMessage(mockSocket as any, {
        threadId,
        text,
      });

      const thread = gateway.getThread(threadId);
      expect(thread?.messages.length).toBe(1);
      expect(thread?.messages[0].speaker).toBe('guardian');
      expect(thread?.messages[0].content).toBe(text);
    });

    it('should emit an internal process_message event', async () => {
      const threadId = 'thread-1';
      gateway['conversationThreads'].set(threadId, {
        threadId,
        personId: 'Person_Jim',
        messages: [],
        topics: [],
        startedAt: new Date(),
        lastMessageAt: new Date(),
      });

      // Spy on internal emit
      const emitSpy = jest.spyOn(gateway, 'emit');

      await gateway.handleMessage(mockSocket as any, {
        threadId,
        text: 'test message',
      });

      expect(emitSpy).toHaveBeenCalledWith('internal:process_message', expect.any(Object));
    });

    it('should broadcast a typing indicator', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      gateway.handleConnection(mockSocket as any);
      const threadId = (mockSocket.emitted.find((e) => e.event === 'connection_status')?.payload as any)?.threadId;

      await gateway.handleMessage(mockSocket as any, {
        threadId,
        text: 'hello',
      });

      const typingIndicator = mockSocket.emitted.find((e) => e.event === 'typing_indicator');
      expect(typingIndicator).toBeDefined();
    });
  });

  describe('response broadcasting', () => {
    beforeEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      gateway.handleConnection(mockSocket as any);
    });

    it('should add a Sylphie response to the thread', () => {
      const threadId = (mockSocket.emitted.find((e) => e.event === 'connection_status')?.payload as any)?.threadId;
      const responseText = 'Hello, guardian!';
      const timestamp = new Date();

      gateway.broadcastResponse(threadId, responseText, timestamp);

      const thread = gateway.getThread(threadId);
      expect(thread?.messages.length).toBe(1);
      expect(thread?.messages[0].speaker).toBe('sylphie');
      expect(thread?.messages[0].content).toBe(responseText);
    });

    it('should broadcast response to all thread participants', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      gateway.handleConnection(mockSocket as any);
      const threadId = (mockSocket.emitted.find((e) => e.event === 'connection_status')?.payload as any)?.threadId;

      gateway.broadcastResponse(threadId, 'test response');

      const response = mockSocket.emitted.find((e) => e.event === 'sylphie_response');
      expect(response).toBeDefined();
    });

    it('should clear typing indicator after response', () => {
      const threadId = (mockSocket.emitted.find((e) => e.event === 'connection_status')?.payload as any)?.threadId;

      gateway.broadcastResponse(threadId, 'response');

      const typingIndicator = mockSocket.emitted.find(
        (e) => e.event === 'typing_indicator' && !(e.payload as any).isTyping,
      );
      expect(typingIndicator).toBeDefined();
    });

    it('should warn when broadcasting to non-existent thread', () => {
      const warnSpy = jest.spyOn(gateway['logger'], 'warn');

      gateway.broadcastResponse('non-existent', 'message');

      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe('initiated comments', () => {
    beforeEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      gateway.handleConnection(mockSocket as any);
    });

    it('should broadcast an initiated comment', () => {
      const threadId = (mockSocket.emitted.find((e) => e.event === 'connection_status')?.payload as any)?.threadId;
      const text = 'I had a thought...';

      gateway.broadcastInitiatedComment(threadId, text, 'curiosity');

      const initiated = mockSocket.emitted.find((e) => e.event === 'sylphie_initiated');
      expect(initiated).toBeDefined();
      expect(initiated?.payload).toHaveProperty('text', text);
      expect(initiated?.payload).toHaveProperty('motivatingDrive', 'curiosity');
    });

    it('should add initiated comment to thread', () => {
      const threadId = (mockSocket.emitted.find((e) => e.event === 'connection_status')?.payload as any)?.threadId;

      gateway.broadcastInitiatedComment(threadId, 'A comment', 'boredom');

      const thread = gateway.getThread(threadId);
      expect(thread?.messages.some((m) => m.speaker === 'sylphie')).toBe(true);
    });
  });

  describe('thread management', () => {
    it('should update thread topics', () => {
      const threadId = 'thread-1';
      gateway['conversationThreads'].set(threadId, {
        threadId,
        personId: 'Person_Jim',
        messages: [],
        topics: ['initial'],
        startedAt: new Date(),
        lastMessageAt: new Date(),
      });

      gateway.updateThreadTopics(threadId, ['new-topic']);

      const thread = gateway.getThread(threadId);
      expect(thread?.topics).toContain('initial');
      expect(thread?.topics).toContain('new-topic');
    });

    it('should prevent duplicate topics', () => {
      const threadId = 'thread-1';
      gateway['conversationThreads'].set(threadId, {
        threadId,
        personId: 'Person_Jim',
        messages: [],
        topics: ['topic-a'],
        startedAt: new Date(),
        lastMessageAt: new Date(),
      });

      gateway.updateThreadTopics(threadId, ['topic-a', 'topic-b']);

      const thread = gateway.getThread(threadId);
      const topicCount = thread?.topics.filter((t) => t === 'topic-a').length ?? 0;
      expect(topicCount).toBe(1);
    });

    it('should return null for non-existent thread', () => {
      const thread = gateway.getThread('non-existent');
      expect(thread).toBeNull();
    });

    it('should return all threads', () => {
      gateway['conversationThreads'].set('thread-1', {
        threadId: 'thread-1',
        personId: 'Person_Jim',
        messages: [],
        topics: [],
        startedAt: new Date(),
        lastMessageAt: new Date(),
      });

      gateway['conversationThreads'].set('thread-2', {
        threadId: 'thread-2',
        personId: 'Person_Jim',
        messages: [],
        topics: [],
        startedAt: new Date(),
        lastMessageAt: new Date(),
      });

      const allThreads = gateway.getAllThreads();
      expect(allThreads.size).toBe(2);
      expect(allThreads.has('thread-1')).toBe(true);
      expect(allThreads.has('thread-2')).toBe(true);
    });
  });

  describe('client info retrieval', () => {
    it('should return client info when connected', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      gateway.handleConnection(mockSocket as any);

      const info = gateway.getClientInfo(mockSocket.id);
      expect(info).toBeDefined();
      expect(info?.personId).toBe('Person_Jim');
    });

    it('should return null for disconnected client', () => {
      const info = gateway.getClientInfo('unknown-client');
      expect(info).toBeNull();
    });

    it('should return all connected clients', () => {
      const socket1 = new MockSocket();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      gateway.handleConnection(socket1 as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      gateway.handleConnection(mockSocket as any);

      const allClients = gateway.getAllClients();
      expect(allClients.size).toBe(2);
      expect(allClients.has(socket1.id)).toBe(true);
      expect(allClients.has(mockSocket.id)).toBe(true);
    });
  });

  describe('conversation thread persistence', () => {
    it('should preserve messages across multiple interactions', () => {
      const threadId = 'persistent-thread';
      gateway['conversationThreads'].set(threadId, {
        threadId,
        personId: 'Person_Jim',
        messages: [],
        topics: [],
        startedAt: new Date(),
        lastMessageAt: new Date(),
      });

      // Simulate two back-and-forth exchanges
      const guardianMsg1: ConversationMessage = {
        speaker: 'guardian',
        content: 'First question',
        timestamp: new Date(),
      };

      const sylphieMsg1: ConversationMessage = {
        speaker: 'sylphie',
        content: 'First response',
        timestamp: new Date(),
      };

      gateway['conversationThreads'].set(threadId, {
        ...gateway.getThread(threadId)!,
        messages: [guardianMsg1, sylphieMsg1],
      });

      const thread = gateway.getThread(threadId);
      expect(thread?.messages.length).toBe(2);
      expect(thread?.messages[0].speaker).toBe('guardian');
      expect(thread?.messages[1].speaker).toBe('sylphie');
    });

    it('should maintain thread even after all participants disconnect', () => {
      const socket1 = new MockSocket();
      gateway.handleConnection(socket1 as any);
      const threadId = (socket1.emitted.find((e) => e.event === 'connection_status')?.payload as any)?.threadId;

      // Add a message to the thread
      const thread = gateway.getThread(threadId)!;
      gateway['conversationThreads'].set(threadId, {
        ...thread,
        messages: [
          {
            speaker: 'guardian',
            content: 'Important message',
            timestamp: new Date(),
          },
        ],
      });

      gateway.handleDisconnect(socket1 as any);

      // Thread should still exist for resume
      expect(gateway.getThread(threadId)).toBeDefined();
      expect(gateway.getThread(threadId)?.messages.length).toBe(1);
    });
  });
});
