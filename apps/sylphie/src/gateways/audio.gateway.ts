import {
  WebSocketGateway,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { WebSocket } from 'ws';
import { TickSamplerService } from '@sylphie/decision-making';
import { verboseFor } from '@sylphie/shared';
import { SttService, TranscriptResult } from '../services/stt.service';

const vlog = verboseFor('Voice');

let nextClientId = 1;

interface ClientState {
  ws: WebSocket;
  mimeType: string | null;
  totalBytes: number;
  chunkCount: number;
  interimBuffer: string;
}

/**
 * Audio gateway — receives a continuous stream of Opus/WebM audio chunks
 * from the frontend microphone, feeds them into the sensory pipeline,
 * and forwards them to Deepgram for real-time speech-to-text.
 *
 * All audio chunks are forwarded to Deepgram continuously to keep the
 * WebM container stream intact. Deepgram's built-in VAD handles silence.
 * A KeepAlive timer (in SttService) prevents idle disconnects.
 *
 * Client → Server:
 *   { type: 'audio_config', mimeType: 'audio/webm;codecs=opus' }
 *   <binary audio chunks>
 *
 * Server → Client:
 *   { type: 'transcription', text, is_final, confidence, speech_final }
 *   { type: 'utterance_complete', text }
 */
@WebSocketGateway({ path: '/ws/audio' })
export class AudioGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(AudioGateway.name);

  private clients = new Map<string, ClientState>();
  private clientIds = new Map<WebSocket, string>();

  constructor(
    private readonly tickSampler: TickSamplerService,
    private readonly stt: SttService,
  ) {}

  handleConnection(client: WebSocket) {
    const clientId = `audio-${nextClientId++}`;
    this.logger.log(`Audio client connected (${clientId})`);
    vlog('audio client connected', { clientId, totalClients: this.clients.size + 1 });

    this.clients.set(clientId, {
      ws: client,
      mimeType: null,
      totalBytes: 0,
      chunkCount: 0,
      interimBuffer: '',
    });
    this.clientIds.set(client, clientId);

    // Create the Deepgram session immediately. The first chunks from
    // MediaRecorder contain the WebM header that Deepgram needs.
    this.stt.createSession(
      clientId,
      (result: TranscriptResult) => this.handleTranscript(clientId, result),
      (code: number) => this.handleDeepgramClose(clientId, code),
    );

    client.on('message', (data: Buffer | string) =>
      this.handleMessage(clientId, data),
    );
  }

  handleDisconnect(client: WebSocket) {
    const clientId = this.clientIds.get(client);
    if (!clientId) return;

    const state = this.clients.get(clientId);
    this.logger.log(
      `Audio client disconnected ${clientId} (${state?.chunkCount ?? 0} chunks, ${((state?.totalBytes ?? 0) / 1024).toFixed(1)} KB)`,
    );
    vlog('audio client disconnected', {
      clientId,
      chunkCount: state?.chunkCount ?? 0,
      totalKB: parseFloat(((state?.totalBytes ?? 0) / 1024).toFixed(1)),
    });

    this.stt.closeSession(clientId);
    this.clients.delete(clientId);
    this.clientIds.delete(client);
  }

  // ---------------------------------------------------------------------------
  // Transcript handling
  // ---------------------------------------------------------------------------

  private handleTranscript(
    clientId: string,
    result: TranscriptResult,
  ): void {
    const state = this.clients.get(clientId);
    if (!state) return;

    this.logger.debug(
      `STT [${clientId}]: "${result.text}" (final=${result.isFinal}, speech_final=${result.speechFinal}, conf=${result.confidence.toFixed(2)})`,
    );

    // Send every interim/final result back to the client for live display
    const payload = JSON.stringify({
      type: 'transcription',
      text: result.text,
      is_final: result.isFinal,
      confidence: result.confidence,
      speech_final: result.speechFinal,
    });

    if (state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(payload);
    }

    // Accumulate is_final fragments into a full utterance
    if (result.isFinal) {
      state.interimBuffer +=
        (state.interimBuffer ? ' ' : '') + result.text;
    }

    // speech_final = Deepgram detected end of utterance (pause after speech)
    if (result.speechFinal && state.interimBuffer) {
      const fullText = state.interimBuffer.trim();
      state.interimBuffer = '';

      if (fullText) {
        this.logger.log(`STT complete utterance: "${fullText}"`);
        vlog('utterance complete', { clientId, text: fullText });

        // Send the complete accumulated utterance to the client.
        // The frontend relays this to ConversationGateway via the
        // sylphie:voice_text event, which handles parseInput(),
        // tickSampler updates, and event logging in one place.
        if (state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({
            type: 'utterance_complete',
            text: fullText,
          }));
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Deepgram reconnection
  // ---------------------------------------------------------------------------

  private handleDeepgramClose(clientId: string, code: number): void {
    const state = this.clients.get(clientId);
    if (!state) return;

    // code 1006 = abnormal closure (e.g. 400 rejected) — don't reconnect
    // immediately to avoid a tight loop. Only auto-reconnect on clean closes.
    if (code !== 1000) {
      this.logger.error(
        `Deepgram closed for ${clientId} with error code=${code} — not reconnecting`,
      );
      return;
    }

    this.logger.warn(
      `Deepgram closed for ${clientId} (code=${code}) — requesting frontend audio restart`,
    );

    // Tell the frontend to restart MediaRecorder so the next Deepgram
    // session gets a fresh WebM header it can decode.
    if (state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'restart_audio' }));
    }

    // Open a new Deepgram session immediately. The frontend will restart
    // MediaRecorder and send a fresh WebM header as its first chunks.
    this.stt.createSession(
      clientId,
      (result: TranscriptResult) => this.handleTranscript(clientId, result),
      (c: number) => this.handleDeepgramClose(clientId, c),
    );
  }

  // ---------------------------------------------------------------------------
  // Audio chunk handling
  // ---------------------------------------------------------------------------

  private handleMessage(clientId: string, data: Buffer | string): void {
    const state = this.clients.get(clientId);
    if (!state) return;

    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);

    // Detect JSON config messages.
    if (raw.length < 256) {
      try {
        const msg = JSON.parse(raw.toString('utf-8'));
        if (msg.type === 'audio_config' && msg.mimeType) {
          state.mimeType = msg.mimeType;
          this.logger.log(`Audio config (${clientId}): ${state.mimeType}`);
          return;
        }
      } catch {
        // Not JSON
      }
    }

    state.chunkCount++;
    state.totalBytes += raw.length;

    // Always feed the sensory pipeline
    this.tickSampler.updateAudio({
      data: raw,
      mimeType: state.mimeType ?? 'audio/webm',
      chunkIndex: state.chunkCount,
      byteLength: raw.length,
    });

    // Forward all audio to Deepgram. The WebM container stream must stay
    // intact — skipping chunks breaks the container and Deepgram can't
    // decode on reconnect. Deepgram's own VAD handles silence.
    this.stt.sendAudio(clientId, raw);

    if (state.chunkCount % 20 === 0) {
      this.logger.log(
        `Audio ${clientId}: ${state.chunkCount} chunks, ${(state.totalBytes / 1024).toFixed(1)} KB (${state.mimeType})`,
      );
      vlog('audio chunks received', {
        clientId,
        chunkCount: state.chunkCount,
        totalKB: parseFloat((state.totalBytes / 1024).toFixed(1)),
        mimeType: state.mimeType,
      });
    }
  }
}
