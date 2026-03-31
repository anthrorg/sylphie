/**
 * CameraController — MJPEG streaming endpoint for the Sylphie dashboard.
 *
 * Exposes GET /api/camera/stream which returns a multipart/x-mixed-replace
 * stream of JPEG frames captured via an ffmpeg child process. When the camera
 * or ffmpeg is unavailable the endpoint degrades gracefully to a placeholder
 * 1x1 gray JPEG — it never returns an error response.
 *
 * Platform detection:
 *   win32  — dshow input:        -f dshow -i video="<deviceId>"
 *   linux  — v4l2 input:         -f v4l2 -i <deviceId or /dev/video0>
 *   darwin — avfoundation input:  -f avfoundation -i <deviceId or 0>
 *
 * Process lifecycle:
 *   - One ffmpeg child process per connected client.
 *   - Killed immediately when the HTTP response closes (client disconnect).
 *   - All active processes are tracked and killed on module destroy.
 *
 * MJPEG frame format (RFC 2046 multipart):
 *   --frame\r\n
 *   Content-Type: image/jpeg\r\n
 *   Content-Length: <bytes>\r\n
 *   \r\n
 *   <jpeg bytes>\r\n
 *
 * ffmpeg with -f image2pipe -vcodec mjpeg writes concatenated raw JPEG frames
 * to stdout. Each frame starts with SOI (0xFF 0xD8) and ends with EOI (0xFF 0xD9).
 * JpegFrameExtractor buffers stdout and emits complete frames.
 *
 * CANON §Communication: Media features are optional and must degrade gracefully.
 * Audio/video failures never block the system.
 */

