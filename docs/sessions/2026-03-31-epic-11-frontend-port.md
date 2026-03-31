# 2026-03-31 -- Epic 11: Frontend Port & Media Integration

## Changes
- NEW: frontend/ -- Full React+MUI+Vite frontend ported from co-being
- NEW: src/web/adapters/ -- Dual-protocol WebSocket adapters (telemetry, conversation, graph)
- NEW: src/media/ -- MediaModule with WebRTC signaling gateway
- NEW: src/web/controllers/camera.controller.ts -- MJPEG webcam streaming via ffmpeg
- NEW: src/web/controllers/skills.controller.ts -- Skills CRUD + guardian concept upload
- NEW: src/web/services/observatory.service.ts -- 7 analytics endpoints
- NEW: src/web/services/session.service.ts -- Session lifecycle with metrics snapshots
- MODIFIED: src/decision-making/ -- Event instrumentation (TYPE_1/2_DECISION, PREDICTION_EVALUATED)
- MODIFIED: src/events/builders/event-builders.ts -- Fixed critical bug: buildEvent() was discarding all payload data
- MODIFIED: src/communication/voice/ -- STT format detection fix, TTS audio delivery to frontend
- MODIFIED: src/web/gateways/ -- Dual-protocol support, isThinking indicator
- MODIFIED: src/knowledge/ -- schema_level field on GraphNodeDto, vocabulary/phrase queries
- MODIFIED: wiki/CANON.md -- A.13 activated, Phase 1 webcam clarified

## Wiring Changes
- MetricsModule imported in WebModule for Observatory endpoints
- MediaModule added to AppModule
- CANON A.13 amended: guardian concept upload active

## Known Issues
- /api/voice/status and /api/debug/camera/status return 404 (legacy co-being endpoints not ported)
- Initial WS connection has brief reconnect flicker before stabilizing
- TTS/STT require OPENAI_API_KEY (copy from co-being .env)
- Camera requires ffmpeg in PATH

## Gotchas for Next Session
- DriveSnapshot.timestamp typed as Date but runtime is number -- safe coercion applied everywhere
- Two Observatory endpoints (developmental-stage, comprehension-accuracy) return empty until DM events accumulate
- Frontend expects dynamic_threshold field in telemetry -- backend defaults to 0
