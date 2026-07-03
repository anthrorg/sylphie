# Dead Code / Stub Audit — 5aa7821

## Summary
Confirmed stubs: 1   |  Confirmed dead: 4  |  Theater-risk: 0
New (not in stub-inventory): 4

Whole-codebase fan-out (11 packages, one agent each). Each finding below had its
source file read in full before flagging; 203 graph/regex leads were dismissed as
false-positives (entry points, factory/JSX/dynamic dispatch, re-exports).

## Confirmed stubs / theater   (action: wire or document)

- `apps/sylphie/src/gateways/webrtc.gateway.ts:9` `WebRTCGateway.handleConnection`
  — **empty** — Gateway accepts `/ws/webrtc` connections and only logs `'WebRTC
  signaling client connected'`; it has NO `@SubscribeMessage` / message handler.
  The comment admits "ICE/SDP signaling handled when implemented". The frontend
  `useWebRTC` hook (`frontend/src/hooks/useWebRTC.ts`) actively sends SDP/ICE
  signaling messages to this endpoint that the backend silently drops — so WebRTC
  camera-feed signaling is non-functional. Reached (not dead), but a no-op stub.
  — [inventory: **NEW**]

## Confirmed dead exports     (action: remove or justify)

- `packages/shared/src/types/sensory-frame.ts` `ModalityType`
  — Explicitly `@deprecated` type export ("Use string modality names from the
  ModalityRegistry instead"). Re-exported in `types/index.ts` barrel but has ZERO
  consumers anywhere (grep over all `*.ts`: only the definition + the barrel
  re-export). Genuinely orphaned, deprecated public type. Type-only (not a graph
  `Function`), so absent from the graph inventory. — [inventory: NEW]

- `frontend/src/components/UnderConstruction.tsx:5` `UnderConstruction`
  — Default-exported React component with zero importers anywhere in `frontend/src`
  (full grep). `App.tsx` gates access via `LoginPage`/`AuthGate`, not this
  component. Body is honest (a real `VITE_APP_ENABLED` feature-flag page) but it is
  never rendered or imported — orphaned export, not an entry point. — [inventory: NEW]

- `frontend/src/components/Metrics/MetricsPanel.tsx:178` `MetricsPanel`
  — Named export explicitly marked `/** @deprecated Use the four individual panels
  instead */` with zero importers. `Dashboard.tsx` imports only `ExecutorStatePanel`
  + `DriveEnginePanel`; `AnalyticsView.tsx` imports the four sub-panels
  individually. The wrapper itself is unreferenced dead code. — [inventory: NEW]

- `packages/perception-service/cobeing/layer3_knowledge/` `cobeing.layer3_knowledge`
  (entire subsystem)
  — Whole semantic-knowledge subsystem (~75 modules incl. `spreading_activation`,
  `language_bootstrap`, `semantic_query`, `read_queries`, `observation_ingestion`,
  classification/inference/confidence-decay) is unreached from any executing
  first-party code. `main.py` — the sole FastAPI entrypoint — imports ONLY from
  `cobeing.layer2_perception`; it never imports `layer3_knowledge`. Outside the
  package the only refs are docs/wiki/planning + one TS-port comment
  (`decision-making/working-memory/activation.ts`), none of which execute it. All
  ~50 graph medium-confidence `possiblyDead` leads fall inside this subsystem.
  Reported as ONE inventoried block (not 50 findings) to avoid count inflation.
  — [inventory: **KNOWN — §2.9**]

## Stub-inventory reconciliation

**Drift (found in code, missing from `sylphie-stub-inventory.md`):**
- WebRTC signaling gateway (`webrtc.gateway.ts`) is a reached no-op stub: frontend
  sends SDP/ICE the backend drops. Not inventoried anywhere (`grep -i webrtc` over
  the inventory: 0 hits). The inventory's §3 frontend section calls `/ws/webrtc` a
  stub on the *client* side but does not record this server-side no-op. **Add it.**
- `ModalityType`, `UnderConstruction`, `MetricsPanel` — three deprecated/orphaned
  exports not tracked. These are cleanup candidates (deprecated → removable), low
  severity; optionally inventory or delete.

**Confirmed-still-accurate (inventory entry matches reality):**
- §2.9 "Spreading-activation engine is fully-formed but inert" — the entire
  `cobeing/layer3_knowledge` subsystem is still referenced by zero TS files, has no
  FastAPI route, and the live cognition path never calls into it. This is a
  DELIBERATE Phase-3 reference spec (chosen option: leave in place, do NOT wire
  as-is), not a silent stub. **No drift — entry remains correct at 5aa7821.**

**Stale (inventory entries no longer present):**
- None detected within the scope of confirmed findings this run. (§2.8 is already
  marked SEALED-BY-WAVE-3 and was not re-surfaced.)

## Dismissed leads (false-positives + why)

203 leads dismissed across the 11 packages (counts per fan-out agent):
- sylphie 14, drive-server 5, decision-making 17, drive-engine 25, learning 8,
  planning 15, shared 6, supervisor 38, frontend 9, cognition-service 10,
  perception-service 56.

Dominant dismissal reasons: NestJS DI services / decorator-driven entry points
(`@Cron`, `@OnEvent`, `@SubscribeMessage`, `onModuleInit`); framework lifecycle;
factory / dynamic-dispatch / event-name resolution the graph doesn't model; JSX
render targets; barrel re-exports; CLI `main`; and test helpers. Per-package
dismissal detail lives in the graph (nodes NOT annotated with `isStub`/`stubKind`)
and in each fan-out agent's structured return.
