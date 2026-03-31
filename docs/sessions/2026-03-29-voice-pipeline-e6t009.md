# 2026-03-29 -- Implement Voice Pipeline (E6-T009)

## Changes

- NEW: `src/communication/voice/voice.errors.ts` -- Custom error classes for graceful degradation
  - STTDegradationError: Thrown when Whisper API fails (never blocks)
  - TTSDegradationError: Thrown when TTS API fails (never blocks)

- MODIFIED: `src/communication/voice/stt.service.ts` -- Full STT implementation
  - OpenAI Whisper API integration with word-level timestamps
  - Confidence estimation from audio duration and transcription quality
  - Graceful error handling (STTDegradationError, never blocks)
  - Temporary file cleanup on success and failure

- MODIFIED: `src/communication/voice/tts.service.ts` -- Full TTS implementation
  - OpenAI TTS API with configurable voice (nova default), format (mp3 default), speed (1.0 default)
  - Pre-computed acknowledgment cache ("I see", "Hmm", "Okay", etc.) for fast delivery
  - Duration estimation for pacing and latency accounting
  - Graceful error handling (TTSDegradationError, never blocks)

- MODIFIED: `src/shared/config/app.config.ts` -- Added OpenAI voice configuration
  - New OpenAiVoiceConfig interface with apiKey, defaultVoice, defaultFormat, defaultSpeed
  - Integration with registerAs('app') factory pattern
  - Environment variable bindings: OPENAI_API_KEY, OPENAI_TTS_DEFAULT_VOICE, etc.

- NEW: `src/communication/voice/stt.service.spec.ts` -- 10 test cases
  - Successful transcription, empty audio, long audio, API failures
  - Configuration validation, temporary file cleanup
  - Sequential calls, language detection

- NEW: `src/communication/voice/tts.service.spec.ts` -- 18 test cases
  - Successful synthesis, custom options (voice, speed, format)
  - Acknowledgment cache hits/misses, duration estimation
  - Invalid voices/speeds, empty text, API failures
  - All valid OpenAI voices, all audio formats

## Wiring Changes

- SttService (STT_SERVICE token) provides ISttService
- TtsService (TTS_SERVICE token) provides ITtsService
- Both services injected into CommunicationService via DI
- ConfigService provides OpenAiVoiceConfig at 'app.openaiVoice'
- Event logging: Voice failures logged but never emitted as events (graceful degradation)

## Known Issues

- None. All 28 voice tests passing.
- Pre-existing type errors in knowledge module unrelated to this work.

## Gotchas for Next Session

- Temporary files are created in /tmp during STT (writeFileSync then createReadStream)
- OpenAI SDK requires buffer-to-file conversion for Whisper API
- TTS acknowledgment pre-computation runs async at init; failures are logged non-fatally
- Speed range strictly [0.25, 4.0]; validation happens before API call
- Voice failures throw specific error types (STT/TTS Degradation) for caller's graceful handling
- Confidence estimation in STT is conservative: 0.80 base, reduced for empty or long audio
- Duration estimates cap at 2 minutes (120000ms) to prevent infinity in pacing

## Testing Notes

- All STT tests pass (10/10)
- All TTS tests pass (18/18)
- Voice service tests isolated with proper mocks for OpenAI SDK and fs module
- Integration tests verify sequential calls and all valid option combinations
- Error handling tests ensure graceful degradation without blocking
