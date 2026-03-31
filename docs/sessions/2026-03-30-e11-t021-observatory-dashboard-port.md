# 2026-03-30 -- E11-T021: Observatory Dashboard wired to Sylphie backend

## Changes
- MODIFIED: frontend/src/hooks/useObservatoryData.ts -- Changed base URL from http://localhost:8425 to relative /api/metrics/observatory/*; corrected endpoint slug phrase-recognition-ratio -> phrase-recognition; added typed adapter functions for all 7 endpoints; added experientialProvenance computed field; each endpoint fetched independently with graceful fallback to empty
- MODIFIED: frontend/src/hooks/useObservatoryAlerts.ts -- Changed base URL from http://localhost:8425 to relative /api/metrics/observatory/alerts; hook already degrades gracefully when endpoint is absent
- MODIFIED: frontend/src/components/Observatory/ObservatoryDashboard.tsx -- Updated all field access from old co-being shapes (phrase_nodes, can_produce_count, unique_action_types, etc.) to consume typed adapter output; replaced devStage.current pattern with devStage.overall.stage; added DriveEntry[] type to DriveHeatmap; added ProvenanceDisplay section (Experiential Provenance Ratio, prominent, always shown); added NoData component for per-section empty states; added empty state messaging when no sessions have run; updated STAGE_ORDER to match Sylphie's CANON stages (pre-autonomy/emerging/developing/autonomous)

## Wiring Changes
- useObservatoryData now fetches from Vite proxy -> /api/metrics/observatory/* -> NestJS MetricsController -> ObservatoryService

## Known Issues
- Pre-existing TS error in frontend/src/components/Graph/GraphPanel.tsx (GraphFilterBar unused) — not introduced by this session
- useObservatoryAlerts /api/metrics/observatory/alerts returns 404 (endpoint not built yet); hook degrades to reachable=false silently

## Gotchas for Next Session
- Vocabulary growth is now daily granularity (days), not per-session; chart labels show D1/D2/... not S1/S2/...
- Comprehension accuracy is displayed as 1-MAE (higher=better); raw MAE is available via ComprehensionEntry.producing_count = sampleCount
- Session comparison metricsSnapshot fields (totalCycles, avgPressure, etc.) will show '-' until SessionService.closeSession() writes them
