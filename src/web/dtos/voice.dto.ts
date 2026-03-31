/**
 * Voice I/O DTOs for speech-to-text and text-to-speech.
 *
 * CANON §Communication: These DTOs serialize results from the
 * STT (OpenAI Whisper) and TTS (OpenAI TTS) services for HTTP
 * and WebSocket delivery.
 */

// ---------------------------------------------------------------------------
// Speech-to-Text Response
// ---------------------------------------------------------------------------

/**
 * VoiceTranscriptionResponse — result of voice-to-text transcription.
 *
 * Returned by POST /api/voice/transcribe endpoint.
 * Wraps the result of OpenAI Whisper API call for HTTP delivery.
 */
export interface VoiceTranscriptionResponse {
  /** Transcribed text from the audio buffer. */
  readonly text: string;

  /**
   * Whisper confidence score in [0.0, 1.0].
   * Below 0.70: treat text as uncertain; flag for review.
   */
  readonly confidence: number;

  /** Latency in milliseconds for the STT API call. */
  readonly latencyMs: number;
}

// ---------------------------------------------------------------------------
// Text-to-Speech Response
// ---------------------------------------------------------------------------

/**
 * VoiceSynthesisResponse — result of text-to-speech synthesis.
 *
 * Returned by POST /api/voice/synthesize endpoint.
 * Wraps the result of OpenAI TTS API call for HTTP delivery.
 */
export interface VoiceSynthesisResponse {
  /** Raw audio buffer in the requested format (typically MP3). */
  readonly audioBuffer: Buffer;

  /** Approximate playback duration in milliseconds. */
  readonly durationMs: number;

  /** Audio format string (e.g., 'mp3', 'opus', 'aac', 'flac'). */
  readonly format: string;
}
