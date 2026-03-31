/**
 * MediaModule public API.
 *
 * External modules that need to inject the signaling service should import
 * from this barrel, not from internal file paths. The injection token and
 * the interface contract are the only public surface.
 */

export { MediaModule } from './media.module';
export { WEBRTC_SIGNALING_SERVICE } from './media.tokens';
export type {
  SignalType,
  SignalingMessage,
  IWebRtcSignalingService,
} from './interfaces/media.interfaces';
