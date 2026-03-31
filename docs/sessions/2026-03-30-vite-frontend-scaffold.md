# 2026-03-30 -- Vite frontend scaffold (E11-T015)

## Changes
- NEW: frontend/package.json -- sylphie-frontend Vite+React+TS package, no @cobeing/shared, no playwright
- NEW: frontend/vite.config.ts -- Vite dev server with /api and /ws proxy to localhost:3000
- NEW: frontend/tsconfig.json -- standalone tsconfig for frontend (strict mode)
- NEW: frontend/index.html, eslint.config.js, .prettierrc -- project scaffolding
- NEW: frontend/src/types/index.ts -- all types defined locally (replaces @cobeing/shared)
- NEW: frontend/src/store/index.ts -- Zustand store, demoSessionId removed, AppState cast fix
- NEW: frontend/src/hooks/useWebSocket.ts -- WS_BASE uses window.location.host, demo mode removed
- NEW: frontend/src/hooks/ (11 files) -- all hooks copied verbatim or lightly adapted
- NEW: frontend/src/services/feAgent.ts -- CoBeing->Sylphie references updated
- NEW: frontend/src/App.tsx, Dashboard.tsx, main.tsx, theme/index.ts -- app shell
- NEW: frontend/src/components/ (16 files) -- all UI panels written
- MODIFIED: package.json (root) -- added frontend:install, frontend:dev, frontend:build scripts

## Wiring Changes
- Vite dev server (port 5173) proxies /api/* and /ws/* to NestJS on localhost:3000
- No runtime coupling to co-being package; all shared types are local to frontend/src/types/

## Known Issues
- npm audit reports 2 moderate severity vulnerabilities in transitive deps (non-blocking)
- Frontend has no live NestJS backend yet; WebSockets will show disconnected state at runtime

## Gotchas for Next Session
- TelemetryCycle.dynamic_threshold was missing from @cobeing/shared; added locally -- NestJS backend must emit this field
- DriveHeatmap only shows 11 drives (no social); if backend emits social, add it to driveNames array
- WS_BASE resolves via window.location.host so Vite proxy works in dev and prod with same code
