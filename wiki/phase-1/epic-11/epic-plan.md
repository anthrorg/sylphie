# Epic 11: Frontend Port & Media Integration

## Summary

Port the co-being React frontend to Sylphie with full feature parity (minus demo mode). Add backend support for all UI features including Observatory analytics, STT/TTS audio delivery, WebRTC video, and guardian concept upload.

## Scope

**In scope:**
- Full co-being frontend port (React + MUI + Vite + Zustand + Cytoscape)
- WebSocket adapter layer for co-being wire format compatibility
- Observatory Dashboard (7 analytics endpoints)
- STT/TTS audio pipeline (fix delivery gap + format detection)
- WebRTC signaling + MJPEG camera streaming
- Skills Manager with guardian concept upload
- All visualization panels (drives, graph, inner monologue, metrics, logs)
- FE Agent panel (Observatory Assistant)
- Session lifecycle management

**Out of scope:**
- Demo mode (removed entirely)
- Phase 2 chassis camera integration
- Object detection / YOLO perception
- Multi-guardian support
- Frontend authentication (localhost-only Phase 1)

## Architecture Decisions

1. **Dual-protocol WebSocket support** via `?protocol=cobeing-v1` query param. Native Sylphie format preserved as default.
2. **No new modules except MediaModule** for WebRTC/camera. Observatory in MetricsModule. Skills endpoints in WebModule.
3. **STT/TTS via REST, not WebSocket binary.** Audio delivered as base64 in conversation messages.
4. **WebRTC for webcam feed.** MJPEG as fallback.
5. **Session metrics snapshots** persisted to PostgreSQL at session close (no cross-DB joins on read).
6. **Frontend adapts to Sylphie protocol** where possible; backend adds adapter layer for format differences.

## CANON Amendments Required

1. **A.13 (Skill Packages):** Activate for Phase 1 with guardian-controlled concept upload pathway. External concepts enter WKG with GUARDIAN provenance at 0.60 base confidence.
2. **Phase 1 Video:** Clarify webcam as Phase 1 Video input mechanism per CANON §Subsystem 1 §Flow. Chassis camera is Phase 2.

## Ticket Summary

| Wave | Tickets | Focus |
|------|---------|-------|
| Wave 1 | E11-T001 through E11-T007 | Backend foundations |
| Wave 2 | E11-T008 through E11-T012 | Adapters + new endpoints |
| Wave 3 | E11-T013 through E11-T014 | Media module |
| Wave 4 | E11-T015 through E11-T022 | Frontend port |
| Wave 5 | E11-T023 | E2E verification |

**Total: 23 tickets** (5S, 8M, 5L, 5L)

## Agent Analyses

- Forge: `docs/epics/epic-11-forge-analysis.md`
- Vox: `docs/epics/epic-11-vox-analysis.md`
- Sentinel: `docs/epics/epic-11-sentinel-analysis.md`
- Canon: `docs/epics/epic-11-canon-verification.md`
