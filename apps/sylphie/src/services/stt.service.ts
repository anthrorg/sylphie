import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import WebSocket from 'ws';
import { verboseFor } from '@sylphie/shared';

const vlog = verboseFor('Voice');

export interface TranscriptResult {
  text: string;
  isFinal: boolean;
  confidence: number;
  speechFinal: boolean;
}

/**
 * Manages Deepgram live transcription sessions using the WebSocket API directly.
 *
 * Each audio-streaming client gets exactly one Deepgram session for its
 * entire lifetime. The session receives the WebM header from the first
 * MediaRecorder chunks and stays alive via KeepAlive messages.
 */
@Injectable()
export class SttService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SttService.name);
  private apiKey = '';
  private readonly sessions = new Map<string, WebSocket>();
  private readonly keepAliveTimers = new Map<string, NodeJS.Timeout>();
  /** Buffers audio chunks that arrive before Deepgram WS is open */
  private readonly pendingBuffers = new Map<string, Buffer[]>();

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.apiKey = this.config.get<string>('voice.deepgramApiKey') ?? '';
    this.logger.log(
      `STT init: key=${this.apiKey ? `set (${this.apiKey.length} chars)` : 'MISSING'}`,
    );
  }

  get available(): boolean {
    return !!this.apiKey;
  }

  /**
   * Open a live Deepgram session for a given client ID.
   * A KeepAlive timer prevents Deepgram from closing during silence.
   */
  createSession(
    clientId: string,
    onTranscript: (result: TranscriptResult) => void,
    onClose?: (code: number, reason: string) => void,
  ): void {
    if (this.sessions.has(clientId)) {
      this.closeSession(clientId);
    }

    if (!this.available) {
      this.logger.warn('STT unavailable — skipping session creation');
      vlog('STT session skipped — no API key', { clientId });
      return;
    }

    vlog('STT session starting', { clientId });

    // Start buffering audio chunks that arrive before the WS is open
    this.pendingBuffers.set(clientId, []);

    const params = new URLSearchParams({
      model: 'nova-2',
      language: 'en-US',
      smart_format: 'true',
      interim_results: 'true',
      utterance_end_ms: '1200',
      vad_events: 'true',
      endpointing: '300',
    });

    const ws = new WebSocket(
      `wss://api.deepgram.com/v1/listen?${params.toString()}`,
      { headers: { Authorization: `Token ${this.apiKey}` } },
    );

    ws.on('open', () => {
      this.logger.log(`Deepgram session opened for client ${clientId}`);
      vlog('STT session open', { clientId });

      // Flush any audio chunks that arrived while the WS was connecting.
      // The first chunks contain the WebM header — Deepgram needs it.
      const pending = this.pendingBuffers.get(clientId);
      if (pending && pending.length > 0) {
        this.logger.log(`Flushing ${pending.length} buffered chunks to Deepgram for ${clientId}`);
        for (const chunk of pending) {
          ws.send(chunk);
        }
      }
      this.pendingBuffers.delete(clientId);

      const timer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'KeepAlive' }));
        }
      }, 5000);
      this.keepAliveTimers.set(clientId, timer);
    });

    ws.on('message', (raw: Buffer) => {
      try {
        const data = JSON.parse(raw.toString());

        if (data.type === 'Results') {
          const alt = data.channel?.alternatives?.[0];
          const transcript = alt?.transcript ?? '';
          if (!transcript) return;

          const transcriptResult: TranscriptResult = {
            text: transcript,
            isFinal: !!data.is_final,
            confidence: alt?.confidence ?? 0,
            speechFinal: !!data.speech_final,
          };
          vlog('STT transcription result', {
            clientId,
            text: transcript,
            confidence: transcriptResult.confidence,
            is_final: transcriptResult.isFinal,
            speech_final: transcriptResult.speechFinal,
          });
          onTranscript(transcriptResult);
        } else {
          this.logger.debug(
            `Deepgram msg [${clientId}]: type=${data.type}`,
          );
        }
      } catch {
        // Ignore non-JSON messages
      }
    });

    ws.on('error', (err: Error) => {
      this.logger.error(
        `Deepgram error for client ${clientId}: ${err.message}`,
      );
      vlog('STT session error', { clientId, error: err.message });
    });

    ws.on('close', (code: number, reason: Buffer) => {
      const reasonStr = reason?.toString() || '';
      this.logger.warn(
        `Deepgram session closed for client ${clientId} (code=${code}${reasonStr ? `, reason=${reasonStr}` : ''})`,
      );
      vlog('STT session closed', { clientId, code, reason: reasonStr });
      this.pendingBuffers.delete(clientId);
      const timer = this.keepAliveTimers.get(clientId);
      if (timer) {
        clearInterval(timer);
        this.keepAliveTimers.delete(clientId);
      }
      this.sessions.delete(clientId);
      onClose?.(code, reasonStr);
    });

    this.sessions.set(clientId, ws);
  }

  /** Forward an audio chunk to Deepgram for the given client. */
  sendAudio(clientId: string, chunk: Buffer): void {
    const ws = this.sessions.get(clientId);
    if (!ws) return;

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(chunk);
    } else if (ws.readyState === WebSocket.CONNECTING) {
      // Buffer chunks while Deepgram WS is still connecting.
      // The first chunks contain the WebM header — losing them is fatal.
      const pending = this.pendingBuffers.get(clientId);
      if (pending) {
        pending.push(chunk);
      }
    }
  }

  /** Gracefully close a client's Deepgram session. */
  closeSession(clientId: string): void {
    const timer = this.keepAliveTimers.get(clientId);
    if (timer) {
      clearInterval(timer);
      this.keepAliveTimers.delete(clientId);
    }
    const ws = this.sessions.get(clientId);
    if (ws) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'CloseStream' }));
        }
        ws.close();
      } catch {
        // Already closed
      }
      this.sessions.delete(clientId);
      vlog('STT session stopped', { clientId });
    }
  }

  onModuleDestroy() {
    for (const [id] of this.sessions) {
      this.closeSession(id);
    }
  }
}
