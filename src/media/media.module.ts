/**
 * MediaModule — WebRTC signaling gateway and camera/media configuration.
 *
 * Provides a WebRTC signaling channel at /ws/media for browser-to-backend
 * media sessions. The module is self-contained: it does not import any
 * subsystem module and carries no provenance or event backbone dependencies.
 * Media sessions are transient and in-memory by design.
 *
 * Providers:
 *   WEBRTC_SIGNALING_SERVICE  — IWebRtcSignalingService. In-memory session
 *                               store with 60s TTL and 30s cleanup timer.
 *   WebRtcSignalingGateway    — WebSocket gateway at /ws/media.
 *
 * Exports:
 *   WEBRTC_SIGNALING_SERVICE  — Read-only facade for any future consumer.
 *
 * Imports:
 *   ConfigModule              — SharedModule registers it globally, so no
 *                               explicit import is required here. ConfigService
 *                               is available automatically.
 *
 * Startup behavior: If media configuration is missing or STUN servers are
 * empty, the module logs a WARNING at initialization but does not throw.
 * Media features are optional — their absence must never crash the application.
 *
 * CANON §Module boundary: MediaModule is the only module allowed to expose
 * the /ws/media endpoint. It does not import from WebModule and WebModule
 * does not import from MediaModule. They are independent surfaces.
 */

import { Module, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebRtcSignalingService } from './webrtc/webrtc-signaling.service';
import { WebRtcSignalingGateway } from './webrtc/webrtc-signaling.gateway';
import { WEBRTC_SIGNALING_SERVICE } from './media.tokens';
import type { AppConfig } from '../shared/config/app.config';

@Module({
  providers: [
    {
      provide: WEBRTC_SIGNALING_SERVICE,
      useClass: WebRtcSignalingService,
    },
    WebRtcSignalingGateway,
  ],
  exports: [WEBRTC_SIGNALING_SERVICE],
})
export class MediaModule implements OnModuleInit {
  private readonly logger = new Logger(MediaModule.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Validate media configuration on module init.
   *
   * Logs a WARNING if STUN servers are empty or the media config section is
   * absent. Does not throw — media features degrade gracefully.
   */
  onModuleInit(): void {
    const appConfig = this.configService.get<AppConfig>('app');
    const mediaConfig = appConfig?.media;

    if (mediaConfig === undefined) {
      this.logger.warn(
        'MediaModule: media configuration section is missing. ' +
          'WebRTC features will use no ICE servers and may fail to establish peer connections. ' +
          'Set MEDIA_STUN_SERVERS in your environment to suppress this warning.',
      );
      return;
    }

    if (mediaConfig.stunServers.length === 0) {
      this.logger.warn(
        'MediaModule: MEDIA_STUN_SERVERS is empty. ' +
          'WebRTC peer connections will have no STUN fallback and may fail on NAT traversal. ' +
          'Set MEDIA_STUN_SERVERS=stun:stun.l.google.com:19302 to suppress this warning.',
      );
    } else {
      this.logger.log(
        `MediaModule initialized. STUN servers: [${mediaConfig.stunServers.join(', ')}]. ` +
          `TURN: ${mediaConfig.turnServer ?? 'none'}. ` +
          `Camera FPS: ${mediaConfig.cameraFps}.`,
      );
    }
  }
}
