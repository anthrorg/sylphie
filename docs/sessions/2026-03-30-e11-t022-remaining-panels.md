# 2026-03-30 -- E11-T022: Skills Manager, FE Agent, and remaining panels

## Changes
- MODIFIED: frontend/src/types/index.ts -- Added SkillDto and SkillUploadResponse matching backend skills.dto.ts; kept legacy SkillPackage for reset API
- MODIFIED: frontend/src/store/index.ts -- Added skills: SkillDto[] field and setSkills action; exported InnerMonologueEntry; added rawPayload field to InnerMonologueEntry
- MODIFIED: frontend/src/hooks/useSkillPackages.ts -- Full rewrite: loadSkills/uploadConcept/deactivateSkill against real /api/skills endpoints; removed YAML file upload
- MODIFIED: frontend/src/components/Skills/SkillManager.tsx -- Replaced YAML upload with concept upload form (label/type dropdown/JSON properties); SkillCard shows SkillDto fields including confidence, provenance, isType1 badge, useCount, predictionMae
- MODIFIED: frontend/src/components/FEAgent/FEAgentPanel.tsx -- Header relabeled "Observatory Assistant (read-only)" per CANON
- MODIFIED: frontend/src/components/InnerMonologue/InnerMonologuePanel.tsx -- Shows verbatim telemetry event payloads; click-to-expand raw JSON; no LLM summarisation
- MODIFIED: frontend/src/components/SystemLogs/SystemLogsPanel.tsx -- Added severity filter toggle (all/warn+/error); shows entry count; capped at 200
- MODIFIED: frontend/src/components/MaintenanceLogs/MaintenanceLogsPanel.tsx -- Replaced dedicated WebSocket with telemetry stream; reads maintenance_cycle entries from store innerMonologue
- MODIFIED: frontend/src/hooks/useObservatoryAlerts.ts -- Derives 6 CANON attractor-state alerts from /api/metrics/health; falls back from /api/metrics/observatory/alerts
- MODIFIED: frontend/src/components/Conversation/ConversationPanel.tsx -- TheaterCheckIndicator: when is_grounded===false, orange warning banner per CANON Theater Prohibition
- MODIFIED: frontend/src/hooks/useWebSocket.ts -- maintenance_cycle inner monologue entries now include rawPayload for verbatim display

## Wiring Changes
- MaintenanceLogsPanel now reads from store.innerMonologue (filtered by text prefix) instead of its own WS
- useSkillPackages now calls setSkills (store) instead of setSkillPackages

## Known Issues
- /api/metrics/observatory/alerts endpoint does not exist yet; hook falls back to /api/metrics/health derivation

## Gotchas for Next Session
- The store still has skillPackages: SkillPackage[] for backwards compatibility; can be removed once all callers are confirmed gone
- ObservatoryAlerts attractor thresholds are heuristic; tune once real metric data is available
