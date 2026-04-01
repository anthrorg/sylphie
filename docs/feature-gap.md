# Feature Gap: Sylphie vs Co-Being

Tracks architectural and feature differences between Sylphie's current implementation and the co-being baseline it was ported from.

---

## 1. LLM Provider: Anthropic SDK → Ollama (local inference)

**Current state:** `LlmServiceImpl` is hardcoded to the Anthropic SDK (`@anthropic-ai/sdk`). Requires `ANTHROPIC_API_KEY` in `.env`. Config references Claude model IDs and Claude-specific pricing.

**Co-being baseline:** Used Ollama for all model inference. Local, no API keys, no cost per call.

**Target architecture:**
- The existing `ILlmService` interface (`src/shared/types/llm.types.ts`) is already provider-agnostic (messages, systemPrompt, maxTokens, temperature). Keep it as-is.
- Wrap current Anthropic implementation behind the interface (already done structurally).
- Add `OllamaLlmService` as a new implementation of `ILlmService` that calls Ollama's `/api/chat` HTTP endpoint.
- Provider selection via env var: `LLM_PROVIDER=ollama` (default) or `LLM_PROVIDER=anthropic`.
- **Two Ollama models:**
  - **GPU model (high inference):** Slow but capable. Used for Type 2 deliberation, Learning refinement, Planning constraint validation. Model: `gpt-oss:20b` or similar. Env: `OLLAMA_GPU_MODEL`.
  - **CPU model (fast/lightweight):** Haiku-equivalent. Used for conversation response generation where latency matters. The system learns over time anyway — fast beats smart here. Model: `qwen2.5:7b` via `ollama.cpp`. Env: `OLLAMA_CPU_MODEL`.
- Route selection: callers already pass `metadata.purpose` on every `LlmRequest`. The Ollama service routes to GPU or CPU model based on purpose (e.g., `TYPE_2_DELIBERATION` → GPU, `RESPONSE_GENERATION` → CPU).
- Token counting: Ollama returns `eval_count` and `prompt_eval_count` — map these to the existing `tokensUsed.prompt` / `tokensUsed.completion` fields.
- Cost tracking: local inference has zero dollar cost, but cognitive effort pressure (latency + token count) still applies for Type 1 graduation pressure.

**Files to change:**
- `src/communication/llm/llm.service.ts` — rename to `anthropic-llm.service.ts`, keep as fallback
- `src/communication/llm/ollama-llm.service.ts` — NEW, implements `ILlmService`
- `src/communication/communication.module.ts` — provider factory to select implementation
- `src/shared/config/app.config.ts` — add Ollama config section, keep Anthropic config
- `.env` / `.env.example` — `LLM_PROVIDER`, `OLLAMA_BASE_URL`, `OLLAMA_GPU_MODEL`, `OLLAMA_CPU_MODEL`

---

## 2. STT: OpenAI Whisper → Deepgram

**Current state:** `SttService` uses OpenAI Whisper API via the `openai` npm package. Requires `OPENAI_API_KEY`.

**Co-being baseline:** Used Deepgram for speech-to-text.

**Target:** Replace with Deepgram SDK. Same `ISttService` interface, new implementation.

---

## 3. TTS: OpenAI TTS → ElevenLabs

**Current state:** `TtsService` uses OpenAI TTS API via the `openai` npm package. Requires `OPENAI_API_KEY`.

**Co-being baseline:** Used ElevenLabs for text-to-speech.

**Target:** Replace with ElevenLabs SDK. Same `ITtsService` interface, new implementation.

---

## 4. Events missing content — episodic memory is blind

**Current state:** `CommunicationService` records `INPUT_RECEIVED`, `INPUT_PARSED`, `RESPONSE_DELIVERED` events to TimescaleDB but they carry only metadata (type, timestamp, sessionId, driveSnapshot). The actual text — what the guardian said and what Sylphie responded — is not stored. The `content` field on `LearnableEvent` is never populated.

**What this breaks:** The Learning subsystem's consolidation pipeline queries TimescaleDB for events to learn from, but finds no text content to extract entities from. Episodic memory is structurally present but empty.

**Target:** Every event that involves content (input text, response text, corrections) must include the actual text in its payload. No special grouping or threading needed — TimescaleDB is a time-ordered ledger. Temporal proximity within a query window naturally reveals conversation structure.

**Fix:** When recording events in `CommunicationService.handleGuardianInput()` and `generateResponse()`, include the text content in the event payload. The Learning subsystem already knows how to query by time range and process content.

---

## Status

| Gap | Status | Notes |
|-----|--------|-------|
| 1. LLM Provider (Ollama) | **DONE** | OllamaLlmService + AnthropicLlmService with factory. LLM_PROVIDER env var. GPU/CPU model routing. |
| 2. STT (Deepgram) | **DONE** | DeepgramSttService replaces OpenAI Whisper. Direct buffer upload, per-word confidence. |
| 3. TTS (ElevenLabs) | **DONE** | ElevenLabsTtsService replaces OpenAI TTS. Acknowledgment cache retained. |
| 4. Events content | **DONE** | All four event sites now populate hasLearnable, content, source, salience. |

---

## 5. (Future items — add as discovered)

<!-- Add new gaps here as they surface -->
