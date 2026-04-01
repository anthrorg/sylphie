# 2026-03-31 -- Feature gap fixes + dual-path conversation response

## Changes
- NEW: `src/communication/llm/ollama-llm.service.ts` -- ILlmService via local Ollama with GPU/CPU model routing
- MODIFIED: `src/communication/llm/llm.service.ts` -> `anthropic-llm.service.ts` -- renamed, class renamed to AnthropicLlmService
- NEW: `src/communication/voice/deepgram-stt.service.ts` -- ISttService via Deepgram API (replaces OpenAI Whisper)
- NEW: `src/communication/voice/elevenlabs-tts.service.ts` -- ITtsService via ElevenLabs API (replaces OpenAI TTS)
- MODIFIED: `src/communication/communication.module.ts` -- factory provider for LLM_SERVICE, swapped STT/TTS providers
- MODIFIED: `src/shared/config/app.config.ts` -- added OllamaConfig, DeepgramConfig, ElevenLabsConfig, LlmConfig.provider
- MODIFIED: `src/communication/communication.service.ts` -- all 4 event sites now include learnable content fields
- MODIFIED: `.env.example` -- added OLLAMA, DEEPGRAM, ELEVENLABS vars; LLM_PROVIDER default=ollama

## Wiring Changes
- LLM_SERVICE now uses useFactory selecting OllamaLlmService (default) or AnthropicLlmService
- STT_SERVICE -> DeepgramSttService, TTS_SERVICE -> ElevenLabsTtsService
- Old OpenAI voice services remain as files but are no longer wired

## Dual-Path Conversation Response
- MODIFIED: `src/web/gateways/conversation.gateway.ts` -- Fast path (cheap CPU LLM) gives instant response; slow path (full pipeline) delivers Type 2 follow-up
- MODIFIED: `frontend/src/store/index.ts` -- Added isThinking state + setThinking action
- MODIFIED: `frontend/src/hooks/useWebSocket.ts` -- thinking_indicator handled as flag, not chat message
- MODIFIED: `frontend/src/components/Conversation/ConversationPanel.tsx` -- Animated typing dots indicator replaces "Thinking..." message bubble

## Known Issues
- Old stt.service.ts and tts.service.ts are dead code (kept for reference)
- Deepgram/ElevenLabs services use fetch() directly (no SDK dependency)
- Type 2 follow-up always sent; could add similarity check to suppress when redundant

## Gotchas for Next Session
- Set DEEPGRAM_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID in .env before testing voice
- Ollama must be running locally on port 11434 with models pulled
- Fast path system prompt is hardcoded in conversation.gateway.ts -- should eventually pull from WKG persona context