import {
  Controller,
  Get,
  Query,
  Res,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { spawn, type ChildProcess } from 'child_process';
import type { AppConfig } from '../../shared/config/app.config';

// ---------------------------------------------------------------------------
// Placeholder JPEG
//
// A minimal valid 1x1 mid-gray JPEG (JFIF, baseline DCT, 8-bit, 1 component).
// Generated offline and embedded as a hex string to avoid runtime dependencies
// on image generation libraries.
// ---------------------------------------------------------------------------

const PLACEHOLDER_JPEG_HEX =
  'ffd8ffe000104a46494600010100000100010000' +
  'ffdb004300' +
  '10111012141312141514161618181616181a1a1a' +
  '1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a' +
  '1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a' +
  'ffc0000b080001000101011100' +
  'ffc4001f0000010501010101010100000000000000000102030405060708090a0b' +
  'ffda00080101003f00f28a28a28a28a28a28a28028a28a28a28a28a28a28a2800' +
  'ffd9';

const PLACEHOLDER_JPEG = Buffer.from(PLACEHOLDER_JPEG_HEX, 'hex');

// Multipart boundary string.
const BOUNDARY = 'frame';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the ffmpeg argument array for the current platform.
 */
function buildFfmpegArgs(deviceId: string, fps: number): string[] {
  const outputArgs = [
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-r', String(fps),
    '-q:v', '5',
    '-',
  ];

  switch (process.platform) {
    case 'win32':
      return ['-f', 'dshow', '-i', `video=${deviceId}`, ...outputArgs];
    case 'darwin':
      return ['-f', 'avfoundation', '-i', deviceId, ...outputArgs];
    default:
      return ['-f', 'v4l2', '-i', deviceId, ...outputArgs];
  }
}

/**
 * Platform-appropriate default device ID when CAMERA_DEVICE_ID is not set.
 */
function defaultDeviceId(): string {
  switch (process.platform) {
    case 'win32':  return 'Integrated Camera';
    case 'darwin': return '0';
    default:       return '/dev/video0';
  }
}

// ---------------------------------------------------------------------------
// JpegFrameExtractor
//
// ffmpeg -f image2pipe -vcodec mjpeg writes a raw stream of concatenated JPEG
// images. This class buffers incoming stdout chunks and emits complete frames.
// ---------------------------------------------------------------------------

class JpegFrameExtractor {
  private buffer: Buffer = Buffer.alloc(0);

  /**
   * Feed a new chunk of bytes. Returns all complete JPEG frames found.
   */
  push(chunk: Buffer): Buffer[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: Buffer[] = [];

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const soiIdx = this.indexOf2(this.buffer, 0xff, 0xd8, 0);
      if (soiIdx === -1) {
        this.buffer = Buffer.alloc(0);
        break;
      }
      if (soiIdx > 0) {
        this.buffer = this.buffer.subarray(soiIdx);
      }

      const eoiIdx = this.indexOf2(this.buffer, 0xff, 0xd9, 2);
      if (eoiIdx === -1) {
        break; // Incomplete frame — wait for more data
      }

      const frameEnd = eoiIdx + 2;
      frames.push(this.buffer.subarray(0, frameEnd));
      this.buffer = this.buffer.subarray(frameEnd);
    }

    return frames;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }

  private indexOf2(buf: Buffer, b0: number, b1: number, from: number): number {
    for (let i = from; i < buf.length - 1; i++) {
      if (buf[i] === b0 && buf[i + 1] === b1) return i;
    }
    return -1;
  }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

@Controller('api/camera')
export class CameraController implements OnModuleDestroy {
  private readonly logger = new Logger(CameraController.name);

  /** Every active ffmpeg child process, tracked for cleanup. */
  private readonly activeProcesses = new Set<ChildProcess>();

  constructor(private readonly configService: ConfigService) {}

  /**
   * GET /api/camera/stream
   *
   * Streams MJPEG frames from the webcam to the HTTP client.
   *
   * Query params:
   *   source    — 'webcam' (default). Accepted; only webcam supported in Phase 1.
   *   annotated — '0' or '1'. Accepted but ignored in Phase 1.
   *
   * On success: streams JPEG frames until the client disconnects.
   * On failure: writes one placeholder frame and closes the stream.
   *
   * Always HTTP 200, Content-Type: multipart/x-mixed-replace; boundary=frame.
   */
  @Get('stream')
  stream(
    @Query('source') _source?: string,
    @Query('annotated') _annotated?: string,
    @Res() res?: Response,
  ): void {
    if (!res) return;

    const appConfig = this.configService.get<AppConfig>('app');
    const fps = appConfig?.media?.cameraFps ?? 15;
    const deviceId = appConfig?.media?.cameraDeviceId ?? defaultDeviceId();

    res.setHeader('Content-Type', `multipart/x-mixed-replace; boundary=${BOUNDARY}`);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.status(200);

    const writeFrame = (jpeg: Buffer): boolean => {
      if (res!.writableEnded) return false;
      const header =
        `--${BOUNDARY}\r\n` +
        `Content-Type: image/jpeg\r\n` +
        `Content-Length: ${jpeg.length}\r\n` +
        `\r\n`;
      res!.write(Buffer.from(header, 'ascii'));
      res!.write(jpeg);
      res!.write(Buffer.from('\r\n', 'ascii'));
      return true;
    };

    const degradeToPlaceholder = (): void => {
      if (res!.writableEnded) return;
      try {
        writeFrame(PLACEHOLDER_JPEG);
        if (!res!.writableEnded) {
          res!.write(Buffer.from(`--${BOUNDARY}--\r\n`, 'ascii'));
          res!.end();
        }
      } catch {
        // Response closed mid-write — ignore.
      }
    };

    const args = buildFfmpegArgs(deviceId, fps);
    this.logger.debug(`Starting camera stream: ffmpeg ${args.join(' ')}`);

    let ffmpegProc: ChildProcess;

    try {
      ffmpegProc = spawn('ffmpeg', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (spawnError) {
      this.logger.warn(
        `CameraController: spawn failed — ${(spawnError as Error).message}. ` +
        'Falling back to placeholder JPEG.',
      );
      degradeToPlaceholder();
      return;
    }

    this.activeProcesses.add(ffmpegProc);

    const extractor = new JpegFrameExtractor();
    let hasDegraded = false;

    ffmpegProc.stdout!.on('data', (chunk: Buffer) => {
      if (res!.writableEnded || hasDegraded) return;
      const frames = extractor.push(chunk);
      for (const frame of frames) {
        if (!writeFrame(frame)) break;
      }
    });

    ffmpegProc.stderr!.on('data', (chunk: Buffer) => {
      this.logger.debug(`[ffmpeg] ${chunk.toString().trim()}`);
    });

    ffmpegProc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      this.activeProcesses.delete(ffmpegProc);
      extractor.reset();
      if (res!.writableEnded) return;
      if (!hasDegraded) {
        hasDegraded = true;
        const reason = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
        this.logger.warn(`CameraController: ffmpeg stopped (${reason}). Sending placeholder.`);
        degradeToPlaceholder();
      }
    });

    ffmpegProc.on('error', (err: NodeJS.ErrnoException) => {
      this.activeProcesses.delete(ffmpegProc);
      extractor.reset();
      if (res!.writableEnded) return;
      if (!hasDegraded) {
        hasDegraded = true;
        if (err.code === 'ENOENT') {
          this.logger.warn(
            'CameraController: ffmpeg binary not found (ENOENT). ' +
            'Install ffmpeg and ensure it is on PATH. Sending placeholder.',
          );
        } else {
          this.logger.warn(
            `CameraController: ffmpeg error (${err.message}). Sending placeholder.`,
          );
        }
        degradeToPlaceholder();
      }
    });

    res.on('close', () => {
      if (!ffmpegProc.killed) {
        try { ffmpegProc.kill('SIGTERM'); } catch { /* already dead */ }
        setTimeout(() => {
          if (!ffmpegProc.killed) {
            try { ffmpegProc.kill('SIGKILL'); } catch { /* already dead */ }
          }
        }, 500);
      }
      this.activeProcesses.delete(ffmpegProc);
    });
  }

  /**
   * Kill all active ffmpeg processes when the NestJS module is destroyed.
   *
   * Prevents orphaned camera-holding processes after hot-reload or SIGTERM.
   */
  onModuleDestroy(): void {
    let killed = 0;
    for (const proc of this.activeProcesses) {
      if (!proc.killed) {
        try { proc.kill('SIGTERM'); } catch { /* already dead */ }
        killed++;
      }
    }
    this.activeProcesses.clear();
    if (killed > 0) {
      this.logger.log(
        `CameraController: terminated ${killed} ffmpeg process(es) on module destroy.`,
      );
    }
  }
}
