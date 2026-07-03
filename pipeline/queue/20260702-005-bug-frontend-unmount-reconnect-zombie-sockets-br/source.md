# Bug: Frontend — unmount-reconnect zombie sockets, browser-exposed API key, dead/void UI features; shared DB nits

**Severity:** high  ·  **Priority:** P1
**Area / component:** frontend/** (WS hooks, agent, panels) + packages/shared (DB clients)

## What's broken (required)
The shared package is clean; the frontend shows real leak-hunting discipline (TK-105 eviction complete, buffers capped), but one systemic reconnect defect plus several silent-failure and dead-UI issues:
- **Unmount-reconnect zombie sockets in all four WS hooks.** Effect cleanup clears the pending timer and calls `close()` but never nulls `wsRef` / sets an unmounted flag; the async `onclose` then passes its staleness guard (`wsRef.current !== ws` is false), calls `scheduleReconnect()`, and opens an orphan socket that keeps writing into the global Zustand store. Every navigation away from a tab leaves a live orphan → duplicate messages, double turn counts, and the orphan's reconnect can evict the *visible* tab (close 1012 suppresses its reconnect → permanently "disconnected"). This re-creates the exact double-delivery bug the code comments claim was fixed.
- **Anthropic API key in the browser bundle.** `feAgent.ts:37-44` reads `VITE_ANTHROPIC_API_KEY` (Vite inlines it into built JS) and uses `dangerouslyAllowBrowser`. Anyone loading the dashboard (which has a public login/register page) can extract the key.
- **Word-rating feature sends into the void.** `ConversationPanel.tsx:349-351` sends a raw `{type:'phrase_word_rating'}` frame instead of the NestJS `{event,data}` envelope, and no `phrase_word_rating` handler exists anywhere in the backend. Every guardian rating is silently dropped — they believe they're training Sylphie; nothing happens.
- **Perception WS never reconnects.** `usePerception.ts:310-326` clears intervals/refs and stops on close with no reconnect path; the camera keeps painting so the UI looks alive while YOLO/face detection is permanently gone after one drop.
- **Telemetry contract drift → dead panels.** The frontend handles `prediction_result`/`maintenance_cycle`/`state_transition` which nothing emits; `drive-publisher` hardcodes `action:null` so the action-history branch never fires → MetricsPanel "Recent Actions"/"Prediction Accuracy" are permanently empty dead UI. Plus a ms-vs-seconds timestamp mismatch (three conventions in one file) that would render every entry as "0s ago" if actions ever flowed.
- Lower: WebRTC leaks an RTCPeerConnection per signaling reconnect + missing staleness guard; transient `/api/auth/me` failure deletes the stored token (logs the user out on a network blip); full-store Zustand subscriptions re-render media components at 15 fps / 2 Hz; `usePressureStatus` has two competing state writers (indicator flapping); shared: Prisma DSN not URL-escaped + `env!` assertions, `withTransaction` ROLLBACK can mask the original error, `useAutoScroll` ignores its `behavior` option.

## Expected (required)
Unmounting a component tears down its socket with no orphan reconnect; the Anthropic key is never shipped to the browser (proxied through the backend); word-rating either reaches a real backend handler or the affordance is removed; perception reconnects like the other hooks; and dead telemetry panels are either wired to real events or removed.

## Steps to reproduce (required)
1. Open Chat, switch dashboard tabs a few times, return to Chat. Observe duplicated messages / double turn counts (orphan + new socket both receiving broadcasts); sometimes the visible tab shows permanently "disconnected."
2. Build the frontend and grep the bundle for the Anthropic key prefix — it's present.
3. Rate a word in the WordRatingDrawer; observe no backend handler receives it (no `phrase_word_rating` in gateway logs).
4. Restart the backend while the perception panel is open; camera keeps rendering but detections never resume.

**Reproducibility:** always for #1–#4.

## Evidence
- Zombie sockets: `frontend/src/hooks/useWebSocket.ts:366-375` (+170-183, 512-521), `useSupervisorWebSocket.ts:94-103`.
- API key: `frontend/src/services/feAgent.ts:37-44`.
- Word rating: `frontend/src/components/Conversation/ConversationPanel.tsx:349-351`; envelope contrast `useWebSocket.ts:217-219`; no backend handler (grep; only `'message'`/`'guardian_feedback'` at `conversation.gateway.ts:352,429`).
- Perception: `frontend/src/hooks/usePerception.ts:310-326,247-252`.
- Telemetry drift: `useWebSocket.ts:437-461`; producers only `drive-publisher.service.ts:100,116-118` + `telemetry-broadcast.service.ts:28`; store `store/index.ts:432-437,464,472`; `MetricsPanel.tsx:15-21`.
- Lower: `useWebRTC.ts:120,243-279`; `App.tsx:32-40` (+ `store/index.ts:212-215`); `usePerception.ts:133`, `useVoiceRecording.ts:51`, `useAudioStream.ts:47`, `useWebRTC.ts:50`; `usePressureStatus.ts:18-46`; `packages/shared/src/storage/prisma.service.ts:14,18-21`, `config/database.config.ts:6-27`, `storage/timescale.service.ts:82-84`, `frontend/src/hooks/useAutoScroll.ts:14-29`.
- Verified clean (do not re-file): all seven WS paths match backend registrations; Vite proxy port matches; shared DB client lifecycle; schema matches migrations; TK-105 eviction complete; store buffers capped.

Full detail: `docs/audits/repo-bug-audit-2026-07-02.md` §6.

## Where it lives (scope hints)
One shared fix for the reconnect pattern applied across `frontend/src/hooks/useWebSocket.ts`, `useSupervisorWebSocket.ts`, `usePerception.ts`, `useWebRTC.ts` (add an `unmounted`/`closedByUnmount` flag, null `wsRef`, and short-circuit `scheduleReconnect`). API key → a backend proxy endpoint. Word rating → add a gateway handler or remove the drawer. Owned by `forge` (frontend/shared) per CLAUDE.md work-trio.

## Database impact (required)
**Touches a database / schema / migration?** no. Frontend + a backend proxy route; shared DB nits are client-code (escaping/error-handling), no schema/migration.

## Acceptance — how we'll know it's fixed (required)
- Given a mounted WS panel, when its component unmounts, then no orphan socket remains and no reconnect is scheduled (test with a mock socket asserting `onclose` after unmount does not call `scheduleReconnect`); returning to the tab shows single delivery and correct turn counts.
- Given a built frontend bundle, when searched, then it contains no Anthropic API key; the FE agent calls a backend proxy.
- Given a word rating, when submitted, then a backend handler receives it (gateway log / unit test) — or the affordance is gone.
- Given a backend restart with the perception panel open, when the socket drops, then perception reconnects and detections resume.

## Environment
Frontend (browser); worst on public deploys for the key exposure. Source-trace at commit `228df73`.

## Notes / non-goals (optional)
- The reconnect fix here is the same class as the drive-server/apps-sylphie reconnect items — share the "wait for open, guard against unmount" pattern.
- Non-goal: building real telemetry for the dead MetricsPanel branches (that's a feature); here, either wire to existing events or remove the dead handlers to stop implying data exists.
