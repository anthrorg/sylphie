/** Minimal mock RTCPeerConnection for leak/staleness-guard unit tests (TK-146). */
export class MockRTCPeerConnection {
  static instances: MockRTCPeerConnection[] = []

  closed = false
  connectionState: RTCPeerConnectionState = 'new'
  iceConnectionState: RTCIceConnectionState = 'new'
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null
  ontrack: ((event: RTCTrackEvent) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  oniceconnectionstatechange: (() => void) | null = null

  constructor() {
    MockRTCPeerConnection.instances.push(this)
  }

  addTrack(): void {
    /* no-op */
  }

  close(): void {
    this.closed = true
    this.connectionState = 'closed'
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'mock-sdp' }
  }

  async setLocalDescription(): Promise<void> {
    /* no-op */
  }

  static reset(): void {
    MockRTCPeerConnection.instances = []
  }
}
