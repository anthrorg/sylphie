/**
 * Dependency injection tokens for MediaModule.
 *
 * Consumers inject IWebRtcSignalingService via WEBRTC_SIGNALING_SERVICE rather
 * than depending on the concrete WebRtcSignalingService class, keeping the
 * boundary clean and the implementation swappable for tests.
 */

/** Token for IWebRtcSignalingService — in-memory WebRTC session store. */
export const WEBRTC_SIGNALING_SERVICE = Symbol('WEBRTC_SIGNALING_SERVICE');
