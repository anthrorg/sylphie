# Epic 11: Frontend Port & Media Integration -- Vox Communication Engineer Analysis

**Status:** Planning Analysis
**Epic Scope:** Porting co-being React frontend to Sylphie; backend support for STT/TTS audio pipeline, WebRTC signaling, video/camera pipeline, conversation message format alignment, Theater Prohibition display
**Analysis Date:** 2026-03-30
**Analyzer:** Vox (Communication Engineer)

---

## Executive Summary

Epic 11 connects the working backend to a usable frontend. The Communication subsystem (E6) and API layer (E9) are already implemented. STT and TTS services are fully wired to OpenAI -- they are not stubs; they require `OPENAI_API_KEY` to activate. The `VoiceController` (`/api/voice/transcribe`, `/api/voice/synthesize`) and `ConversationGateway` (`/ws/conversation`) are live.

What Epic 11 must add:

1. A React frontend that understands Sylphie's existing WebSocket protocol
2. Audio recording and playback in the browser, using the existing REST voice endpoints
3. An MJPEG camera stream endpoint for Phase 1 webcam display
4. A mapping layer that bridges co-being message types to Sylphie's actual wire format
5. Frontend display of real drive state -- never fabricated emotional indicators

What Epic 11 must NOT do:

- Redesign the backend WebSocket protocol (it works; adapt the frontend to it)
- Introduce WebRTC signaling for Phase 1 (no use case justifies it yet)
- Add video perception or processing (Phase 2; display only in Phase 1)
- Bypass `CommunicationService` for any input or output path

CANON trace: All decisions below trace to CANON §Subsystem 2 (Communication), §Immutable Standards 1 and 6, and the rule "Offload What's Solved, Build What Isn't."

---

## 1. Audio Pipeline Architecture

### 1.1 Current Backend State

Both services are implemented and not stubs:

- `SttService.transcribe(buffer)` -- calls Whisper API, writes temp file, returns `TranscriptionResult`. Throws `STTDegradationError` on failure.
- `TtsService.synthesize(text)` -- calls OpenAI TTS API, has pre-computed acknowledgment cache, returns `SynthesisResult`. Throws `TTSDegradationError` on failure.
- `VoiceController` exposes:
  - `POST /api/voice/transcribe` -- accepts raw audio bytes, returns `{ text, confidence, latencyMs }`
  - `POST /api/voice/synthesize` -- accepts `{ text }`, returns `audio/mpeg` stream or JSON fallback

The `ConversationGateway` handles text over WebSocket but does not currently handle audio blobs on the WebSocket itself.

### 1.2 Recommended Audio Flow: REST, Not WebSocket Binary

**Decision: Frontend records audio, POSTs to `/api/voice/transcribe`, then sends transcription text over WebSocket.**

Rationale:

- The backend's STT pipeline writes a temp file and makes a synchronous Whisper API call. This is inherently request-response, not a stream. Wrapping it in WebSocket binary frames adds complexity with no benefit for Phase 1.
- Latency budget: Whisper API typically returns in 500-1500ms for short utterances. The 2-second response threshold (Vox Rule 11) applies to the full pipeline: STT + LLM + TTS. POST/response is faster than binary WebSocket framing for single-shot audio.
- Graceful degradation: If STT fails, `VoiceController` already returns `{ text: '', confidence: 0 }` without blocking. The frontend falls back to showing a text input. WebSocket binary failure is harder to degrade gracefully.
- The co-being `useVoiceRecording` pattern (record → buffer → send) maps cleanly onto a POST multipart or `application/octet-stream` body.

**Flow:**

