# Epic 9: Dashboard API and WebSocket Gateways — Executive Summary

**Status:** Planned | **Complexity:** M | **Tickets:** 19

## What It Does

Builds the HTTP/WebSocket API surface for the React frontend dashboard. The WebModule is a pure consumer — it reads from all 5 subsystems but never contains business logic.

## Key Endpoints

| Category | Endpoints | Protocol |
|----------|-----------|----------|
| Health | /api/health (all 5 DBs) | REST |
| Drives | /api/drives/current, /history | REST |
| Graph | /api/graph/snapshot, /stats, /subgraph | REST |
| Conversation | /api/conversation/history, /messages | REST |
| Metrics | /api/metrics/health (7 CANON metrics) | REST |
| Voice | /api/voice/transcribe, /synthesize | REST |
| Telemetry | /ws/telemetry (drive ticks, predictions) | WebSocket |
| Graph Updates | /ws/graph (WKG changes) | WebSocket |
| Chat | /ws/conversation (bidirectional) | WebSocket |

## CANON Compliance

**Verdict: COMPLIANT.** No drive writes, no graph writes, no Phase 2 leakage. Chat input routes through Communication module. Theater check included in all conversation responses.

## v1 Patterns Prohibited

Drive override endpoints, direct graph writes, camera endpoints, direct action selection.

## Dependencies

E2 (Events), E3 (Knowledge), E4 (Drive Engine), E5 (Decision Making), E6 (Communication)
