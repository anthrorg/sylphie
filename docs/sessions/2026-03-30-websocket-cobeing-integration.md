# 2026-03-30 -- WebSocket cobeing-v1 integration (E11-T016)

## Changes
- MODIFIED: frontend/src/hooks/useWebSocket.ts -- appended ?protocol=cobeing-v1 to all three WS URLs; fixed graph snapshot handler to read delta.snapshot (cobeing shape) in addition to delta.data (legacy shape); added sendTextMessage() that wraps text in the NestJS ws adapter envelope { event: 'message', data: { text, type: 'message' } }; onmessage now triggers incrementTurns() on cb_speech in addition to response; empty system_status frames (session-start/thinking-cleared) are dropped silently
- MODIFIED: frontend/src/store/index.ts -- fixed updateTelemetry to treat data.timestamp as milliseconds (CoBeing_DriveFrame.timestamp is Date.now(), not epoch seconds); removed the erroneous * 1000 multiplication
- MODIFIED: frontend/src/components/Conversation/ConversationPanel.tsx -- destructured sendTextMessage from useConversationWebSocket; replaced sendMessage({ type: 'user_message', ... }) calls with sendTextMessage(text) in both handleSendMessage and the voice event handler

## Wiring Changes
- All three WebSocket channels now negotiate cobeing-v1 protocol at connect time
- Guardian text → ConversationGateway path now uses the correct NestJS ws adapter envelope

## Known Issues
- phrase_word_rating still uses raw sendMessage; ConversationGateway has no handler for it — benign for now since that feature is not yet wired on the backend

## Gotchas for Next Session
- CoBeing_DriveFrame.timestamp is milliseconds; TelemetryMaintenanceCycle.timestamp is seconds — the two types use different epochs, kept separate in the switch statement
- Vite proxy forwards query strings automatically; no proxy config change was needed