```
Browser MediaRecorder → records WAV/WebM chunk
  → POST /api/voice/transcribe (Content-Type: audio/webm or audio/wav)
  → Backend: SttService.transcribe() → { text, confidence, latencyMs }
  → Frontend: receives transcription text
  → Frontend: sends { type: 'message', text } over /ws/conversation WebSocket
  → ConversationGateway routes to CommunicationService
  → Response returned over WebSocket: { type: 'response', text, driveSnapshot }
  → Frontend: displays text; POSTs text to /api/voice/synthesize
  → Backend: TtsService.synthesize() → audio/mpeg stream
  → Frontend: plays audio via HTMLAudioElement
```

**Audio format requirements:**

- Input: The browser records in `audio/webm;codecs=opus` (Chrome) or `audio/ogg;codecs=opus` (Firefox). Whisper accepts both. The backend should NOT require WAV -- just forward whatever the browser records.
- The `SttService` currently hardcodes `.wav` extension for the temp file. This needs a fix: detect format from buffer magic bytes or accept a `Content-Type` header and set the extension accordingly.
- Output: `audio/mpeg` (MP3) from TTS. Browsers play MP3 natively. No transcoding needed.

**The TTS playback loop requires one important addition:** The frontend needs to know WHEN TTS audio is available. Currently `synthesize` is called directly by `CommunicationService.generateResponse()` internally -- the audio is synthesized but the result is not sent anywhere (it is discarded). The audio buffer must be sent to the frontend.

This requires one of two approaches:

- Option A: After `generateResponse()`, the backend POSTs or streams the TTS audio buffer to a known per-session endpoint that the frontend polls or subscribes to.
- Option B: The backend streams TTS audio over the existing WebSocket, appending an `audioUrl` or `audioData` field to the `ConversationOutgoingMessage`.

**Recommended: Option B (WebSocket audio delivery).** Add `audioBase64` (or `audioUrl` pointing to a session-scoped temporary endpoint) to `ConversationOutgoingMessage` when TTS succeeds. The frontend decodes and plays it. On TTS failure, the field is absent and the frontend displays text only. This keeps the pipeline single-channel.

### 1.3 Ticket Implications

- **T-AUDIO-01:** Fix `SttService` temp file extension to match actual audio format (detect from Content-Type or magic bytes).
- **T-AUDIO-02:** Add `audioBase64?: string` field to `ConversationOutgoingMessage` in `websocket.interfaces.ts`. Populate in `ConversationGateway` after `generateResponse()` succeeds.
- **T-AUDIO-03:** Build frontend `useVoiceRecording` hook: MediaRecorder → POST `/api/voice/transcribe` → return transcription text. Gracefully degrade to text input if transcription fails or confidence < 0.5.
- **T-AUDIO-04:** Build frontend audio playback: on `ConversationOutgoingMessage` with `audioBase64`, decode and play via HTMLAudioElement. Mute/unmute toggle in UI.

---

## 2. WebRTC Signaling

### 2.1 Assessment: Do Not Build in Phase 1

The co-being frontend has `useWebRTC.ts`. That pattern exists there for bidirectional audio and camera streaming. For Sylphie Phase 1, neither use case applies:

- **Bidirectional audio via WebRTC**: The STT/TTS REST approach (Section 1) already satisfies the audio requirement with less complexity. Push-to-talk is more appropriate than continuous WebRTC audio for a companion interaction model -- it gives Jim explicit control over when he is speaking, which reduces noise inputs to the conversation pipeline.
- **Webcam via WebRTC**: The MJPEG approach (Section 3) is sufficient for Phase 1 display. WebRTC video is meaningfully better only when the backend needs to process the video stream in real time (object detection, face recognition) -- Phase 2 work.

**Conclusion:** No WebRTC signaling server in Phase 1. The infrastructure cost (NestJS WebRTC signaling, STUN/TURN configuration, ICE negotiation) is not justified by Phase 1 requirements. Add a `// TODO: Phase 2 WebRTC` comment at the relevant connection point.

This is a CANON-aligned decision. CANON §"Offload What's Solved, Build What Isn't" applies to infrastructure scope too. WebRTC is not a solved problem for this use case until there is a concrete Phase 2 requirement driving it.

