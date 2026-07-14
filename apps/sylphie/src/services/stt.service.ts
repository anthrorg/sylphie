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

export interface OneShot {
  text: string;
  confidence: number;
  latencyMs: number;
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
  /**
   * TK-113 — per-clientId generation counter. Incremented every time a new
   * session is created for a clientId; the OLD session's close handler
   * captures its own generation at creation time and compares it against the
   * current value before touching any of the three maps above, so a stale
   * close event (reconnect churn — a new session already replaced this one
   * before the old socket's close event fires) cannot clobber the
   * replacement session's entries.
   */
  private readonly generations = new Map<string, number>();

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

    // TK-113: bump this clientId's generation. The close handler below
    // captures `generation` (this value) in its closure and checks it
    // against the live map entry before deleting anything.
    const generation = (this.generations.get(clientId) ?? 0) + 1;
    this.generations.set(clientId, generation);

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

      // TK-113: if a newer session has already been created for this
      // clientId (reconnect churn — createSession() bumped the generation
      // before this stale close event fired), do NOT touch any of the
      // three maps: they now belong to the replacement session.
      if (this.generations.get(clientId) !== generation) {
        vlog('STT stale close handler suppressed — session superseded', {
          clientId,
          staleGeneration: generation,
          currentGeneration: this.generations.get(clientId),
        });
        onClose?.(code, reasonStr);
        return;
      }

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

  /**
   * One-shot transcription via Deepgram REST (pre-recorded audio).
   * Used by POST /voice/transcribe — sends the full audio buffer once,
   * waits for a single transcript response, and returns.
   *
   * Throws on network failure or a non-2xx Deepgram response so callers
   * can surface an honest error rather than a fake empty-200.
   */
  async transcribeBuffer(audio: Buffer, mimeType: string): Promise<OneShot> {
    if (!this.available) {
      throw new Error('STT unavailable — DEEPGRAM_API_KEY not set');
    }

    const params = new URLSearchParams({
      model: 'nova-2',
      language: 'en-US',
      smart_format: 'true',
    });

    const t0 = Date.now();
    vlog('STT REST transcribe start', { bytes: audio.length, mimeType });

    const response = await fetch(
      `https://api.deepgram.com/v1/listen?${params.toString()}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${this.apiKey}`,
          'Content-Type': mimeType,
        },
        // Deepgram expects raw bytes. Convert to ArrayBuffer (BodyInit-compatible)
        // via a copy so the slice is a plain ArrayBuffer, not SharedArrayBuffer.
        body: new Uint8Array(audio).buffer as ArrayBuffer,
      },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.error(`Deepgram REST error ${response.status}: ${body.slice(0, 200)}`);
      throw new Error(`Deepgram REST error ${response.status}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (await response.json()) as any;
    const alt = data?.results?.channels?.[0]?.alternatives?.[0];
    const text: string = alt?.transcript ?? '';
    const confidence: number = alt?.confidence ?? 0;
    const latencyMs = Date.now() - t0;

    vlog('STT REST transcribe done', { text, confidence, latencyMs });
    return { text, confidence, latencyMs };
  }

  onModuleDestroy() {
    for (const [id] of this.sessions) {
      this.closeSession(id);
    }
  }
}
