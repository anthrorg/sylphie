/**
 * Minimal mock WebSocket for reconnect/teardown unit tests. Tracks every
 * instance constructed so a test can assert how many sockets were created
 * (e.g. "no NEW socket after unmount" for the TK-141 zombie-socket fix).
 */
export class MockWebSocket {
  static OPEN = 1
  static CLOSED = 3
  static instances: MockWebSocket[] = []

  readyState = MockWebSocket.OPEN
  url: string
  onopen: (() => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  send(): void {
    /* no-op */
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED
  }

  /** Simulate the server closing the connection (fires the real onclose). */
  simulateClose(code = 1006): void {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({ code })
  }

  static reset(): void {
    MockWebSocket.instances = []
  }
}