### 2.2 Phase 2 Pre-Conditions Before Adding WebRTC

Before writing any WebRTC signaling code, these conditions must be true:

1. The robot chassis camera is physically available and the backend needs to process its stream.
2. Continuous audio input (rather than push-to-talk) provides a meaningful improvement to conversation quality.
3. Latency profiling shows the REST STT approach is a bottleneck (measured, not assumed).

Until then: MJPEG for video display, REST for audio, WebSocket for messages.

---

## 3. Video and Camera Pipeline

### 3.1 Phase 1: Webcam Display Only

Phase 1 has one webcam source: the machine running Sylphie. The purpose is face-to-face interaction display -- Jim sees himself (or Sylphie's view of him) in the UI. Sylphie does not process the video in Phase 1; it is a display feature only.

**Recommended: MJPEG stream over HTTP.**

MJPEG is a sequence of JPEG frames wrapped in `multipart/x-mixed-replace`. Every browser supports it natively via `<img src="/api/camera/stream">`. No JavaScript media pipeline is needed.

**Backend implementation:**

```
GET /api/camera/stream
  Content-Type: multipart/x-mixed-replace; boundary=frame

Backend: opens webcam via platform-appropriate method, encodes frames as JPEG,
         emits each as a multipart segment at configurable FPS (default 15fps)
```

This endpoint is a new `CameraController` in `src/web/controllers/`. It is infrastructure, not Communication subsystem logic -- it goes in the Web module, not Communication.

**MJPEG vs co-being `/api/debug/camera/stream?annotated=1`:**

The co-being endpoint adds an `?annotated=1` flag for object detection overlays. In Phase 1, no annotation pipeline exists. The endpoint should exist (for forward compatibility) but the backend simply ignores the `annotated` parameter and returns a plain stream. Do not stub out annotation logic.

**Platform note:** Node.js does not have a built-in webcam API. Options:

- `node-webcam` (wrapper around `fswebcam`/`ffmpeg`) -- works on Linux, fragile on Windows
- `ffmpeg` child process piped into Node -- reliable cross-platform if `ffmpeg` is installed
- A Python sidecar (like the OpenCV perception layer planned for Phase 2) -- architecturally clean but overkill for display-only

**Recommended for Phase 1:** `ffmpeg` child process. It is already planned as a dependency for Phase 2 perception. Establish the dependency now for the simpler display use case. The camera endpoint spawns `ffmpeg -f dshow -i video="..." -f image2pipe -vcodec mjpeg -r 15 -` (Windows) or `-f v4l2` (Linux) and pipes JPEG frames to the HTTP response.

**Graceful degradation:** If `ffmpeg` is not found or the webcam is unavailable, the endpoint returns a static placeholder image (a 1x1 gray JPEG) rather than a 404 or stream error. The frontend should handle a non-streaming response by displaying a "camera unavailable" placeholder.

### 3.2 Phase 2: Robot Chassis Camera

Phase 2 adds a second video source: the chassis camera. The architecture at that point should be:

- Python perception sidecar (OpenCV + YOLO) processes the chassis camera stream
- Processed frames (annotated with detected objects) are pushed to the NestJS backend via an internal HTTP push or IPC
- The existing `/api/camera/stream` endpoint adds a `?source=chassis` parameter

This is out of scope for Epic 11 and should not influence Phase 1 decisions.

### 3.3 Ticket Implications

- **T-VIDEO-01:** Implement `CameraController` at `GET /api/camera/stream` with MJPEG over HTTP. Use `ffmpeg` child process. Ignore `?annotated` parameter in Phase 1. Return placeholder on failure.
- **T-VIDEO-02:** Add camera URL config (`CAMERA_DEVICE_ID`, `CAMERA_FPS`) to `AppConfig`.
- **T-VIDEO-03:** Frontend `CameraPanel` component: `<img>` tag pointing at `/api/camera/stream`. Handles load failure with "camera unavailable" overlay.

---

## 4. Conversation Message Format Mapping

### 4.1 Existing Sylphie Wire Format

The `ConversationGateway` (`/ws/conversation`) currently emits three `type` values:

- `response` -- Sylphie's reply, includes `text`, `driveSnapshot`, optional `theaterCheck`, optional `metadata`
- `drive-update` -- periodic drive state broadcast (from `TelemetryGateway`)
- `system` -- connection status, errors, acknowledgments

The `ConversationIncomingMessage` accepts:

- `{ type: 'message', text }` -- guardian input
- `{ type: 'feedback', feedbackType: 'correction'|'confirmation', targetMessageId }` -- guardian feedback

### 4.2 Co-Being Message Types (From Epic 11 Brief)

The co-being frontend expects message types: `thinking`, `cb_speech`, `guardian`, `transcription`, `error`.

These do not map one-to-one to Sylphie's protocol. The mapping is:

| Co-being type | Sylphie equivalent | Notes |
|---|---|---|
| `thinking` | No direct equivalent | Approximated by `system` with `metadata.isThinking: true` during Type 2 processing |
| `cb_speech` | `response` | Direct map: `type: 'response'` IS Sylphie speaking |
| `guardian` | No wire type (client-local) | The guardian's own messages are client-side state; they are echoed back via `system` ack |
| `transcription` | No wire type | STT result is delivered as the `text` of a `message` event, not a separate wire type |
| `error` | `system` with `metadata.error` | Map to `{ type: 'system', metadata: { error: '...' } }` |

**Decision: Adapt the frontend to Sylphie's existing protocol rather than adding new backend message types.**

Adding `cb_speech`, `thinking`, `guardian`, and `transcription` as new backend types would create dead-code types that carry no additional information over the existing discriminated union. The existing `type: 'response'` carries everything `cb_speech` carries. The typing benefit of `cb_speech` is cosmetic in the co-being codebase.

**What does need adding:** The `thinking` indicator has a legitimate use case. When the backend is processing a Type 2 (LLM) response, the frontend should show a thinking indicator. This maps to the existing `typing_indicator` event in `ChatboxGateway` but is absent from `ConversationGateway`. Add a `metadata.isThinking: boolean` field to `ConversationOutgoingMessage` for the brief window between receiving input and dispatching the response.

**Modified outgoing type mapping for the frontend:**

```typescript
// Frontend adapter (not backend change)
function sylphieToDisplayMessage(msg: ConversationOutgoingMessage): DisplayMessage {
  if (msg.type === 'response') {
    return { role: 'sylphie', text: msg.text, driveSnapshot: msg.driveSnapshot };
  }
  if (msg.type === 'system' && msg.metadata?.isThinking) {
    return { role: 'thinking' };
  }
  if (msg.type === 'system' && msg.metadata?.error) {
    return { role: 'error', text: msg.metadata.error };
  }
  if (msg.type === 'drive-update') {
    return { role: 'drive-update', driveSnapshot: msg.driveSnapshot };
  }
  return null; // Ignore other system messages
}
```

This adapter lives entirely in the frontend. The backend protocol is not changed.

### 4.3 Ticket Implications

- **T-MSG-01:** Backend: add `metadata.isThinking: boolean` emission to `ConversationGateway` before routing input to `CommunicationService`. Clear it after response is sent.
- **T-MSG-02:** Frontend: implement `sylphieToDisplayMessage()` adapter. Do not hardcode co-being type strings on the WebSocket layer.
- **T-MSG-03:** Frontend: implement guardian-side message display (client-local state only, not a round-tripped wire type).
- **T-MSG-04:** Frontend: wire STT transcription display inline as pending text (before the final `message` is sent over WebSocket).

---

## 5. Theater Prohibition in the Frontend

### 5.1 CANON Requirement

CANON §Immutable Standard 1 is constitutional. It applies to the frontend as much as the backend. Specifically:

- The frontend must display **actual drive state**, not a default or placeholder emotional expression.
- The frontend must NOT fabricate emotional indicators when drive state is unavailable.
- The `theaterCheck` field on `ConversationOutgoingMessage` must be surfaced to the guardian as-is, not translated into a friendlier but misleading display.

The current `ConversationOutgoingMessage` already includes `theaterCheck?: TheaterCheckDto`. The drive snapshot is always included on `response` type frames.

### 5.2 Frontend Display Rules

**Drive display:**

- Show all 12 drives from `driveSnapshot.drives` array.
- Use the actual numeric value from `pressureVector` -- do not map to emoji, color scale, or qualitative label without a documented threshold rule.
- If drive state is unavailable (no snapshot received yet), show "drive state loading" -- not a neutral face, not a happy face.

**Theater Prohibition indicator:**

- When `theaterCheck.isTheater === true`, display a visible indicator: "Sylphie is not expressing this authentically -- the response was generated but its emotional content does not match current drive state." This is informational for Jim as developer/guardian.
- When `theaterCheck.isTheater === false`, no indicator is needed.
- The frontend must NOT hide theater check failures for aesthetic reasons. Jim needs to see them to evaluate system health.

**What the frontend must never do:**

- Animate Sylphie as "happy" when no drive state supports it.
- Display a default emotional state when the WebSocket is not yet connected.
- Suppress theater violations because they look bad in the UI.

### 5.3 Ticket Implications

- **T-THEATER-01:** Frontend `DrivePanel`: display all 12 drives from the live WebSocket `driveSnapshot`. Numeric values with normalized bar indicators. "Loading" state when no snapshot received.
- **T-THEATER-02:** Frontend `TheaterCheckIndicator`: visible component on each Sylphie message that shows theater check result. Hidden when `theaterCheck` is absent; shown (with explanation) when `theaterCheck.isTheater === true`.
- **T-THEATER-03:** Frontend state machine: no default "Sylphie is happy" idle state. Use a neutral/no-expression default until drive state is received.

---

## 6. TTS Pipeline Gap: Audio Not Delivered to Frontend

This is the most significant gap in the current system and must be fixed in Epic 11.

`CommunicationService.generateResponse()` synthesizes TTS audio internally:

```typescript
const synthesisResult = await this.ttsService.synthesize(response.text);
audioBuffer = synthesisResult.audioBuffer;
// audioBuffer is then... not used
```

The audio buffer is computed and discarded. The `ChatboxGateway.broadcastResponse()` sends only text. The `ConversationGateway` sends only text in its `ConversationOutgoingMessage`. There is no path from TTS synthesis result to the browser.

**Fix:** After synthesis, base64-encode the audio buffer and include it in the `ConversationOutgoingMessage`:

```typescript
// In ConversationGateway, after generateResponse():
const audioBase64 = synthesisResult?.audioBuffer
  ? synthesisResult.audioBuffer.toString('base64')
  : undefined;

const response: ConversationOutgoingMessage = {
  type: 'response',
  sessionId,
  text: generatedResponse.text,
  audioBase64,       // new field
  audioFormat: 'mp3', // new field, tells frontend how to decode
  driveSnapshot,
  theaterCheck: ...,
};
```

Alternatively, use a short-lived audio URL: store the audio buffer in memory keyed by a UUID, expose `GET /api/voice/audio/:id`, and include the URL in the message. This avoids large base64 payloads but requires a cleanup mechanism.

**Recommended:** Base64 for Phase 1 (simpler, no state management). Upgrade to URL-based delivery if payload size becomes a problem (responses > ~15 seconds of audio).

- **T-TTS-01:** `ConversationOutgoingMessage` interface: add `audioBase64?: string` and `audioFormat?: string` fields.
- **T-TTS-02:** `ConversationGateway.handleMessage()`: propagate TTS audio from `generateResponse()` into the outgoing WebSocket frame.
- **T-TTS-03:** Frontend: on receiving `audioBase64` in a `response` frame, decode and play via HTMLAudioElement. Ignore silently if absent (text-only fallback).

---

## 7. CANON Compliance Concerns

### 7.1 Drive State Must Always Be Real

Any frontend component that displays Sylphie's emotional state must source it from the live `driveSnapshot` delivered over WebSocket. Three failure modes to watch for:

1. **Placeholder state**: Frontend renders before the first WebSocket `drive-update` or `response` arrives and defaults to a "happy" or "neutral" face. Fix: explicit "connecting" state with no emotional display.
2. **Stale state**: WebSocket disconnects; frontend continues displaying the last-known drive values without a staleness indicator. Fix: add `lastUpdatedAt` timestamp to drive display; show "stale" warning after 5 seconds without an update.
3. **Fabricated state**: Frontend invents drive values (e.g., `curiosity: 0.8`) for a demo or tutorial. This is a Theater Prohibition violation in the UI layer. It is prohibited regardless of aesthetic value.

### 7.2 STT Confidence Gate

The `SttService` returns `confidence` in `[0.0, 1.0]`. The frontend should surface low-confidence transcriptions to the guardian before sending, not silently. If confidence is below 0.5:

- Display the transcription text in a "did you mean...?" form
- Let Jim confirm or retype before the message is sent over WebSocket
- Do not auto-send low-confidence transcriptions

This is consistent with CANON §Guardian Asymmetry: Jim's input is ground truth. A low-confidence transcription that gets auto-sent and triggers a wrong response is a preventable error.

### 7.3 WebRTC Non-Starter in Phase 1

Attempting to implement WebRTC signaling before there is a concrete Phase 2 requirement would violate CANON Rule 1 ("No code without epic-level planning validated against the CANON"). The planning criterion for WebRTC is unmet. Flag it as a deferred decision, not a missing implementation.

### 7.4 Camera Stream Is Display-Only

The MJPEG camera stream must not be connected to any processing pipeline in Phase 1. It is observable but not learnable. If YOLO or any detection library is included in Phase 1 to support the camera endpoint, that is scope creep into Phase 2. The endpoint returns raw JPEG frames.

---

## 8. Ticket Summary and Estimated Count

### Audio Pipeline (4 tickets)
| Ticket | Title | Estimate |
|---|---|---|
| T-AUDIO-01 | Fix `SttService` temp file extension for WebM/OGG input | S |
| T-AUDIO-02 | Add `audioBase64`/`audioFormat` to `ConversationOutgoingMessage` | S |
| T-AUDIO-03 | Frontend `useVoiceRecording` hook (MediaRecorder → POST → transcription) | M |
| T-AUDIO-04 | Frontend audio playback (decode `audioBase64` → HTMLAudioElement) | S |

### TTS Delivery Gap (3 tickets)
| Ticket | Title | Estimate |
|---|---|---|
| T-TTS-01 | `ConversationOutgoingMessage` interface: add audio fields | S |
| T-TTS-02 | `ConversationGateway`: propagate TTS audio into outgoing frame | M |
| T-TTS-03 | Frontend: decode and play `audioBase64` on response receipt | S |

### WebRTC (0 tickets)
No Phase 1 work. Document as deferred.

### Video/Camera (3 tickets)
| Ticket | Title | Estimate |
|---|---|---|
| T-VIDEO-01 | `CameraController` `GET /api/camera/stream` via ffmpeg MJPEG | L |
| T-VIDEO-02 | Camera config (`CAMERA_DEVICE_ID`, `CAMERA_FPS`) in `AppConfig` | S |
| T-VIDEO-03 | Frontend `CameraPanel` component with failure fallback | M |

### Message Format (4 tickets)
| Ticket | Title | Estimate |
|---|---|---|
| T-MSG-01 | Backend: `metadata.isThinking` emission in `ConversationGateway` | S |
| T-MSG-02 | Frontend: `sylphieToDisplayMessage()` adapter for protocol mapping | S |
| T-MSG-03 | Frontend: guardian message display (client-local state) | S |
| T-MSG-04 | Frontend: inline STT transcription display before send | S |

### Theater Prohibition Display (3 tickets)
| Ticket | Title | Estimate |
|---|---|---|
| T-THEATER-01 | Frontend `DrivePanel`: live drive display from WebSocket | M |
| T-THEATER-02 | Frontend `TheaterCheckIndicator`: per-message theater check display | S |
| T-THEATER-03 | Frontend: neutral/no-expression default state before drive data arrives | S |

**Total: 17 tickets.** Size estimates: S = 1-2 hours, M = 3-5 hours, L = 6-10 hours.

---

## 9. Implementation Order

The tickets have dependencies. The safe order:

1. **T-TTS-01, T-TTS-02** (backend): fix the TTS delivery gap first. Without this, the frontend cannot be tested end-to-end with audio.
2. **T-AUDIO-01** (backend): fix STT format detection. Blocks T-AUDIO-03.
3. **T-MSG-01** (backend): add `isThinking` field. Small and unblocking.
4. **T-VIDEO-02** (config): camera config. Blocks T-VIDEO-01.
5. **Frontend work** (T-AUDIO-03, T-AUDIO-04, T-TTS-03, T-MSG-02, T-MSG-03, T-MSG-04, T-THEATER-01, T-THEATER-02, T-THEATER-03): all frontend tickets can proceed once T-TTS-01 and T-TTS-02 are done. T-VIDEO-01 and T-VIDEO-03 are independent.

Backend work is three tickets. Frontend work is fourteen tickets. The work is front-loaded on the frontend.

---

## 10. Key Risks

**Risk 1: TTS base64 payload size.** A 5-second Sylphie response generates roughly 50KB of MP3 at 128kbps. Base64-encoded, that is ~67KB per WebSocket frame. Acceptable for Phase 1. If responses routinely exceed 15 seconds, consider the URL-based delivery alternative.

**Risk 2: ffmpeg availability on Windows.** Jim's development machine is Windows 11. `ffmpeg` must be in PATH or the `CameraController` will fail silently. Document the dependency in `.env.example`.

**Risk 3: STT latency vs. 2-second threshold.** The pipeline is: record (variable) + POST to `/api/voice/transcribe` (500-1500ms Whisper) + process + LLM response (500-3000ms) + POST to `/api/voice/synthesize` (300-800ms) + play. Total end-to-end is 1.3-5.3 seconds. The 2-second threshold (Vox Rule 11) applies to the time from guardian's last word to Sylphie's first word. For voice input, this threshold will frequently be exceeded given Whisper latency alone. The correct response is not to skip Whisper -- it is to pre-buffer TTS acknowledgments and play "Hmm" (from the pre-computed cache in `TtsService`) immediately while the pipeline runs. This already exists in the backend (`TtsService.acknowledgmentCache`). The frontend needs to trigger it.

**Risk 4: Drive state not flowing to frontend.** The `TelemetryGateway` and `ConversationGateway` both emit drive snapshots but on different WebSocket paths (`/ws/telemetry` and `/ws/conversation`). The frontend should subscribe to both and merge. The `DrivePanel` must not depend on only one source.

---

## 11. What This Epic Does Not Cover

- **WebRTC signaling** -- deferred to Phase 2 per Section 2.
- **Phase 2 chassis camera** -- deferred per Section 3.2.
- **Object detection or annotation** -- deferred to Phase 2.
- **Multi-guardian support** -- `personId` is hardcoded to `'Person_Jim'` throughout; this is correct for Phase 1.
- **Frontend authentication** -- Phase 1 runs localhost-only; no auth required.
- **React component framework selection** -- Sylphie's CLAUDE.md specifies React + TypeScript + MUI. Epic 11 implements within that constraint, not choosing it.
