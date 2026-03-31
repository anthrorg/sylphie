/**
 * Custom error classes for voice pipeline (STT/TTS) failures.
 *
 * CANON §Communication: Voice is the preferred channel, not the only channel.
 * Audio failures never block system operation (graceful degradation).
 * These errors are catchable and logged; they do not propagate to the caller.
 */

/**
 * Base class for voice pipeline errors.
 *
 * Used to distinguish voice failures from other Communication subsystem errors.
 * Callers catch these and degrade gracefully.
 */
export class VoiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'VoiceError';
    Object.setPrototypeOf(this, VoiceError.prototype);
  }
}

/**
 * Thrown when STT (speech-to-text) transcription fails.
 *
 * Possible causes:
 * - OpenAI API unavailable or rate-limited
 * - Invalid audio buffer format
 * - Network failure during API call
 * - Missing or invalid API key
 *
 * Callers catch this and use fallback text input or skip STT processing.
 */
export class STTDegradationError extends VoiceError {
  constructor(message: string, public readonly originalError?: Error) {
    super(message, 'STT_DEGRADATION');
    this.name = 'STTDegradationError';
    Object.setPrototypeOf(this, STTDegradationError.prototype);
  }
}

/**
 * Thrown when TTS (text-to-speech) synthesis fails.
 *
 * Possible causes:
 * - OpenAI API unavailable or rate-limited
 * - Text too long for TTS processing
 * - Network failure during API call
 * - Missing or invalid API key
 * - Invalid TTS options (voice, speed, format)
 *
 * Callers catch this and skip audio output, delivering text-only response.
 */
export class TTSDegradationError extends VoiceError {
  constructor(message: string, public readonly originalError?: Error) {
    super(message, 'TTS_DEGRADATION');
    this.name = 'TTSDegradationError';
    Object.setPrototypeOf(this, TTSDegradationError.prototype);
  }
}
