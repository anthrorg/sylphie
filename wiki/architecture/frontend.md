# frontend — Architecture Reference

> Living document. Last updated: 2026-06-13. Auto-generated from full-file reads (one agent per file); verify before trusting any single line.

**72 files** mapped.

## File-by-file

### `frontend/`

#### vite.config.ts
*config* — Vite build and dev server configuration for React frontend with API proxy.

Defines the Vite development and build config for the React frontend. Enables the React plugin via @vitejs/plugin-react. Dev server runs on port 5173. Configures two proxy routes: /api forwards to http://localhost:3000 (REST endpoints), and /ws forwards to ws://localhost:3000 with WebSocket support enabled (ws: true). This allows frontend code to call /api/* and /ws/* URIs without CORS issues during local development, with vite automatically routing them to the backend service.

- **Key constants:** `port=5173`, `apiTarget=http://localhost:3000`, `wsTarget=ws://localhost:3000`
- **Deps:** `vite`, `@vitejs/plugin-react`

### `frontend/src/`

#### App.tsx
*component* — Root React application component with authentication gate and dashboard routing

Top-level app component wrapping the entire frontend in MUI ThemeProvider and BrowserRouter. AuthGate component handles auth token validation via /api/auth/me endpoint, displaying a loading spinner while checking, then conditionally rendering LoginPage or protected dashboard routes. Protected routes include DashboardLayout (new multi-view sidebar-nav dashboard at /dashboard) with GraphsView, AnalyticsView, ChatView, CodebaseView, and GuardianView sub-routes, plus legacy Dashboard at /legacy. Default route redirects to /dashboard. AuthGate runs analytics pageview tracking via useAnalyticsPageviews hook. Auth state (authToken, authChecked, user) is managed via useAppStore (Zustand).

- **Exports:** `default (App)`
- **Key constants:** `auth endpoint: /api/auth/me`, `default redirect: /dashboard`
- **Deps:** `./store (useAppStore)`, `./theme`, `./Dashboard`, `./layouts/DashboardLayout`, `./pages/LoginPage`, `./pages/dashboard/GraphsView`, `./pages/dashboard/AnalyticsView`, `./pages/dashboard/ChatView`, `./pages/dashboard/CodebaseView`, `./pages/dashboard/GuardianView`, `./lib/analytics (useAnalyticsPageviews)`, `@mui/material`, `react-router-dom`
- **Gotchas:** AuthGate useEffect has eslint-disable-line comment for missing setAuth/clearAuth deps — may cause stale closure bugs if auth functions change. No error handling UI for failed auth check beyond silent clearAuth. Legacy Dashboard route suggests migration in progress.

#### Dashboard.tsx
*component* — Main layout orchestrator for Sylphie frontend; renders grid of telemetry and control panels with modal dialogs for observatory and supervisor.

Dashboard is the root component that composes the full UI: top bar with session/connection status, three-row panel grid (graph|chat|radar radar, audio strip, camera|maintenance|logs|metrics sidebar), plus three always-mounted modal systems (SkillManager, NodeInspector, FEAgentPanel). TopBar shows connection states (graph/conversation/telemetry/audio/video), elapsed session timer, node/edge counts, and buttons to open Observatory (modal dialog) and Supervisor dialogs. Panel is a reusable styled wrapper (bg: rgba(117,191,156,0.2), border: 2px dashed rgba(184,217,198,0.3), borderRadius: 2). StatusDot renders a colored 12px circle (green=connected, orange=reconnecting, red=disconnected, blue=other) with label. Dashboard initializes WebSocket connections (useGraphWebSocket, useTelemetryWebSocket) and fetches /api/voice/status on mount to set voiceState.available. GAP constant is 8px for spacing.

- **Exports:** `default (Dashboard)`
- **Key constants:** `GAP=8`
- **Deps:** `react`, `@mui/material (AppBar, Box, Button, Dialog, DialogContent, DialogTitle, IconButton, Stack, Theme, Toolbar, Typography)`, `@mui/icons-material (BarChart, Close, Extension, Psychology)`, `./components/Supervisor/SupervisorPanel`, `./store (useAppStore)`, `./hooks/useSessionTimer`, `./types (WSState)`, `./hooks/useDevMode`, `./components/Drives/DriveRadarChart`, `./components/Graph/GraphPanel`, `./components/Conversation/ConversationPanel`, `./components/MaintenanceLogs/MaintenanceLogsPanel`, `./components/Metrics/MetricsPanel (ExecutorStatePanel, DriveEnginePanel)`, `./components/SystemLogs/SystemLogsPanel`, `./components/Observatory/ObservatoryDashboard`, `./components/Skills/SkillManager`, `./components/Graph/NodeInspector`, `./components/FEAgent/FEAgentPanel`, `./components/Camera/CameraPanel`, `./components/Audio/AudioPanel`, `./hooks/useWebSocket (useGraphWebSocket, useTelemetryWebSocket)`
- **Gotchas:** VideoWidget replaced by CameraPanel (uses usePerception hook). Comment at line 41 signals legacy code removal. Observatory and Supervisor dialogs use full screen with maxWidth='lg' and height='80vh' but no error boundary around children. /api/voice/status fetch silently catches errors and sets available:false with no retry logic.

#### main.tsx
*config* — React app entry point and initialization

Root module that mounts the React application to the DOM. Imports React, ReactDOM, the main App component, and initializes analytics via initAnalytics(). Creates a React root at the element with id='root' and renders the App component wrapped in React.StrictMode for development checks. Runs initAnalytics() side effect before React mounts. No explicit error boundaries or suspense fallbacks; initialization is synchronous.

- **Deps:** `./App`, `./lib/analytics`
- **Gotchas:** Root element with id='root' must exist in index.html; non-existent element would crash. initAnalytics() runs synchronously before React render, blocking mount if it fails. No error handling around ReactDOM.createRoot or render.

### `frontend/src/components/`

#### UnderConstruction.tsx
*component* — Placeholder component displayed when the dashboard is disabled

Exports a React functional component (UnderConstruction) that renders a full-height centered layout with a build icon, heading, and instruction text. Uses Material-UI Box and Typography for styling. Displays a BuildIcon (64px, secondary color), "Under Construction" heading (h4), and a body message instructing users to set VITE_APP_ENABLED=true to access the dashboard. Layout is column-flex centered both vertically and horizontally with 2-unit gap spacing.

- **Exports:** `UnderConstruction (default)`
- **Deps:** `React`, `@mui/material (Box, Typography)`, `@mui/icons-material (BuildIcon)`
- **Gotchas:** Hard-coded instruction text mentioning VITE_APP_ENABLED; no programmatic access to environment variable state to show actual current status; no fallback state management if enabled dynamically

### `frontend/src/components/Alerts/`

#### AttractorAlertBanner.tsx
*component* — Display attractor warnings from Observatory API with risk-level severity mapping and dismissal UI.

React functional component that polls Observatory alerts via useObservatoryAlerts hook and renders them as MUI Alert cards. Maps Observatory risk levels (CRITICAL→error, HIGH→warning, MEDIUM/LOW→info) to MUI severity. Filters dismissed alerts using a local Set (not persisted; reappears on reload). Each alert displays name, risk_score as percentage, intervention protocol, and close button. Returns null when Observatory unreachable or no visible alerts exist. Uses Collapse wrapper for animation, Box container with px=2 pt=1 spacing, AlertTitle with custom font size 0.85rem.

- **Exports:** `AttractorAlertBanner`
- **Key constants:** `severityMap={CRITICAL:error, HIGH:warning, MEDIUM:info, LOW:info}`, `AlertTitle fontSize=0.85rem`, `Typography fontSize=0.8rem`, `Box spacing px=2 pt=1`
- **Deps:** `useObservatoryAlerts`
- **Gotchas:** Dismissed alerts cleared only on page reload (local state, no persistence). useObservatoryAlerts hook dependency not shown in this file; potential fragility if hook refactors or reachable/alerts/dismissed/dismiss contract changes.

### `frontend/src/components/Audio/`

#### AudioPanel.tsx
*component* — React component for real-time audio I/O visualization with FFT frequency bars.

AudioPanel displays live microphone input and TTS output as frequency bar charts (24 bars at 64-point FFT). Input analyser wired to useAudioStream MediaStream via useEffect; onplay of TTS audio received via window event 'sylphie:audio_response', base64-decoded and played while visualizing frequencies. Status chip shows MIC ERR (red), LIVE (green), or CONNECTING (amber). Input bars turn green when streaming, red on error, white when idle; output bars turn blue when any level > 0, white otherwise. Live transcript displayed below charts if available. No exports of named functions; component is default export.

- **Exports:** `AudioPanel`
- **Key constants:** `NUM_BARS=24`, `barOptions={responsive:true,maintainAspectRatio:true,aspectRatio:8,animation.duration:80,scales.y:{min:0,max:1},fftSize:64}`
- **Deps:** `useAudioStream`, `useAppStore`
- **Gotchas:** Creates new AudioContext on each TTS event; no pooling or reuse (lines 87). Multiple unaborted audio playbacks could stack contexts. outputDecayRef allocated but never read (line 39). No sample-rate or stereo-channel normalization across devices.

### `frontend/src/components/Camera/`

#### CameraPanel.tsx
*component* — React camera feed viewer with layer annotation toggles and PIP/main layout modes

CameraPanel is a React FC that displays a live camera feed via canvas and provides annotation layer controls (objects, tracking, face-mesh, face-dots, face-contour, face-bbox). It uses useAppStore for camera mode state (PIP vs main) and usePerception for canvas ref, feed status, layer toggling, and error handling. LAYER_CHIPS defines 6 annotation layers with distinct colors (#00ff00 objects, #ff6600 tracking, #00bfff face-mesh/bbox, #ff4081 face-dots, #ffa500 face-contour). PIP mode renders a 200x150px sticky overlay (bottom:16, left:16, z-index:10) with expand button; main mode renders full-height container with toolbar header (40px min, dark #111827 bg), layer toggle chips when active, collapse button, and canvas stretch (objectFit:'contain' main, 'cover' PIP). Fallback shows VideocamOffIcon + error message when feed inactive. Canvas refs and layer state are managed via hooks; mode/layer toggles are click handlers with event.stopPropagation on PIP expand.

- **Exports:** `CameraPanel`
- **Key constants:** `LAYER_CHIPS[6] with colors: #00ff00, #ff6600, #00bfff, #ff4081, #ffa500`, `PIP dimensions: 200x150`, `PIP position: bottom:16, left:16, zIndex:10`, `Fallback bg: #2a2a3e`
- **Deps:** `../../store (useAppStore)`, `../../hooks/usePerception (usePerception, AnnotationLayer)`, `@mui/material (Box, Chip, IconButton, Typography)`, `@mui/icons-material (Fullscreen, FullscreenExit, VideocamOff)`
- **Gotchas:** No error boundary; canvas ref cast to HTMLCanvasElement assumes usePerception provides correct type; layer state mutations via spread operator; PIP/main layout is conditional render (not CSS media query) — layout changes on cameraState.mode change require parent to handle reflow

#### RecognitionChips.tsx
*component* — Displays a scrollable panel of MUI Chips for recognized objects/faces from camera feed

RecognitionChips is a React FC that subscribes to recognizedItems from the app store and renders them as styled MUI Chips. For each item, it determines coloring based on two flags: discovered (unknown vs known) and type (face vs object). Unknown items get orange/amber colors with a pulse animation (2s ease-in-out infinite); known faces get cyan, known objects get green. Duration > 5000ms is appended as suffix (format: 60s -> 1m, etc.). Unknown items pulse between opacity 1.0 and 0.6. The panel has a fixed header with Eye icon and 'RECOGNIZED' label, scrollable content area with flex-wrap, and renders 'Nothing detected yet' when empty.

- **Exports:** `RecognitionChips`
- **Key constants:** `duration_threshold=5000`, `pulse_animation_duration=2000`, `opacity_pulse_min=0.6`, `opacity_pulse_max=1.0`, `unknown_face_bg=rgba(255, 152, 0, 0.15)`, `unknown_object_bg=rgba(255, 183, 77, 0.12)`, `known_face_bg=rgba(0, 191, 255, 0.15)`, `known_object_bg=rgba(0, 255, 0, 0.1)`
- **Deps:** `../../store (useAppStore)`

### `frontend/src/components/Codebase/`

#### ContextPanel.tsx
*component* — Right-side inspection panel for code graph nodes; displays function/type metadata, source, dependencies, and recent changes via tabbed interface.

React component ContextPanel displays metadata for selected GraphNode entities in a 380px side panel. Exports two sub-components: SectionLabel (0.6rem uppercase labels with 1px letterSpacing) and CodeLink (clickable node entries with type chips, monospace styling, filenames). Main ContextPanel fetches FunctionDetail and DataFlowResult in parallel from /api/graph/pkg/function and /api/graph/pkg/dataflow (depth=2, direction=both) on node selection; manages loading state and 4-tab interface (Overview, Source, Dependencies, Changes). Overview displays signature badges (export/async/return-type), JSDoc comment, caller/callee/type counts, and node properties. Source tab shows syntax-highlighted function body in monospace pre block (max 100vh-250px height, auto-scroll). Dependencies tab lists callers, callees, related types as CodeLink rows, plus upstream/downstream data-flow summary. Changes tab renders recent git commits with hash, author, date, message. Abort controller cancels fetch on unmount; onHighlightDataFlow callback propagates all upstream/downstream node names to parent.

- **Exports:** `ContextPanel`, `SectionLabel`, `CodeLink`
- **Key constants:** `panel width=380`, `tab fontSize=0.65rem`, `SectionLabel fontSize=0.6rem with letterSpacing=1`, `CodeLink hover=rgba(69,183,209,0.08)`, `Function type chip color=#45B7D1`, `Type chip color=#CE93D8`, `nodeColor map: Service=#FF6B6B, Module=#4ECDC4, Function=#45B7D1, Type=#CE93D8, Change=#FFB74D`, `Source maxHeight=calc(100vh - 250px)`, `Data flow depth=2`
- **Deps:** `@mui/material`, `@mui/icons-material`, `../../types (GraphNode)`
- **Gotchas:** Backend availability risk: 'Source code not available. The backend may need to be restarted' fallback message indicates silent fetch failures; no error logs. Floating dependency onHighlightDataFlow callback with eslint-disable-next-line (line 168) — missing onHighlightDataFlow in dependency array creates stale-closure risk. Filtering node.properties for bodyText and contentHash (line 303) is hardcoded tuple with no extensibility. Date formatting truncates to 10 chars (line 433) without validation. Data flow upstream/downstream counted but not paginated; no indicator if results truncated beyond 2-hop limit.

#### SearchBar.tsx
*component* — Search UI component for querying functions/types in the codebase graph API

SearchBar is a React functional component that provides a debounced search interface for codebase navigation. It accepts two callbacks: onSelect (fired when user picks a result) and onHighlightResults (called with matching names). The component manages query state, loading indicator, and a dropdown of results. It fetches from /api/graph/pkg/search?pattern=...&limit=15 with abort-controller cleanup and debounces input at 300ms. Results render as a Material-UI dropdown showing type (Function/Type as colored chips), name, file path with line number, and up to 2 matching code lines. It displays export/async badges, clears on ESC or click-away, and deduplicates via abort on new queries.

- **Exports:** `SearchBar`, `SearchResult`
- **Key constants:** `minQueryLength=2`, `debounceMs=300`, `resultLimit=15`, `maxDropdownHeight=400`, `maxMatchLines=2`
- **Deps:** `@mui/material (Box, InputBase, Paper, Typography, CircularProgress, Chip, ClickAwayListener)`, `@mui/icons-material (Search)`
- **Gotchas:** fetch response error sets results to empty without logging; abortRef can be null on unmount race; no keyboard navigation (arrow keys) in dropdown; matchLines truncated to first 2 with ellipsis, no line-number context shown; result deduplication relies on name+filePath+index composite key

### `frontend/src/components/Conversation/`

#### ConversationPanel.tsx
*component* — Main React component for rendering real-time conversation interface with messages, input, and voice integration

ConversationPanel is the root component orchestrating the conversation UI. It renders: (1) MessageBubble — memoized sub-component displaying individual messages (guardian, response, cb_speech, transcription, thinking, error types) with grounding badges (GROUNDED/LLM_ASSISTED/UNKNOWN), theater-check warning (is_grounded=false per CANON #1), and optional metadata (intent_type, referenced_node_count); (2) ConversationInput — extracted stateful input control with textarea, send button, and mute toggle, owning input state to prevent re-rendering the message feed on keystroke; (3) integration hooks: useConversationWebSocket for sendMessage/sendTextMessage WS envelope wrapping, useAutoScroll for feed bottom-pinning, useAppStore selectors for messages/isThinking/queuePosition/wsConnectionState; (4) queue position indicator (WS4 T6) shown when queuePosition !== null and not thinking; (5) voice-text listener on sylphie:voice_text custom event, routing STT transcriptions through the same guardian path as typed text; (6) WordRatingDrawer child for phrase-word bad-rating (phrase_word_rating message type). Typography and color coding: guardian (teal, right-aligned), response/cb_speech color varies by grounding (green=GROUNDED from memory, orange=LLM_ASSISTED tool-assisted-guess, white=UNKNOWN/doesn't-know), transcription (blue), error (red), thinking (pulse animation bounce 1.2s 3-dot loader). Connection warning shown when wsConnectionState !== 'connected'.

- **Exports:** `ConversationPanel`, `MessageBubbleImpl`, `MessageBubble`, `ConversationInput`
- **Key constants:** `maxWidth='75%'`, `maxRows=4`, `bounce animation 1.2s infinite`, `position indicator fontSize='0.78rem'`, `theater-check badge fontSize='0.62rem'`, `grounding badge colors: GROUNDED rgba(76,175,80), LLM_ASSISTED rgba(255,183,77), UNKNOWN rgba(255,255,255)`
- **Deps:** `useAppStore`, `useConversationWebSocket`, `useAutoScroll`, `ConversationMessage type`, `WordRatingDrawer`
- **Gotchas:** MessageBubble memoized on referential equality, clientId stamping in parent required for correctness; ConversationInput isolated state prevents feed re-render on typing (intentional optimization); backend may send 'text' or 'content' so displayText checks both; voice-text listener added/removed in useEffect with dependency array [wsConnectionState, addMessage, sendTextMessage]; theater-check rendering depends on is_grounded explicitly false (not null/undefined); queue position hides during isThinking to avoid visual conflict with typing indicator

#### WordRatingDrawer.tsx
*component* — Left-side drawer UI for marking words in Sylphie's responses as wrong for feedback.

React functional component that displays a message in a Material-UI Drawer (600px wide, dark theme) and allows users to click individual words to mark them as incorrect. Splits message text by whitespace (regex /\s+/) into word chips. Core state: markedPositions Set<number> tracks which word indices have been marked. Main handler handleToggle toggles marking on click and invokes onWordMarked callback with (phrase_node_id, word, position). Marking gated by presence of phrase_node_id on message. Visual feedback: marked words show red background rgba(244,67,54,0.15) and border, unmarked default light. Status line at bottom shows count of marked words or prompts to click.

- **Exports:** `WordRatingDrawer`
- **Key constants:** `drawer width=600`, `dark bgcolor=#12121f`, `marked bgcolor=rgba(244,67,54,0.15)`, `marked color=rgba(244,100,54,0.95)`
- **Deps:** `react`, `@mui/material`, `@mui/material/icons`, `../../types (ConversationMessage)`
- **Gotchas:** Phrase node ID presence is silent gate for marking; no error if missing, just disables interaction. Marked status shows 'wrong' label next to each marked word chip. onWordMarked fired immediately on mark (not unmark) with current word/position. No persistence or undo within component.

### `frontend/src/components/Drives/`

#### DriveBarChart.tsx
*component* — Visualizes Sylphie's pressure drives (core and complement) as horizontal and vertical bar charts with real-time staleness detection.

Exports two React chart components: CoreDrivesChart renders 4 core drives (system_health, moral_valence, integrity, cognitive_awareness) as two paired horizontal bars side-by-side; ComplementDrivesChart renders 8 complement drives (guilt, curiosity, boredom, anxiety, satisfaction, sadness, focus, social) as a single vertical bar chart. Both subscribe to useAppStore for pressure telemetry (pressure object, pressureSeq, pressureTimestampMs, pressureIsStale). Color function getBarColor maps [−10.0, 1.0] CANON range to 5 severity bands: teal for relief (<0), green (<0.3), amber (<0.6), orange (<0.8), red (≥0.8). Staleness detection compares pressureTimestampMs against STALE_THRESHOLD_MS (5000 ms); stale state dims opacity to 0.55 and shows red Chip badge. Charts use Chart.js with custom y-axis tick/grid styling (zero line highlighted in amber, specific ticks at −10, −5, 0, 1). LoadingPlaceholder shown when pressureSeq ≤ 0. No network/DB/FS side effects; pure presentation.

- **Exports:** `CoreDrivesChart`, `ComplementDrivesChart`, `getBarColor`, `LoadingPlaceholder`, `StaleBadge`, `CORE_LEFT`, `CORE_RIGHT`, `COMPLEMENT_DRIVES`, `compOptions`, `horizontalPairOptions`, `STALE_THRESHOLD_MS`
- **Key constants:** `STALE_THRESHOLD_MS=5000`, `CANON range=[-10.0, 1.0]`, `relief threshold=0 (rgba teal)`, `low threshold=0.3 (rgba green)`, `medium threshold=0.6 (rgba amber)`, `high threshold=0.8 (rgba orange)`, `critical threshold>=0.8 (rgba red)`, `horizontalPairOptions.aspectRatio=2.5`, `compOptions.aspectRatio=4`, `horizontalPairOptions.afterFit.width=60`
- **Deps:** `../../store (useAppStore)`, `../../types (TelemetryPressure)`, `@mui/material (Box, CircularProgress, Typography, Chip)`, `chart.js (ChartJS, CategoryScale, LinearScale, BarElement, Tooltip, ChartOptions)`, `react-chartjs-2 (Bar)`
- **Gotchas:** No error handling for missing pressure data (defaults to 0); staleness logic duplicated in both components; zero-line highlighting assumes amber color constant across grid and ticks; no memoization of data/color arrays; chart re-renders on every store subscription even if pressure values unchanged.

#### DriveRadarChart.tsx
*component* — Displays 12-drive psychological pressure state as overlaid radar charts (core drives in green, complement drives in orange)

React FC that consumes useAppStore pressure object and renders a radar chart via chart.js. RADAR_DRIVES constant defines 12 drives (system_health, curiosity, moral_valence, anxiety, integrity, satisfaction, sadness, cognitive_awareness, focus, social, guilt, boredom) split into 4 core compass-point drives (health N, moral E, integrity S, cognitive W) and 8 complement drives interleaved. Pressure values clamped to [0,1], negative values forced to 0. Two overlapping datasets: coreValues (green, rgba 76/175/80) and compValues (orange, rgba 255/152/0). Shows loading spinner + "Waiting for drive data..." when pressureSeq <= 0. Staleness computed as pressureIsStale flag OR (timestamp exists AND now - timestamp > 5000ms); stale state dims chart opacity to 0.55 and adds red "Stale" chip at top-right. Radar scale min=0, max=1, stepSize=0.25 with 600ms easing animation.

- **Exports:** `DriveRadarChart`
- **Key constants:** `radarOptions.scales.r.min=0`, `radarOptions.scales.r.max=1`, `radarOptions.scales.r.ticks.stepSize=0.25`, `radarOptions.animation.duration=600`, `staleness threshold=5000ms`, `stale opacity=0.55`, `stale chip top=4px, right=4px`
- **Deps:** `../../store (useAppStore)`, `../../types (TelemetryPressure)`, `chart.js`, `react-chartjs-2 (Radar)`, `@mui/material (Box, CircularProgress, Typography, Chip)`
- **Gotchas:** Pressure object keys must match TelemetryPressure interface or default to 0; negative drive values silently clamped (no error). Staleness check hardcodes 5000ms; no configurability. Green and orange colors hardcoded in rgba form throughout (no shared constants). Loading state shows placeholder spinner only when pressureSeq is 0 (first-sync guard).

#### DrivesPanel.tsx
*component* — React component that displays and controls the 12-drive homeostatic pressure system (core and complement drives) with live telemetry, connection status, dynamic threshold, and optional override/drift controls.

DrivesPanel is the main export and top-level component that renders a two-section UI: (1) read-only telemetry showing CORE_DRIVES (system_health, moral_valence, integrity, cognitive_awareness) and COMPLEMENT_DRIVES (guilt, curiosity, boredom, anxiety, satisfaction, sadness, focus, social), each with a bidirectional bar visualization and numeric value; (2) collapsible Drive Controls section (when showControls is true) with per-drive override toggles, sliders [-10, 1], and drift-rate inputs [-0.1, 0.1 per second]. DriveRow renders read-only pressure bars using getDriveColor() to map values to a 5-color range (teal <0, green <0.3, amber <0.6, orange <0.8, red >=0.8). DriveControlRow renders editable inputs with a Switch, Slider, and TextField. The bar visualization uses a bidirectional layout with zero marked at 90.9% (10/11 units) from left, filling inward for relief (<0) and outward for pressure (>0). Component consumes useAppStore for pressure and dynamicThreshold, usePressureStatus for connection/stale state, and useDriveOverrides for override/drift state and handlers. Header displays connection status (live/offline icon + color), dynamic threshold value, and a TuneIcon button to toggle controls visibility.

- **Exports:** `DrivesPanel`
- **Key constants:** `CORE_DRIVES=[{key:system_health,label:System Health},{key:moral_valence,label:Moral Valence},{key:integrity,label:Integrity},{key:cognitive_awareness,label:Cog Awareness}]`, `COMPLEMENT_DRIVES=[{key:guilt,label:Guilt},{key:curiosity,label:Curiosity},{key:boredom,label:Boredom},{key:anxiety,label:Anxiety},{key:satisfaction,label:Satisfaction},{key:sadness,label:Sadness},{key:focus,label:Focus},{key:social,label:Social}]`, `getDriveColor color thresholds: <0 teal #00bcd4, <0.3 green #4caf50, <0.6 amber #ff9800, <0.8 orange #f57c00, >=0.8 red #f44336`, `RANGE=11 (CANON range -10.0 to 1.0)`, `ZERO_PCT=90.9% (10/11*100)`, `Slider range [-10, 1], step 0.01`, `Drift field range [-0.1, 0.1], step 0.001`
- **Deps:** `@mui/material (Box, Button, Collapse, Divider, IconButton, Slider, Switch, TextField, Tooltip, Typography)`, `@mui/icons-material (SignalWifiOffIcon, SignalWifi4BarIcon, RestartAltIcon, TuneIcon)`, `useAppStore`, `useDriveOverrides`, `usePressureStatus`, `TelemetryPressure type`
- **Gotchas:** No error handling for useAppStore or useDriveOverrides hook failures; assumes pressure/overrides always defined with fallback ?? 0; usePressureStatus.isStale logic not clear from component (assumed hook provides it); no explicit validation of drift rate bounds; handleResetAll button always enabled (disabled={false} hardcoded).

#### MiniDriveChart.tsx
*component* — Compact horizontal drive-pressure visualization for monitoring cognitive state

React FC that displays 12 drive pressure metrics (4 core: system_health, moral_valence, integrity, cognitive_awareness; 8 secondary) fetched from zustand AppStore. Each drive renders as a labeled bar with dynamic color-coding and tooltip. Pressure values are normalized from [-10,1] range to [0,1] for bar width using formula (raw+10)/11. Color palette: cyan <0, green [0,0.3), orange [0.3,0.6), dark-orange [0.6,0.8), red >=0.8. Shows placeholder 'Waiting for drive data...' when pressureSequenceNumber<=0. Core drives bold/higher contrast, secondary muted. 0.3s ease transition on bar width/color.

- **Exports:** `MiniDriveChart`
- **Key constants:** `DRIVES=[12 entries with keys/labels]`, `norm formula: (raw+10)/11`, `bar height: 6px`, `label width: 22px`, `gap: 3px`, `cyan rgba(0,188,212,0.8)`, `green rgba(76,175,80,0.8)`, `orange rgba(255,152,0,0.8)`, `dark-orange rgba(245,124,0,0.8)`, `red rgba(244,67,54,0.8)`, `transition: 0.3s ease`
- **Deps:** `@mui/material (Box, Typography, Tooltip)`, `../../store (useAppStore)`, `../../types (TelemetryPressure)`
- **Gotchas:** Normalization formula assumes raw values fit [-10,1] domain but does not validate input; bars clamp to [0,1] output range silently. No loading spinner, only text placeholder. TelemetryPressure type shape not verified in this file.

### `frontend/src/components/FEAgent/`

#### FEAgentPanel.tsx
*component* — Fixed floating chat panel for real-time Observatory Assistant queries against live Sylphie state

FEAgentPanel is a React FC that renders a collapsible fixed-position chat UI (bottom-right, z-index 1200) for querying Sylphie's current state, drives, and behavior. Integrates useFEAgentChat hook (which provides chat history, thinking flag, streamingText, handleSubmit), useTelemetryBuffer hook (getSnapshot), and useAutoScroll for chat scrolling. Gracefully hides entirely if isAvailable() returns false (VITE_ANTHROPIC_API_KEY unset). UI: collapsible header with icon+label+thinking spinner, expandable chat area with message history rendered as Chips (user messages blue, assistant gray), input TextField with Enter-to-send (Shift+Enter for newline), Send IconButton. Marked read-only in header; no persistence or state mutations.

- **Exports:** `FEAgentPanel`
- **Key constants:** `zIndex=1200`, `expandedWidth=400px`, `expandedMaxHeight=60vh`, `headerBgColor=#16213e`, `headerHoverBg=#1a2744`, `userChipBg=#e3f2fd`, `assistantChipBg=#f5f5f5`
- **Deps:** `../../services/feAgent (isAvailable)`, `../../hooks/useTelemetryBuffer`, `../../hooks/useFEAgentChat`, `../../hooks/useAutoScroll`
- **Gotchas:** Graceful degradation via isAvailable() gate (returns null if API key missing); no error handling for chat/streaming failures visible; streamingText UI assumes non-null content; chat array keyed by index (i) not message ID—unstable if list reorders

### `frontend/src/components/Graph/`

#### AmbientView.tsx
*component* — 3D force-directed graph visualization with interactive camera control and node highlighting

React functional component rendering an interactive 3D graph using react-force-graph-3d and THREE.js. Transforms GraphSnapshot data (nodes/edges) into ForceGraph format, computing node degrees and applying color/size by type and connectivity. Implements custom node rendering as scaled spheres (CoBeing=4x base, PrimitiveSymbol=2.5x, DriveCategory=2x, etc.) with degree-based scaling via sqrt formula (1+sqrt(degree)*0.25). Camera orbits automatically or responds to WASD keyboard input (A/D=rotate, W/S=zoom 40-600 units, Q/E=altitude). Hover highlights nodes with 1.4x scale and updates cursor. Uses ResizeObserver for responsive container sizing. Three.js material caching for performance. D3 force configuration: charge strength -15, link distance 20px, center strength 0.05. Warmup 100 ticks, cooldown 300, alpha decay 0.02, velocity decay 0.4.

- **Exports:** `default AmbientView`
- **Key constants:** `sphereGeo=THREE.SphereGeometry(0.5,8,8)`, `speed=1.8`, `charge=-15`, `linkDistance=20`, `centerStrength=0.05`, `warmupTicks=100`, `cooldownTicks=300`, `d3AlphaDecay=0.02`, `d3VelocityDecay=0.4`, `d3AlphaMin=0.005`, `linkOpacity=0.15`, `linkWidth=0.3`, `nodeRelSize=3`
- **Deps:** `useAppStore (from store)`, `NODE_TYPE_COLORS, DEFAULT_NODE_COLOR, nodeLabel from graphStyles`
- **Gotchas:** Material cache uses global Map, never cleared (potential memory leak if many colors added); hover node rescaling via scene.getObjectByName() can silently fail if object not found; no validation that graphData.nodes/edges exist before mapping (empty-state risk); keyboard listeners never removed if component unmounts during animation frame

#### ExplorerBreadcrumbs.tsx
*component* — Renders a vertical stack of breadcrumb chips displaying explorer navigation history

React.FC component ExplorerBreadcrumbs displays the explorerHistory array from app store as clickable breadcrumb Chips. Each entry shows label and nodeId; the last entry (current node) is non-clickable and highlighted with currentNodeType color, while earlier entries are clickable and trigger onNavigate callback. Uses NODE_TYPE_COLORS lookup with fallback DEFAULT_NODE_COLOR. Layout is vertical flex column with minimal gap (0.25). Styling: last item gets semi-transparent colored background with white text, previous items get dark background with muted text. All chips have border and small size.

- **Exports:** `ExplorerBreadcrumbs`
- **Key constants:** `fontSize: 0.6rem`, `height: 20`, `gap: 0.25`, `px: 0.5`, `alpha: 30 for last item bgcolor`, `alpha: 08/02 for border/hover`
- **Deps:** `@mui/material (Box, Chip)`, `../../store (useAppStore)`, `./graphStyles (NODE_TYPE_COLORS, DEFAULT_NODE_COLOR)`
- **Gotchas:** Early return null if explorerHistory.length === 0 (renders nothing). Last entry click handler is undefined, making it inert. Uses array index as key part, which is fragile if reordering occurs. No error handling if currentNodeType is missing from NODE_TYPE_COLORS.

#### ExplorerGraphPanel.tsx
*component* — Cytoscape-based graph visualization panel for exploring knowledge graph nodes and edges with interactive drilling

React.FC component that renders an interactive knowledge graph using Cytoscape + fCOSE layout algorithm. Maintains a Cytoscape instance ref, initializes event handlers (tap for inspect, double-tap for drilling), and updates graph rendering on data changes. Computes a fingerprint (node count, edge count, last node id, center node id) to detect meaningful graph updates. Maps GraphSnapshot nodes/edges to Cytoscape elements with confidence-based styling (confidence < 0.5 = 0.5 opacity). Applies edge opacity cascade (edges between low-confidence nodes dim to 0.1). Pins center node at origin (0, 0). Runs fCOSE layout with animationDuration 600ms, nodeRepulsion 30000, idealEdgeLength 150, numIter 2500, cooling factor 0.95.

- **Exports:** `ExplorerGraphPanel`
- **Key constants:** `CENTER_NODE_STYLE.selector='.center-node'`, `CENTER_NODE_STYLE.style['border-width']=4`, `CENTER_NODE_STYLE.style['border-color']='#FFFFFF'`, `CENTER_NODE_STYLE.style['border-opacity']=0.9`, `FCOSE_animationDuration=600`, `FCOSE_nodeRepulsion=30000`, `FCOSE_idealEdgeLength=150`, `FCOSE_numIter=2500`, `FCOSE_coolingFactor=0.95`, `FCOSE_minTemp=1.0`, `FCOSE_initialTemp=300`, `FCOSE_gravity=0.08`, `FCOSE_gravityRange=2.0`, `FCOSE_edgeElasticity=0.15`, `FCOSE_nestingFactor=0.1`, `FCOSE_nodeOverlap=30`, `FCOSE_padding=40`, `CONFIDENCE_THRESHOLD=0.5`, `LOW_CONFIDENCE_OPACITY=0.5`, `CASCADE_OPACITY=0.1`, `bgcolor='#1a1a2e'`
- **Deps:** `react`, `@mui/material`, `cytoscape`, `cytoscape-fcose`, `../../types (GraphSnapshot)`, `../../store (useAppStore)`, `./graphStyles (CYTOSCAPE_STYLES, nodeLabel)`
- **Gotchas:** fingerprint dependency array missing 'fingerprint' variable itself (line 155 eslint-disable-next-line suggests intentional); confidence dimming hardcoded to 0.5 threshold; edge cascade logic iterates all edges per render; center node pinning via fixedNodeConstraint may not persist across layout runs if node position is not re-locked

#### ExplorerSearchBar.tsx
*component* — Search bar with depth-of-exploration selector for graph node discovery

ExplorerSearchBar is a React FC accepting onNodeSelect callback. Uses useNodeSearch hook to drive autocomplete suggestions from input, renders Material-UI Autocomplete with custom option styling (node type chip + label). Displays a second row with depth buttons (1h/2h/3h) linked to explorerDepth store state; selected depth shows light blue highlight. Search field has placeholder "Search nodes...", loading spinner, and darkened theme (rgba backgrounds). NODE_TYPE_COLORS map provides per-type chip backgrounds; unmatched types fall to DEFAULT_NODE_COLOR. On selection, clears input and fires onNodeSelect(node_id, label).

- **Exports:** `ExplorerSearchBar`
- **Key constants:** `depth values=[1,2,3]`, `fontSize chip=0.55rem`, `fontSize label=0.75rem`, `box width=22px height=22px`, `gap spacing=0.75/0.5/0.25 units`
- **Deps:** `useNodeSearch`, `useAppStore`, `NODE_TYPE_COLORS`, `DEFAULT_NODE_COLOR`, `SearchNodeResult type`

#### ExplorerView.tsx
*component* — React component for interactive graph exploration UI with search, visualization, and navigation history

ExplorerView is a React functional component that renders an interactive graph explorer interface. It manages centerNodeId (selected node) and centerNodeType state; integrates useNeighborhood hook to fetch graph data at configurable depth via explorerDepth from app store; and uses useAppStore for history management. Renders ExplorerSearchBar for node search, ExplorerGraphPanel for graph visualization, and ExplorerBreadcrumbs for navigation history. Includes loading spinner overlay (24px CircularProgress, rgba(26,26,46,0.7) bg), empty state message when no node selected, and floating control panel (bottom-right, 220px width, rgba(10,14,23,0.85) bg with blur) displaying node/edge counts as Chips and truncation warning when neighborhood exceeds 500 nodes. Three key callbacks: handleNodeSelect updates center node and pushes history; handleDrill navigates on double-click; handleBreadcrumbNav pops history stack when breadcrumb clicked. Side effect: pushExplorerHistory called on node selection and drilling.

- **Exports:** `ExplorerView`
- **Key constants:** `500 (truncation cap)`, `220px (panel width)`, `12px (panel bottom/right offset)`, `0.85 (panel bg opacity)`, `12px (backdrop blur)`, `40px (empty state icon size)`
- **Deps:** `react`, `@mui/material`, `@mui/icons-material`, `../../store/useAppStore`, `../../hooks/useNeighborhood`, `./ExplorerSearchBar`, `./ExplorerGraphPanel`, `./ExplorerBreadcrumbs`
- **Gotchas:** No error boundary or error state handling for data fetch failures; loading state does not distinguish between initial load and refetch; no visual feedback for invalid nodes or search failures; breadcrumb navigation relies on direct store access (useAppStore.getState()) within callback rather than prop-driven; truncation warning shows only a count cap (500) with no indication of what was excluded or how to explore further

#### GraphPanel.tsx
*component* — Cytoscape knowledge graph visualization with provenance and schema-level filtering

GraphPanel is the main React component rendering a Cytoscape force-directed graph (fcose layout) of a knowledge graph with nodes and edges. It exports two components: GraphFilterBar (filter UI for provenance, schema level, node types, and search) and GraphPanel (the graph container). GraphPanel persists a Cytoscape instance across renders, computes a stable graphFingerprint (node count : edge count : last node ID) to avoid redundant layouts, and applies multi-level filters: confidence threshold (< 0.5 dims to 0.5 opacity), schema level (mismatches dim to 0.15), provenance type (mismatches dim to 0.15), node type blacklist (dims to 0.15), and search term (case-insensitive label/ID match, mismatches dim to 0.15). Synthetic edges (edge_type '_synthetic', confidence 0) connect isolated nodes to the CoBeing anchor for gravitational centering. The layout uses fcose with parameters: idealEdgeLength=400, nodeRepulsion=100000, nodeOverlap=50, edgeElasticity=0.1, gravity=0.02, numIter=5000, initialTemp=400, coolingFactor=0.95, minTemp=1.0. Node labels include confidence as a second line (N%). Tap-on-node opens inspector, tap-on-canvas closes it.

- **Exports:** `GraphPanel`
- **Key constants:** `PROVENANCE_OPTIONS=[all, SENSOR, GUARDIAN, LLM_GENERATED, INFERENCE, SYSTEM_BOOTSTRAP]`, `SCHEMA_LEVEL_OPTIONS=[all, instance, schema, meta_schema]`, `idealEdgeLength=400`, `nodeRepulsion=100000`, `nodeOverlap=50`, `gravity=0.02`, `numIter=5000`, `initialTemp=400`, `coolingFactor=0.95`, `minTemp=1.0`, `confidenceThreshold=0.5`, `dimmedNodeOpacity=0.15`, `lowConfidenceOpacity=0.5`
- **Deps:** `@mui/material (Box, Chip, Stack, Tooltip)`, `cytoscape`, `cytoscape-fcose`, `../../store (useAppStore)`, `../../types (ProvenanceFilter, SchemaLevel)`, `./graphStyles (PROVENANCE_COLORS, CYTOSCAPE_STYLES, nodeLabel)`
- **Gotchas:** eslint-disable-next-line react-hooks/exhaustive-deps on line 328 (graphFingerprint + graphFilters dependency array) — justifiable because graphData is accessed via useAppStore.getState() inside the effect rather than as a direct dependency, but worth monitoring. Synthetic edges created for unconnected nodes may cause unexpected graph morphology if edge count changes dramatically. No error handling for Cytoscape initialization or layout failures. CoBeing node lookup is exact type match; if missing, falls back to first node.

#### MiniGraphPanel.tsx
*component* — Compact Cytoscape visualization for OKG/SKG graphs with no store dependency or filter bar.

MiniGraphPanel is a React functional component that renders knowledge graphs using Cytoscape. It accepts a GraphSnapshot (nodes + edges), accentColor for theming, and emptyMessage for empty state. Initializes Cytoscape with cose layout (animate: false, nodeRepulsion 8000, idealEdgeLength 80, nodeOverlap 20). Applies styled selectors for node types (Person as 22px star with accentColor; CoBeing as 40px gold star; Attribute as 28x20px round-rectangle with 0.8 alpha). Edges use unbundled-bezier curves with triangle arrows; HAS_FACT edges are dashed at 0.56 alpha. Data updates via fingerprint memoization (hash of node count + edge count + last node ID) to avoid relayout on identical data. Empty state shows animated pulse dot + grid background overlay.

- **Exports:** `MiniGraphPanel`
- **Key constants:** `node width/height: 22px/36px/40px variants`, `text font-size: 9px-12px`, `nodeRepulsion: 8000`, `idealEdgeLength: 80`, `padding: 20`, `nodeOverlap: 20`, `backgroundColor: #1a1a2e`, `accentColor opacities: 0.38, 0.5, 0.56, 0.8`, `pulse animation: 2s ease-in-out infinite`
- **Deps:** `React`, `@mui/material (Box, Typography)`, `cytoscape`, `GraphSnapshot type`
- **Gotchas:** Fingerprint uses last node in array for identity hash — may miss reordered nodes with identical count/edges. Layout runs on every data update via fingerprint change; cose layout is non-deterministic. HAS_FACT edge styling is hardcoded dashed appearance. Empty state uses visibility:hidden rather than display:none to keep ref available.

#### NodeInspector.tsx
*component* — Right-side inspector drawer for inspecting selected knowledge graph nodes with full metadata, provenance, and connected edges.

React functional component rendering a MUI Drawer panel when nodeInspectorOpen is true. Displays selected node label, node_type, schema_level, provenance_type with color coding, and confidence score with retrieval threshold indicator. Includes a Properties table showing all node.properties as key-value pairs, a Connected Edges section with clickable ListItems that navigate to adjacent nodes (showing edge direction via forward/back arrows), and a Provenance & Meta table with color-dot provenance indicator, confidence with threshold warning, schema_level, created_at/updated_at timestamps. useMemo optimizes edge filtering to avoid recalc on every render. getNodeLabel helper resolves display name from label, properties.name, properties.value_repr, or node_id fallback. getSchemaLevelColor maps 3-level KG schema (instance/schema/meta_schema) to MUI chip colors.

- **Exports:** `NodeInspector`
- **Key constants:** `RETRIEVAL_THRESHOLD=0.5`
- **Deps:** `useAppStore`
- **Gotchas:** Confidence display uses threshold of 0.5 (50%) for retrieval usability; below threshold triggers warning icon and disables retrieval. Properties table blindly JSON.stringify objects. No validation that selectedNode matches graphData nodes. Drawer always renders when open but returns null if selectedNode not found (defensive).

#### WkgViewSwitcher.tsx
*component* — Tab-style switcher for selecting between ambient and explorer working-knowledge graph view modes.

WkgViewSwitcher is a React FC that renders a fixed-position button group in the top-left of the graph view (position absolute, top/left 8px, zIndex 10). It displays two modes: 'ambient' and 'explorer' as labeled tabs. The component reads wkgViewMode from useAppStore and calls setWkgViewMode when a tab is clicked. Active tab shows light-blue background (rgba(100,181,246,0.18)) and bright text (#64B5F6); inactive tabs are transparent with low-opacity white text (rgba(255,255,255,0.35)). Hover state brightens both active and inactive tabs. The container has a dark semi-transparent background (rgba(0,0,0,0.5)) with 4px blur backdrop filter and 2px padding.

- **Exports:** `WkgViewSwitcher`
- **Key constants:** `zIndex=10`, `top=8px`, `left=8px`, `blur=4px`, `activeColor=#64B5F6`, `inactiveColor=rgba(255,255,255,0.35)`, `fontSizeSm=0.6rem`, `fontWeightBold=600`
- **Deps:** `../../store (useAppStore)`, `../../types (WkgViewMode type)`, `@mui/material (Box, Typography)`

#### graphStyles.ts
*util* — Cytoscape graph styling: node/edge color schemes, label extraction logic, and shared visual stylesheet for knowledge graph visualization.

Exports three main artifacts: (1) PROVENANCE_COLORS — 5 provenance type→hex color mappings (SENSOR=#2196F3, GUARDIAN=#FFD700, LLM_GENERATED=#9C27B0, INFERENCE=#009688, SYSTEM_BOOTSTRAP=#607D8B); (2) NODE_TYPE_COLORS — 14 node type→hex color mappings for semantic nodes (PhraseNode, WordNode, ActionProcedure, etc.); (3) nodeLabel() — type-specific label extraction with fallback chains (e.g., PhraseNode→normalized_text or raw_texts[0] or node_id; WordSenseNode→spelling:sense_tag format). CYTOSCAPE_STYLES exports 60+ stylesheet rules covering base node/edge style, schema-level overrides (instance/schema/meta_schema), 13 node-type visual rules (shape, size, color, font per type), provenance border rings (colored 2.5px borders), 33 edge-type line-style rules (dotted/dashed/solid, width 0.8-2.5px, arrows), and _synthetic gravity edges (invisible width=0). Deep styling detail: PhraseNode 50×32px round-rectangle bold; CoBeing 52px star with 2px border; PrimitiveSymbol and grammar-nodes use pentagon/neon colors. Default fallback: ellipse 28px.

- **Exports:** `PROVENANCE_COLORS`, `NODE_TYPE_COLORS`, `DEFAULT_NODE_COLOR`, `nodeLabel`, `CYTOSCAPE_STYLES`
- **Key constants:** `SENSOR=#2196F3`, `GUARDIAN=#FFD700`, `LLM_GENERATED=#9C27B0`, `INFERENCE=#009688`, `SYSTEM_BOOTSTRAP=#607D8B`, `DEFAULT_NODE_COLOR=#7986CB`, `edge base width=0.8px`, `edge opacity=0.65`, `text-max-width=100px`
- **Deps:** `cytoscape type import`
- **Gotchas:** No imports from first-party code, pure styling constant; nodeLabel() has 15 type cases plus 4 id-prefix fallbacks (grounding-failure, drive-category, rule, meta) — maintainability risk if new node types added without updating label extraction

### `frontend/src/components/InnerMonologue/`

#### InnerMonologuePanel.tsx
*component* — Display live telemetry event stream from TimescaleDB with expandable raw JSON payloads

InnerMonologuePanel is a React FC that renders a scrollable list of inner-monologue telemetry events from the app store, auto-scrolling to the latest. MonologueEntry subcomponent renders each event with a formatted timestamp (HH:mm:ss), episode_id prefix (first 8 chars), and collapsible raw JSON payload. formatTimestamp helper converts ISO strings to HH:mm:ss locale format or returns raw on parse error. Each entry is clickable if it has a rawPayload; clicking toggles a Collapse box showing pretty-printed JSON (or raw text if unparseable). Panel shows 'Waiting for telemetry events...' when empty. Uses useAppStore to fetch innerMonologue array and useAutoScroll hook to keep container pinned to bottom on new entries.

- **Exports:** `InnerMonologuePanel`
- **Deps:** `useAppStore`, `InnerMonologueEntry type`, `useAutoScroll hook`
- **Gotchas:** Key uses array index (key=i) instead of stable ID; potential perf issue on list reorder. rawPayload JSON parsing silently falls back to raw text on error. No truncation of large payloads; could cause scroll lag.

### `frontend/src/components/Layout/`

#### SessionInfo.tsx
*component* — Collapsible session metrics bar displaying cost, graph changes, node count, and conversation turns

React functional component that renders a Material-UI Collapse wrapper containing a Paper with a 4-column Grid layout. Displays session_cost_usd (formatted to 2 decimals), graph_changes count, total nodes all-time, and conversation_turns. All metrics sourced from useAppStore hooks (sessionStats, graphStats, sessionInfoExpanded). Styled with dark theme (#0f3460 background, white text). Toggled visibility controlled by sessionInfoExpanded state from app store.

- **Exports:** `SessionInfo`
- **Key constants:** `bgcolor=#0f3460`, `elevation=1`, `padding=2`, `spacing=3`, `xs=3 (4-column grid)`
- **Deps:** `../../store (useAppStore)`, `@mui/material (Collapse, Paper, Grid, Typography, Box)`

#### TopBar.tsx
*component* — Top navigation bar displaying session status, connection indicators, and action buttons for Observatory, Supervisor, and Skills panel.

TopBar is a header component that renders the Sylphie app title, elapsed session time, and real-time status indicators for five subsystems (Graph, Chat, Telemetry, Audio, Video). It includes a reusable StatusDot subcomponent that maps WebSocket/capability states to colored Chip badges (green=connected, yellow=reconnecting, red=disconnected). The component displays live graph statistics (node/edge count) and three action buttons: Observatory (insights), Supervisor (cognitive), and Skills panel toggle. Uses Material-UI AppBar with dark theme (#16213e). All button callbacks are optional props, allowing parent control over modal/panel opening.

- **Exports:** `TopBar`
- **Key constants:** `bgcolor=#16213e`
- **Deps:** `../../store (useAppStore)`, `../../hooks/useSessionTimer`, `../../types (WSState)`, `@mui/material`, `@mui/icons-material`
- **Gotchas:** Audio/Video status derived from capability flags (voiceState.available, cameraState.active) rather than WebSocket state; no error handling for missing store/hook; onOpenObservatory and onOpenSupervisor callbacks are optional and may be undefined

### `frontend/src/components/MaintenanceLogs/`

#### MaintenanceLogsPanel.tsx
*component* — React component that displays maintenance_cycle telemetry events from the shared WebSocket stream in the observatory dashboard.

MaintenanceLogsPanel is a functional React component (React.FC) that filters innerMonologue entries to display only maintenance_cycle events from the telemetry WebSocket stream. It parses maintenance entries with format "maintenance_cycle: jobs_run=N committed=N phrase_consolidation=true/false", extracting job count, commit count, and phrase consolidation status. Level determination: 'info' if committed > 0, otherwise 'warn'. Component subscribes to innerMonologue and wsState.telemetry from the app store, auto-scrolls when new rows appear, and renders entries with HH:MM:SS timestamps, level-colored text (info=#81C784, warn=#FFB74D, error=#EF5350), and connection status indicator. useAutoScroll hook triggers on maintenanceRows.length change. Side effect: reads store state; displays live/disconnected indicator.

- **Exports:** `MaintenanceLogsPanel`
- **Key constants:** `LEVEL_COLORS={info:'#81C784',warn:'#FFB74D',error:'#EF5350'}`, `fontFamily:'JetBrains Mono, Fira Code, Consolas, monospace'`, `fontSize:11px`, `scrollbar width:6px`, `timestamp slice:[11,19]`
- **Deps:** `React`, `@mui/material (Box, Typography)`, `../../store (useAppStore)`, `../../hooks/useAutoScroll`
- **Gotchas:** Timestamp property initialized empty in parseMaintenanceEntry, populated after in useMemo map — potential for stale timestamps if called outside memo. Raw parsing with regex has no error handling if format doesn't match pattern (returns 0 for jobs_run/committed, false for phrase_consolidation). Component relies entirely on pre-routed maintenance_cycle entries; separate WebSocket connection was removed and consolidated into shared telemetry stream.

### `frontend/src/components/Metrics/`

#### MetricsPanel.tsx
*component* — Dashboard panels displaying executor state, drive engine metrics, recent actions, and prediction accuracy in real-time.

Exports four React FC components: ExecutorStatePanel (shows executor state with color-coded status dot, current category/action, confidence, transition count, dynamic threshold via useAppStore), DriveEnginePanel (displays pressure sequence, timestamp, staleness flag, total pressure, fill ratio), RecentActionsPanel (scrollable list of last 20 action history entries with confidence chips and relative timestamps), PredictionAccuracyPanel (scrollable list of last 20 prediction history entries with accuracy-derived error percentage and color-coded severity chips). Also exports deprecated MetricsPanel barrel component that combines all four. Includes stateColors map with 6 executor states: idle (transparent white), categorizing (blue), executing (green), observing (orange), learning (purple), cooling_down (slate). Utility formatRelativeTime converts Unix timestamp to human-readable relative time (seconds/minutes/hours ago). SectionLabel and MetricRow are internal UI helper components for consistent styling (monospace fonts, small caps typography, muted text colors).

- **Exports:** `ExecutorStatePanel`, `DriveEnginePanel`, `RecentActionsPanel`, `PredictionAccuracyPanel`, `MetricsPanel`
- **Key constants:** `stateColors map with 6 state keys`, `monospace font size 0.65rem for labels`, `confidence toFixed(3)`, `totalPressure and fillRatio calculated from pressure object values`, `actionHistory/predictionHistory sliced to top 20 entries`, `accuracy error percentage calculated as (1 - entry.accuracy) * 100`
- **Deps:** `@mui/material (Box, Typography, Chip, List, ListItem, ListItemText)`, `@mui/icons-material (CircleIcon)`, `../../store (useAppStore)`
- **Gotchas:** MetricsPanel is marked @deprecated in favor of using four individual panels; time formatting uses Date.now() / 1000 (Unix seconds, matches incoming timestamps); fill ratio calculated only when pressureValues.length > 0 to avoid division by zero; prediction accuracy colored by error threshold (>70% red, >40% warning, <40% success); ListItem keys use array index 'i' which is fragile if list order changes

### `frontend/src/components/Navigation/`

#### Sidebar.tsx
*component* — Main navigation sidebar with drive-state visualization and session controls

Exports Sidebar component (main nav panel) and SIDEBAR_WIDTH constant (232px). Renders a dark sidebar with brand header, navigation menu (Knowledge Graphs, Analytics, Chat, Codebase, Guardian), supervisor button, session vitals (elapsed time, graph stats, executor state), and reset/logout controls. Features animated PulseRibbon (2px right edge gradient) that responds to drive pressure and executor state via DRIVE_HUE_MAP (curiosity→210°, anxiety→20°, satisfaction→140°, etc.) and EXECUTOR_PULSE_SPEED (idle→4s, executing→1.2s). NavItem subcomponent provides route-aware links with HSL-driven accent glows. StatusMicro shows 3-dot connection status (WKG/Chat/Telemetry). Handles guardian-only Reset Sylphie button that POSTs to /api/skills/reset and refreshes graph state from /api/graph/snapshot. Logout clears auth and navigates to root.

- **Exports:** `Sidebar`, `SIDEBAR_WIDTH`
- **Key constants:** `SIDEBAR_WIDTH=232`, `DRIVE_HUE_MAP={curiosity:210, focus:220, social:200, anxiety:20, guilt:10, sadness:240, boredom:50, satisfaction:140, system_health:160, moral_valence:45, integrity:170, cognitive_awareness:190}`, `EXECUTOR_PULSE_SPEED={idle:'4s', categorizing:'2s', executing:'1.2s', observing:'2.5s', learning:'1.8s', cooling_down:'3.5s'}`
- **Deps:** `useAppStore`, `useSupervisorStore`, `useSessionTimer`, `react-router-dom`, `@mui/material`, `@mui/icons-material`
- **Gotchas:** Reset handler silently fails on error (catch block has no logging). Sidebar width is hardcoded constant exported for DashboardLayout offset calculation. Drive hue defaults to 160 if key not found in map. Reset dialog confirms destructive action but provides no rollback mechanism — documented as irreversible.

### `frontend/src/components/Observatory/`

#### ObservatoryDashboard.tsx
*component* — Multi-panel dashboard displaying Sylphie's cognitive and behavioral metrics across sessions in real-time.

Exports ObservatoryPanel (main component) that renders 8 data sections: Experiential Provenance Ratio (green/amber/red threshold at 0.6/0.3), Developmental Stage (4-stage progression tracker), Vocabulary Growth (cumulative phrase nodes + guardian-provided count bars), Drive Evolution (12×N heatmap blue-white-red by pressure 0.0-1.0), Action Diversity (unique action type bar), Phrase Recognition Ratio (0.0-1.0), Comprehension Accuracy (1-MAE bars), Session Comparison (table with duration/cycles/pressure/phrases). Includes 5 pure-display subcomponents: BarChart (SVG bars, 8-40px width, 600px max), DriveHeatmap (hardcoded 12 drive names with heatColor diverging colormap), StageIndicator (STAGE_ORDER=['pre-autonomy','emerging','consolidating','autonomous']), ProvenanceDisplay (ratio color: >=0.6=#81c784, >=0.3=#ffb74d, else #e57373), Section/Caption/NoData (styling wrappers). Main component fetches via useObservatoryData hook (7 data arrays + 1 object), renders loading spinner (24px), error message, or empty state until hasData=true. No DB/network writes; pure visualization.

- **Exports:** `ObservatoryPanel`
- **Key constants:** `STAGE_ORDER=['pre-autonomy','emerging','consolidating','autonomous']`, `STAGE_LABELS record`, `barWidth max 40px min 8px`, `cellSize=28 in DriveHeatmap`, `driveNames=['system_health','moral_valence','integrity','cognitive_awareness','guilt','curiosity','boredom','anxiety','satisfaction','sadness','focus','social']`, `heatColor thresholds: v<=0.5 blue→white (r:66+189t, g:133+122t, b:244-244t), v>0.5 white→red (r:255, g:255-186t, b:0)`, `provenance color thresholds: >=0.6 green #81c784, >=0.3 amber #ffb74d, <0.3 red #e57373`
- **Deps:** `useObservatoryData from ../../hooks/useObservatoryData`, `@mui/material (Box,Typography,IconButton,Chip,CircularProgress,Table*,Tooltip)`, `@mui/icons-material (Refresh,TrendingUp)`
- **Gotchas:** DriveHeatmap hard-codes 12 drive names in parallel arrays (driveNames/driveLabels); mismatch risks silent misalignment. HeatColor diverging gradient has hand-tuned RGB ranges (66,133,244 for blue; 255,255,0 for red) — color accuracy depends on exact arithmetic. Null/undefined guards scattered (d.drives[drive]??0, s.duration_seconds!==undefined?format:'-') suggest upstream data volatility. BarChart labels only render if data.length<=15 (readability safeguard). ProvenanceDisplay shows empty state only if totalUtterances===0; other sections show NoData when array length 0. SVG viewBox in BarChart clamps to 600px max but could overflow if many bars; no horizontal scroll enforced. Session table maxHeight=220px hardcoded.

### `frontend/src/components/Skills/`

#### SkillManager.tsx
*component* — UI drawer panel for resetting the World Knowledge Graph with confirmation dialog

Exports SkillManager, a React FC that renders a right-anchored Drawer (420px wide) containing a World Knowledge Graph reset control panel. Internally manages confirmOpen state to show/hide a confirmation Dialog. Uses useAppStore to get skillPanelOpen and toggleSkillPanel, and useSkillPackages hook to access isResetting, resetStatus, clearStatus, and resetGraph function. The component displays an Alert when resetStatus is present, a description of the reset action, and a full-width error-colored Button that triggers the confirmation dialog. The Dialog lists what will happen on reset: deletion of all nodes/edges and re-bootstrap with 1 anchor node (CoBeing/Sylphie) and 12 drive nodes (core + complement). On confirmation, calls resetGraph() which presumably triggers an async reset operation. LinearProgress bar shown during reset.

- **Exports:** `SkillManager`
- **Key constants:** `drawerWidth=420`, `dialogMaxWidth=sm`
- **Deps:** `useAppStore`, `useSkillPackages`
- **Gotchas:** resetGraph is awaited but no error handling visible; confirmation dialog description mentions "permanent delete" but actual deletion logic is in the hook; isResetting disables button but state flow depends entirely on hook implementation

### `frontend/src/components/Supervisor/`

#### SupervisorPanel.tsx
*component* — Full supervisor dialog with Live Feed and Controls tabs, opened from Dashboard TopBar.

SupervisorPanel is a Material-UI Dialog component that displays supervisor status and controls. It contains two tabs: LiveFeedTab shows recentVerdicts from store with auto-scroll to newest, clear function, and flagged count; ControlsTab allows toggling supervisor enabled/disabled state, adjusting sampleRate (1-100%) via slider, toggling burstMode (supervise all cycles), viewing budgetUsedToday/budgetRemaining as a colored budget bar (red >= 90%, orange >= 70%, green < 70%), and disabled Freeze/Rollback intervention buttons marked Coming Soon. Helper components: Section wraps content with dark background styling; BudgetBar shows usage percentage with color-coded bar. On panel open, fetches /api/supervisor/status and syncs to store via setStatus. All POST operations (enable/disable/policy changes) fetch from /api/supervisor/* endpoints and refresh status. useSupervisorWebSocket() starts WebSocket connection for live verdict streaming.

- **Exports:** `SupervisorPanel`
- **Key constants:** `barColor thresholds: 90%=#EF5350 (red), 70%=#FFB74D (orange), else #66BB6A (green)`, `sliderRange: min=1, max=100, step=1`, `dialogHeight: 75vh`, `backgroundColor: #1a1a2e`
- **Deps:** `useSupervisorStore`, `useSupervisorWebSocket`, `VerdictCard`
- **Gotchas:** Interventions (Freeze/Rollback buttons) are disabled stubs with Coming Soon tooltips; WebSocket connection always starts regardless of panel open state (useEffect at top level calls useSupervisorWebSocket() unconditionally); status polling only happens when open=true but WebSocket runs always; no error boundary for fetch failures beyond console.warn.

#### VerdictCard.tsx
*component* — Display supervisor verdict with color-coded rating, confidence bar, token cost, and optional guardian flag

React functional component that renders a single SupervisorVerdict from supervisor state. Maps verdict.rating (good/acceptable/questionable/wrong) to color-coded border and chip (success/warning/default/error). Displays timestamp formatted to HH:MM:SS, confidence as percentage with animated progress bar, input/output token counts in tooltip, reasoning text, optional flagForGuardian banner with WarningIcon and custom flagReason text, and cycleId footer. Key thresholds: border colors (good=#66BB6A, acceptable=#FFB74D, questionable=#FF8A65, wrong=#EF5350), confidence bar height=4px, card padding=1, left border=3px. QUESTIONABLE_CHIP_SX uses manual rgba(255,138,101,0.2) bgcolor since MUI lacks native orange variant.

- **Exports:** `VerdictCard`
- **Key constants:** `RATING_COLORS.good.border=#66BB6A`, `RATING_COLORS.acceptable.border=#FFB74D`, `RATING_COLORS.questionable.border=#FF8A65`, `RATING_COLORS.wrong.border=#EF5350`, `QUESTIONABLE_CHIP_SX.bgcolor=rgba(255,138,101,0.2)`, `confidence_bar_height=4px`
- **Deps:** `@mui/material (Box, Chip, Typography, Tooltip)`, `@mui/icons-material (Warning)`, `../../store/supervisorSlice (SupervisorVerdict, VerdictRating)`
- **Gotchas:** verdict.flagReason falls back to hardcoded 'Flagged for guardian review' if undefined; no error handling for invalid verdict.rating enum (defaults to questionable); timestamp conversion assumes verdict.timestamp is valid ISO-8601 parseable date; no loading/error states

### `frontend/src/components/SystemLogs/`

#### SystemLogsPanel.tsx
*component* — Displays filtered system logs with real-time telemetry in a scrollable panel

React FC that renders a scrollable log viewer with toggle filters (all/warn+/error). Pulls systemLogs from useAppStore and filters by level. Displays entries with HH:MM:SS timestamp (sliced from ISO string at chars 11-19) and colored text per level (info=#81C784, warn=#FFB74D, error=#EF5350). Uses useAutoScroll hook to auto-scroll on new entries. Shows count badge (current/max) and empty state ('Waiting for telemetry...' or 'No entries match filter'). Fixed max retention of 200 entries (MAX_ENTRIES constant, matches store slice cap). Hover effect adds subtle bg highlight. Monospace JetBrains/Fira font, dark theme (#0d1117 bg). No network/DB writes; read-only consumer of store state.

- **Exports:** `SystemLogsPanel`
- **Key constants:** `MAX_ENTRIES=200`, `LEVEL_COLORS={info:#81C784, warn:#FFB74D, error:#EF5350}`, `LevelFilter='all'\|'warn'\|'error'`
- **Deps:** `../../store (useAppStore, SystemLogEntry type)`, `../../hooks/useAutoScroll`
- **Gotchas:** Entry key uses array index (i) instead of stable ID — reorders/duplicates could cause React keying issues if log entries are modified in-place

### `frontend/src/hooks/`

#### useAudioStream.ts
*hook* — React hook for streaming microphone audio over WebSocket to backend STT (Deepgram), returning live transcript and MediaStream for visualization.

Exports useAudioStream() hook and TranscriptionEvent interface. Captures microphone via getUserMedia(), encodes as Opus/WebM via MediaRecorder, and streams binary chunks over WebSocket to /ws/audio endpoint at 250ms intervals (TIMESLICE_MS). Listens for JSON messages from backend: transcription (interim text update), utterance_complete (final utterance dispatched as CustomEvent sylphie:voice_text), and restart_audio (recreates MediaRecorder on Deepgram reconnect). Maintains refs for WebSocket, MediaRecorder, and MediaStream; exposes stream (for FFT visualization) and transcript (live interim text). Exports WS_BASE (auto-detected wss:/https: protocol and host), TranscriptionEvent interface (text, is_final, confidence, speech_final). Notable algorithm: graceful stream continuation if WebSocket drops (recorder stops but stream lives for visualization); handles cancellation via boolean flag during async startup.

- **Exports:** `useAudioStream`, `UseAudioStreamReturn`, `TranscriptionEvent`
- **Key constants:** `WS_PROTOCOL (auto-detect https: vs ws:)`, `WS_BASE (protocol + host)`, `TIMESLICE_MS=250`
- **Deps:** `React (useEffect, useRef, useState, useCallback)`, `../store (useAppStore)`
- **Gotchas:** Edge case: WebSocket closed before cleanup fires — stream continues for visualization but recorder stopped (intentional design to preserve FFT). No explicit error recovery if MediaRecorder.start() fails post-reconnect. CustomEvent dispatch sylphie:voice_text lacks consumer validation — assumes window listener exists. mimeType negotiation prefers audio/webm;codecs=opus but falls back to audio/webm; backend codec handling must match or decode fails silently.

#### useAutoScroll.ts
*hook* — React hook that auto-scrolls a container to the bottom when dependencies change.

Exports useAutoScroll(), a custom React hook that accepts a ref to an HTMLElement, a dependency array, and optional scroll behavior settings. On effect trigger, checks if the element's scrollHeight exceeds clientHeight (overflow condition) and if true, sets scrollTop to scrollHeight to scroll to bottom. Uses 'smooth' as default scroll behavior, read from options but explicitly voided to satisfy noUnusedLocals lint. Intentionally avoids scrollIntoView() because it would scroll the entire page rather than just the container. Uses eslint-disable-line comment to suppress exhaustive-deps warning.

- **Exports:** `useAutoScroll`
- **Key constants:** `behavior='smooth'`
- **Gotchas:** behavior parameter is read but not actually used in the scroll operation (line 29 voids it for lint purposes); dependency array uses eslint-disable which bypasses React hooks rules; scrollIntoView explicitly avoided in favor of manual scrollTop assignment to prevent page-level scrolling

#### useDevMode.ts
*hook* — Check if the app is running in development or production mode via build-time env variable

Exports a single React hook useDevMode() that returns a boolean. Reads VITE_APP_MODE from Vite's import.meta.env at runtime (set at build time). Returns true if VITE_APP_MODE is not exactly 'production', false otherwise. Used to conditionally enable dev-only features and UI. No side effects; pure boolean derivation from environment.

- **Exports:** `useDevMode`
- **Key constants:** `VITE_APP_MODE from import.meta.env`
- **Gotchas:** Relies on Vite build-time env injection; any typo in VITE_APP_MODE or unexpected value will incorrectly enable dev mode. No fallback if env is undefined.

#### useDriveOverrides.ts
*hook* — React hook for managing drive pressure override state and API synchronization

Exports useDriveOverrides() hook that tracks three independent state records (overrides: boolean flags, overrideValues: numeric values, driftRates: numeric rates) and exposes four mutation handlers (toggle, set value, set drift rate, reset all). handleOverrideToggle posts immediately to /api/drives/override with drive key and active boolean; handleOverrideValue and handleDriftChange use debouncedPost() with 300ms debounce to batch writes. handleResetAll POSTs to /api/drives/reset and clears all local state on success. The hook maintains a debounce timer ref to avoid overlapping requests per key and cleans up on unmount. anyOverrideActive computed as boolean OR-reduce of overrides dict.

- **Exports:** `useDriveOverrides`
- **Key constants:** `DEBOUNCE_MS=300`
- **Deps:** `../store (useAppStore)`, `../types (TelemetryPressure)`
- **Gotchas:** handleOverrideToggle uses overrideValues and pressure as deps but never sets overrideValues when disabled (sets to 0 locally but doesn't update state before POST); error handling is silent console.error only, no user feedback or retry logic for failed API calls; debouncedPost never validates response status.

#### useFEAgentChat.ts
*hook* — React hook for managing FE agent chat state and message submission

Exports useFEAgentChat(getSnapshot) hook that manages a chat history (ChatEntry[] with role/content), thinking state, and streamingText. handleSubmit(question) validates non-empty input, appends user message to chat, calls askFEAgent with the question, last 6 chat entries as history, and a streaming callback. On success appends full assistant response to chat; on error appends error message. Returns {chat, thinking, streamingText, handleSubmit} for UI binding. Uses React useState and useCallback; dependencies include thinking and chat array.

- **Exports:** `useFEAgentChat`, `ChatEntry`, `UseFEAgentChatReturn`
- **Key constants:** `6 (chat history window)`
- **Deps:** `../services/feAgent`
- **Gotchas:** Chat history window hardcoded to last 6 entries; no persistent storage; error handling swallows unknown error types with generic message; getSnapshot() called fresh per submission without validation

#### useKgSnapshot.ts
*hook* — Polling hooks for OKG, SKG, and PKG graph snapshots from backend REST endpoints and storing data in app store.

Three exported hooks: useOkgSnapshot() and useSkgSnapshot() each poll their respective graph endpoints every 10s (POLL_INTERVAL_MS = 10_000), fetch JSON via /api/graph/okg and /api/graph/skg respectively, and store data + stats (nodes/edges count) in app store via setOkgData/setSkgData. usePkgSnapshot() polls /api/graph/pkg every 30s (PKG_POLL_INTERVAL_MS = 30_000) with lower frequency because codebase structure changes rarely at runtime. All three hooks use useEffect to initialize a fetch on mount and set up window.setInterval, cleaning up the interval on unmount via timerRef. Errors silently fail with try-catch; fetch early-returns if response !ok.

- **Exports:** `useOkgSnapshot`, `useSkgSnapshot`, `usePkgSnapshot`
- **Key constants:** `POLL_INTERVAL_MS=10000`, `PKG_POLL_INTERVAL_MS=30000`
- **Deps:** `../store`
- **Gotchas:** Silent error handling may mask backend availability issues; no retry logic or exponential backoff; OKG/SKG polling interval (10s) may cause unnecessary network load if data rarely changes

#### useNeighborhood.ts
*hook* — Fetch and manage graph neighborhood data for a selected node at N hops distance

Exports useNeighborhood(nodeId, hops) → NeighborhoodState. Fetches graph snapshot from /api/graph/wkg/neighborhood endpoint, tracks loading and truncation status. Uses AbortController to cancel in-flight requests on dependency change or unmount. Debounces rapid requests with 150ms setTimeout. Returns {data: GraphSnapshot | null, loading: boolean, truncated: boolean}. GraphSnapshot contains nodes and edges arrays. Handles fetch errors silently except AbortError, clears state on error or missing nodeId.

- **Exports:** `useNeighborhood`, `NeighborhoodState`
- **Key constants:** `debounce_delay=150`
- **Deps:** `../types (GraphSnapshot)`
- **Gotchas:** Silent error handling (setState to null/false on non-AbortError) may mask real failures. No retry logic. truncated field defaults to false if missing from response.

#### useNodeSearch.ts
*hook* — React hook for debounced WKG node search with request cancellation

Exports useNodeSearch(query: string) which maintains search results and loading state via useState. Implements request debouncing (300ms delay) and abortion of in-flight requests via AbortController when the query changes. Fetches from /api/graph/wkg/search with encodeURIComponent-escaped query and limit=8. Returns early if query.trim().length < 2. Catches errors (ignoring AbortErrors) and sets results to empty on failure. Cleanup function cancels pending setTimeout and aborts the controller on unmount/query change.

- **Exports:** `useNodeSearch`
- **Key constants:** `limit=8`, `debounce=300ms`, `minQueryLength=2`
- **Deps:** `../types (SearchNodeResult)`
- **Gotchas:** fetch error handling silently empties results on non-AbortError; AbortErrors suppressed (intended behavior for cancellations); no explicit error state exposed to caller

#### useObservatoryAlerts.ts
*hook* — React hook that polls health metrics and derives CANON attractor-state alerts

Exports useObservatoryAlerts hook that polls /api/metrics/health (or falls back from /api/metrics/observatory/alerts) every 15s (configurable) and derives 6 CANON attractor alerts: (1) Type 2 Addict when Type1Type2Ratio < 0.1, risk_score = 1.0 - ratio*10; (2) Rule Drift when ProvenanceRatio trend declining; (3) Hallucinated Knowledge when ProvenanceRatio < 0.4, risk_score = (0.4 - value)/0.4; (4) Depressive Attractor when GuardianResponseRate < 0.2 AND declining, risk_score = (0.2 - value)/0.2; (5) Planning Runaway when PredictionMAE > 0.5, risk_score = min(1.0, (mae - 0.5)/0.5); (6) Prediction Pessimist when PredictionMAE > 0.3 AND GuardianResponseRate < 0.3, combined score from both metrics. Returns alerts array, reachable boolean, dismissed Set, and dismiss callback. Gracefully handles unreachable endpoints.

- **Exports:** `useObservatoryAlerts`, `AttractorAlert`
- **Key constants:** `pollIntervalMs=15_000`, `Type2Addict threshold=0.1`, `RuleDrift provenance declining`, `HallucinatedKnowledge threshold=0.4`, `DepressiveAttractor threshold=0.2`, `PlanningRunaway threshold=0.5`, `PredictionPessimist mae_threshold=0.3, response_threshold=0.3`
- **Deps:** `react (useState, useEffect, useCallback)`
- **Gotchas:** Dedicated /api/metrics/observatory/alerts endpoint is noted as future-sprint feature but not yet implemented; currently always falls back to deriving from /api/metrics/health. Dismiss callback creates new Set on each call which could trigger renders; dismissed state is tracked but never filtered from alerts display.

#### useObservatoryData.ts
*hook* — React hook fetching and adapting Sylphie observatory metrics for dashboard consumption

useObservatoryData() is a React hook that fetches 7 metrics endpoints from /api/metrics/observatory/* (vocabulary-growth, drive-evolution, action-diversity, developmental-stage, session-comparison, comprehension-accuracy, phrase-recognition) via Vite proxy, adapts raw Sylphie response shapes into dashboard-compatible interfaces, and returns typed state + fetchAll callback. Each endpoint fails independently with fallback empty objects. Adapters map Sylphie's daily/session granularity (e.g., cumulativeTotal → phrase_nodes, MAE inverted to avg_confidence as Math.max(0, Math.min(1, 1 - s.mae)), GUARDIAN provenance as can_produce_count proxy). ExperientialProvenance ratio = (SENSOR + GUARDIAN + INFERENCE) / totalUtterances, clamped to 0–1. hasData boolean checks if any metric has content.

- **Exports:** `useObservatoryData`, `VocabEntry`, `DriveEntry`, `ActionEntry`, `DevStage`, `SessionEntry`, `ComprehensionEntry`, `PhraseRatioEntry`, `ExperientialProvenance`
- **Key constants:** `EMPTY_VOCAB_RESPONSE={days:[]}`, `EMPTY_DRIVE_RESPONSE={sessions:[]}`, `EMPTY_ACTION_RESPONSE={sessions:[]}`, `EMPTY_DEV_RESPONSE={sessions:[],overall:{stage:"pre-autonomy",type1Pct:0}}`, `EMPTY_SESSION_RESPONSE={sessions:[]}`, `EMPTY_COMPREHENSION_RESPONSE={sessions:[]}`, `EMPTY_PHRASE_RESPONSE={totalUtterances:0,recognizedCount:0,ratio:0,byProvenance:{}}`
- **Gotchas:** No error handling for network failures beyond fallback empty objects; Promise.all catches layer is belt-and-suspenders and unreachable per design; adaptSession assumes metricsSnapshot keys are flat (no nested validation); dev stage response passed raw to state without adapter (inconsistent pattern vs other endpoints).

#### usePerception.ts
*hook* — Camera capture + WebSocket perception pipeline: streams JPEG frames to backend (YOLO + MediaPipe), receives detection JSON, draws annotations on canvas.

React hook usePerception() manages camera access via getUserMedia(), streams JPEG frames at 15 FPS (0.6 quality, 640x480 resolution) to NestJS backend over WebSocket (/ws/perception). Receives and renders detections (raw YOLO segmentation masks/bboxes), face landmarks (MediaPipe 478 points + 124 mesh connections + 36 contour oval), tracked objects with state/confidence, scene events (object_appeared, person_arrived, face_occluded), VWM entities (stabilized, KG-resolved), and VLM captions. Drawing pipeline: (1) raw object detections as polygon contours or fallback bboxes (green, no labels — sensory raw data); (2) tracking layer with VWM lookup — known objects green/cyan with labels, unknown orange with '?', unstabilized faint white; (3) face layers (independently toggleable mesh/dots/contour/bbox); (4) person identity labels (cyan, from face type VWM); (5) FACE_OCCLUDED dashed orange boxes; (6) VLM caption word-wrapped at canvas bottom. Fallback logic: if no VWM entities, populate RecognizedItem list from raw detections marked undiscovered. Extensive per-frame rendering via requestAnimationFrame. WebSocket reconnection/error handling: onerror does not close, onclose clears detections and resets feedMode to 'local', onopen starts 15 FPS capture interval.

- **Exports:** `usePerception`, `UsePerceptionReturn`, `AnnotationLayer`
- **Key constants:** `WS_PROTOCOL`, `WS_BASE`, `CAPTURE_FPS=15`, `JPEG_QUALITY=0.6`, `CAPTURE_WIDTH=640`, `CAPTURE_HEIGHT=480`
- **Deps:** `../store (useAppStore)`, `../types (RecognizedItem)`
- **Gotchas:** (1) Fallback from VWM entities to raw YOLO detections when VWM absent — YOLO is sensory hints, not knowledge, marked discovered:false; (2) friendlyLabel() normalizes underscore-delimited YOLO labels; (3) No labels on object/face geometry layers — identity labels only in tracking layer driven by VWM; (4) FACE_OCCLUDED events have no body, just bbox + '?' indicator; (5) Canvas/video dimensions sync on every frame; (6) ws.onerror does not close connection, allowing feed to continue; (7) Multiple refs (detections, faces, connections, tracked objects) updated from WebSocket message without state — mutations only, no re-render triggers.

#### usePressureStatus.ts
*hook* — Monitor drive engine pressure subsystem connectivity and staleness state via WebSocket + polling.

React hook that tracks pressure system status through two channels: (1) Zustand store derivation from telemetry WebSocket state and pressure sequence number; (2) periodic HTTP polling of /api/pressure endpoint. Returns isConnected (true if telemetry WS connected AND pressureSeq > 0) and isStale (staleness flag from store or API). Default poll interval 5000ms. On API fetch failure, defaults to isConnected=false, isStale=true. First effect derives state from store changes; second effect manages polling lifecycle with cleanup.

- **Exports:** `usePressureStatus`
- **Key constants:** `pollIntervalMs=5000`
- **Deps:** `../store (useAppStore)`
- **Gotchas:** Two independent state derivation paths (store + API polling) may diverge if API lags or WebSocket and polling return inconsistent data; no reconciliation logic between them. API error handling silently defaults rather than reporting error state.

#### useProgressiveSnapshot.ts
*hook* — React hook for loading graph snapshots in paginated chunks to avoid blocking the main thread

useProgressiveSnapshot(instance, pollMs) is a React hook that fetches graph data (nodes and edges) from `/api/graph/{instance}/` endpoints in pages. It tries paginated endpoints first (/count, /nodes?skip=X&limit=Y, /edges?skip=X&limit=Y), falls back to legacy single-fetch when 404, and includes fingerprint caching to skip refetches if counts haven't changed. State management via useState provides progress (0–1), status string, loading flag, final assembled snapshot, and totals. Control flow: fetch count → pages of nodes (500/page) → pages of edges (1000/page) → assemble and return. requestAnimationFrame yields to browser between pages. Abortable via AbortController; polls on interval if pollMs > 0.

- **Exports:** `useProgressiveSnapshot`, `ProgressiveLoadState`
- **Key constants:** `NODE_PAGE_SIZE=500`, `EDGE_PAGE_SIZE=1000`
- **Deps:** `react`
- **Gotchas:** Falls back to legacy endpoint without warning if paginated routes 404; fingerprint check is shallow (count-only, no content hash); error handling catches AbortError separately but swallows other network errors into legacy fallback cascade; no retry logic, single attempt per load cycle

#### useSessionTimer.ts
*hook* — React hook that formats elapsed time from a start timestamp, updating the display every second.

useSessionTimer is a custom React hook that accepts a startTimestamp (number) and returns a formatted elapsed-time string. It uses useState to track the elapsed display string (initial: "0:00") and a useEffect with a 1000ms interval to recalculate elapsed time. On each tick, it computes total seconds via (Date.now() - startTimestamp) / 1000, then derives hours/minutes/seconds; if hours > 0, format is h:mm:ss, otherwise m:ss. The interval is cleaned up on unmount or when startTimestamp changes (dependency array includes startTimestamp).

- **Exports:** `useSessionTimer`
- **Key constants:** `INTERVAL_MS=1000`
- **Gotchas:** No error handling if startTimestamp is invalid (negative, future, NaN); no memo/useMemo on the formatting logic, so the string is recreated on every interval tick even if the formatted output is identical to the previous tick.

#### useSkillPackages.ts
*hook* — React hook managing graph reset and snapshot refresh for skill package data

Provides useSkillPackages() hook that wraps skill-package graph reset operations. On resetGraph(), POSTs to /api/skills/reset with confirm flag, captures response (success status, nodes_deleted, edges_deleted, nodes_created), updates app store graph state and stats, and refreshes graph snapshot via /api/graph/snapshot GET. Returns isResetting boolean, resetStatus (type/message tuple), clearStatus callback to dismiss status, and resetGraph async function. Uses useState for local isResetting and resetStatus; dispatches to useAppStore (setGraphData, setGraphStats). Error handling: network/parse errors set error status; success path re-fetches snapshot to ensure UI stays in sync.

- **Exports:** `useSkillPackages`
- **Deps:** `../store (useAppStore)`
- **Gotchas:** Network errors caught but logged only to console, not surfaced in detail. Snapshot fetch (refreshGraphState) swallows errors silently with only console.error. No timeout or retry logic on fetch calls. resetStatus state not auto-cleared on new reset — caller must clearStatus() or it persists.

#### useSupervisorWebSocket.ts
*hook* — Connects to /ws/supervisor WebSocket endpoint and feeds supervisor verdicts into Zustand store with automatic reconnection.

Exports useSupervisorWebSocket() hook that manages a persistent WebSocket connection to the supervisor endpoint. Uses exponential backoff with jitter (base 1000ms × 2^attempt, capped 30000ms, jitter 0.8–1.2×) for reconnection scheduling. Parses incoming JSON messages with type='supervisor_verdict', extracts SupervisorVerdict payload, and dispatches via addVerdict() into supervisorSlice store. Handles open/error/close events with console logging; cleans up connection and pending timeouts on unmount. Mirrors pattern from useGraphWebSocket and useTelemetryWebSocket. Derives WS URL dynamically (wss: for https, ws: for http) from window.location.

- **Exports:** `useSupervisorWebSocket`
- **Key constants:** `WS_PROTOCOL: dynamic (wss: or ws:)`, `WS_BASE: ${WS_PROTOCOL}//${window.location.host}`, `backoff base: 1000ms`, `backoff cap: 30000ms`, `backoff jitter: 0.8–1.2×`
- **Deps:** `../store/supervisorSlice (useSupervisorStore, SupervisorVerdict)`, `react (useEffect, useRef, useCallback)`

#### useTelemetryBuffer.ts
*hook* — React hook that buffers telemetry events from the app store into a windowed circular buffer for monitoring and debugging

Exports useTelemetryBuffer() hook that subscribes to app store changes via pressureSequenceNumber and accumulates BufferedTelemetry entries (timestamp, pressure dict, executor state, category, action, confidence). Maintains circular buffer with two limits: MAX_ENTRIES=300 for absolute capacity, and DEFAULT_WINDOW_MS=5*60*1000 (5min) for time-windowed retention; older entries are discarded on push. getSnapshot() callback generates a human-readable summary: entry count, duration, dominant executor state, top 5 actions/categories by frequency, and current drive pressures sorted descending. Timestamps stored in seconds (Date.now()/1000), buffer managed via splice/shift for FIFO eviction.

- **Exports:** `useTelemetryBuffer`, `BufferedTelemetry`
- **Key constants:** `DEFAULT_WINDOW_MS=300000`, `MAX_ENTRIES=300`
- **Deps:** `useAppStore from ../store`
- **Gotchas:** stateCounts dict is computed but only used for extracting dominantState; entry.driveEntropy and entry.dominantDrive fields are declared in interface but never written or used in hook logic (dead fields)

#### useVoiceRecording.ts
*hook* — React hook for microphone recording, transcription via API, and voice state management with low-confidence confirmation UX.

Exports useVoiceRecording() hook that manages MediaRecorder lifecycle, captures audio chunks, POSTs to /api/voice/transcribe, and handles both modern (text+confidence) and legacy (transcription_text+response_text+audioBase64) response shapes. playAudioBase64() utility decodes base64 audio and plays via HTMLAudioElement with object URL cleanup. Supports confidence-gated dispatch: confidence >= 0.5 auto-sends; below 0.5 holds in pendingTranscription for guardian confirmation. Listens to sylphie:audio_response custom DOM event for inline audio responses. MediaRecorder configured with audio/webm;codecs=opus or fallback; starts() with 100ms timeslices. On stopRecording, aggregates chunks into Blob and sends to transcribe endpoint. Sets isRecording/isProcessing state; syncs voiceState (recording, processing, permissionDenied, muted) to app store.

- **Exports:** `useVoiceRecording`, `UseVoiceRecordingReturn`, `playAudioBase64`
- **Key constants:** `TRANSCRIBE_ENDPOINT=/api/voice/transcribe`, `TIMESLICE_MS=100`, `CONFIDENCE_THRESHOLD=0.5`, `AUDIO_FETCH_ENDPOINT=/api/voice/audio/{turn_id}`
- **Deps:** `react`, `../store`, `../types`
- **Gotchas:** Legacy API path (transcription_text) dispatches message directly without confidence gate; modern path uses processTranscriptionResult(). CustomEvent('sylphie:voice_text') pattern for decoupled WS communication (comment notes simpler alternatives like store action). audioCleanupRef tracks only ONE audio playback at a time, revokes prior on new. playAudioBase64 catches and logs silently on decode/playback error, returns no-op cleanup. No explicit error recovery if transcribe endpoint connection fails permanently.

#### useWebRTC.ts
*hook* — React hook for bidirectional WebRTC signaling and media stream management with auto-reconnect.

Exports useWebRTC(options) hook that manages RTCPeerConnection lifecycle, WebSocket signaling, local/remote media streams, and device audio/video toggling. Handles ICE candidate queuing until remoteDescription is set, exponential backoff reconnection (base 1000ms capped at 30s, jitter 0.8–1.2×), and state sync to Zustand appStore. Key classes: RTCPeerConnection (Google STUN), RTCSessionDescription, RTCIceCandidate. Flow: getUserMedia → WebSocket connect → createOffer/Answer → track state in store. Side effects: DOM video element srcObject writes, media track lifecycle, window.setTimeout for reconnect delays.

- **Exports:** `useWebRTC`, `UseWebRTCOptions`, `UseWebRTCReturn`
- **Key constants:** `WS_PROTOCOL = derived from window.location.protocol`, `WS_BASE = derived from protocol+host`, `RTC_CONFIG.iceServers = [stun:stun.l.google.com:19302]`, `BACKOFF_BASE = 1000ms`, `BACKOFF_MAX = 30000ms`, `JITTER_MIN = 0.8`, `JITTER_MAX = 1.2`
- **Deps:** `react (useEffect, useRef, useCallback, useState)`, `../store (useAppStore)`, `../types (SignalingMessage, WebRTCConnectionState)`
- **Gotchas:** ESLint disable on exhaustive-deps (line 349) suggests autoConnect dependency intentionally suppressed; reconnect loop can retry indefinitely while pcRef.connectionState !== closed; remoteDescription null-check gates ICE candidate add (line 205) to avoid errors before SDP; no explicit max reconnect attempts—only stops on full peer close; chat-like fallback to MJPEG feedMode on getUserMedia failure (line 309) but no guarantee remote decodes it

#### useWebSocket.ts
*hook* — React hooks managing three WebSocket connections (graph, conversation, telemetry) with auto-reconnect and state sync

Exports three custom hooks: useGraphWebSocket (listens for graph delta/snapshot mutations, debounces snapshot re-fetch on bursts), useConversationWebSocket (handles bidirectional message exchange with auth token, thinking indicators, queue positioning), useTelemetry WebSocket (ingests executor cycles, predictions, maintenance events, state transitions into telemetry views). All three use exponential backoff reconnect (base 1000ms × 2^attempt capped at 30s + 20% jitter), guard against stale event handlers via closure refs, and dispatch state updates to Zustand. Graph refetch debounce is 1500ms. Conversation socket includes special handling for input_ack (skip), thinking_indicator, queue_position (WS4 Ticket 6), and cb_speech/response turns. Telemetry formats executor actions, maintenance cycle details, and state transitions into system logs. All sockets use cobeing-v1 protocol.

- **Exports:** `useGraphWebSocket`, `useConversationWebSocket`, `useTelemetryWebSocket`
- **Key constants:** `WS_PROTOCOL=window.location.protocol==='https:'?'wss:':'ws:'`, `WS_BASE=${WS_PROTOCOL}//${window.location.host}`, `SNAPSHOT_REFETCH_DEBOUNCE_MS=1500`, `BACKOFF_BASE=1000ms`, `BACKOFF_MAX_DELAY=30000ms`, `BACKOFF_JITTER_RANGE=0.8...1.2`, `CONVERSATION_EVICTION_CODE=1012`
- **Deps:** `../store (useAppStore)`, `../types (GraphDelta, ConversationMessage, TelemetryMessage)`
- **Gotchas:** WS4 T6 queue-position logic only on conversation socket; graph socket refetch omits re-fetch on initial connect (only on reconnect); conversation socket uses oldWs=wsRef.current then nulls ref before close to prevent double-delivery race; snapshot message handler accepts both cobeing-v1 {snapshot:{...}} and legacy {data:{...}} formats; thinking_indicator on conversation clears queue position when is_thinking=true; no explicit error handling for failed snapshot fetch (logs only)

### `frontend/src/layouts/`

#### DashboardLayout.tsx
*component* — Root layout shell for /dashboard/* routes, wiring WebSocket connections and voice status

DashboardLayout is a React.FC that serves as the primary layout wrapper for all dashboard-routed views. It renders a two-column flex layout with Sidebar on the left and an Outlet (routed content) on the right. On mount, it initializes two WebSocket connections (graph and telemetry) via custom hooks and fetches voice service availability from /api/voice/status, storing state in Zustand (appStore.setVoiceState). It renders four floating overlay components (SkillManager, NodeInspector, FEAgentPanel, SupervisorPanel) that persist across all child views, with SupervisorPanel controlled by supervisorSlice state. The main content area is a flex-1 scrollable Box with subtle inset shadow styling and background color from theme.

- **Exports:** `default (DashboardLayout)`
- **Key constants:** `height: 100vh`, `overflow: hidden`, `flex: 1`, `boxShadow: inset 4px 0 12px rgba(0,0,0,0.15)`, `API endpoint: /api/voice/status`
- **Deps:** `../components/Navigation/Sidebar`, `../store`, `../hooks/useWebSocket (useGraphWebSocket, useTelemetryWebSocket)`, `../components/Graph/NodeInspector`, `../components/Skills/SkillManager`, `../components/FEAgent/FEAgentPanel`, `../components/Supervisor/SupervisorPanel`, `../store/supervisorSlice (useSupervisorStore)`
- **Gotchas:** voice fetch has no retry logic; supervisor panel open state toggles via setSupervisorOpen(false) only (no open control from props)

### `frontend/src/lib/`

#### analytics.ts
*module* — PostHog analytics integration for SPA pageview tracking with environment-gated initialization

Two main exports: initAnalytics() initializes PostHog SDK only if VITE_PUBLIC_POSTHOG_PROJECT_TOKEN is set, with capture_pageview disabled and person_profiles set to 'identified_only' to prevent quota burn on anonymous traffic; useAnalyticsPageviews() is a React hook that leverages useLocation() to capture explicit pageviews on every route change, composing the full URL from window.location.origin + pathname + search. Module holds two module-scoped variables: posthog (PostHog instance, null if uninitialized) and posthogReady (Promise that resolves after SDK import and init complete). The SDK disables automatic pageview capture and implements pageleave tracking to avoid double-firing landing-page views.

- **Exports:** `initAnalytics`, `useAnalyticsPageviews`
- **Key constants:** `POSTHOG_KEY=import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN`, `POSTHOG_HOST=import.meta.env.VITE_PUBLIC_POSTHOG_HOST \|\| 'https://us.i.posthog.com'`, `capture_pageview=false`, `capture_pageleave=true`, `autocapture=true`, `person_profiles='identified_only'`
- **Deps:** `react`, `react-router-dom`, `posthog-js`
- **Gotchas:** Module-scoped posthog and posthogReady variables persist across hook invocations; no cleanup/teardown logic; relies on environment variables that may be unset; no error handling if PostHog init fails.

### `frontend/src/pages/`

#### LoginPage.tsx
*component* — User authentication UI component supporting login and registration flows

LoginPage is a React functional component that renders a centered auth card with username/password fields and toggle between login/register modes. Uses Material-UI Box, Card, TextField, Button, Alert, and Link components for the layout. Manages local state for isRegister, username, password, error, and loading flags. On form submit, posts to /api/auth/login or /api/auth/register (conditional on isRegister), expects JSON response with {token, user} on success, calls setAuth from useAppStore to persist auth state, and displays error.message if response fails. Submit button disabled while loading or if username/password empty. Toggle link switches isRegister and clears error state.

- **Exports:** `LoginPage`
- **Key constants:** `minHeight=100vh`, `Card width=400`, `padding=4`, `mb=2 (TextField margin bottom)`, `mb=3 (Password field margin bottom)`
- **Deps:** `useAppStore from ../store`
- **Gotchas:** No input validation beyond required/empty check on client side; error handling relies entirely on server response.message; no CSRF token or rate-limiting; loading state set but network timeout unhandled (finally runs but no explicit timeout); hardcoded API paths (/api/auth/register, /api/auth/login) with no env-based config

### `frontend/src/pages/dashboard/`

#### AnalyticsView.tsx
*component* — Primary dashboard layout orchestrating system state visualization across nine metric panels and a modal observatory.

Exports AnalyticsView, a full-viewport React component composing system monitoring panels in a three-row grid: top row (flex 4) displays SystemLogsPanel, DrivesPanel, and DriveRadarChart; middle row (flex 2) shows ExecutorStatePanel, DriveEnginePanel, MaintenanceLogsPanel, and PredictionAccuracyPanel; bottom row (flex 3) contains RecentActionsPanel and InnerMonologuePanel. GlassPanel is a reusable styled wrapper (rgba glass effect, border-radius 2, glassmorphic border) that renders optional title, children, and action buttons. The component manages modal state for ObservatoryPanel via observatoryOpen boolean, triggered by a BarChartIcon button on the Drive Radar. All panels use flex layout with minHeight 0 to enable scroll within container; the entire view is 100vh with 1.5 padding.

- **Exports:** `AnalyticsView`
- **Key constants:** `DIALOG_MAX_WIDTH="lg"`, `DIALOG_HEIGHT="80vh"`, `GLASS_BG_COLOR="rgba(255,255,255,0.03)"`, `GLASS_BORDER="1px solid rgba(184,217,198,0.12)"`, `TITLE_FONT_SIZE="0.65rem"`, `ICON_FONT_SIZE="0.85rem"`
- **Deps:** `ExecutorStatePanel`, `DriveEnginePanel`, `RecentActionsPanel`, `PredictionAccuracyPanel`, `DriveRadarChart`, `DrivesPanel`, `InnerMonologuePanel`, `SystemLogsPanel`, `MaintenanceLogsPanel`, `ObservatoryPanel`
- **Gotchas:** No error boundaries; no loading/fallback states; assumes all child panels render synchronously without network suspension; Observatory dialog height hardcoded to 80vh (responsive breakpoint not handled).

#### ChatView.tsx
*component* — Full-height dashboard layout combining conversation, audio, camera, and drive visualization panels.

ChatView is a React functional component that creates a three-tier layout: (1) top audio strip with mic stream and FFT visualization via AudioPanel, (2) main flex-row with ConversationPanel on left and camera column on right, (3) camera column containing CameraPanel (flex 3) and bottom row splitting RecognitionChips and MiniDriveChart (each flex 1). All sections use MUI Box with consistent styling: rounded borders, translucent backgrounds (rgba(255,255,255,0.03)), and thin stroke borders (rgba(184,217,198,0.12)). Root is full viewport height (100vh) with flexbox column layout, gap 1 (8px), padding 1.5 (12px). No state, hooks, or event handlers — pure presentational orchestration of five child components.

- **Exports:** `ChatView`
- **Key constants:** `height=100vh`, `gap=1`, `p=1.5`, `flexShrink=0 (audio)`, `flex=1 (conversation)`, `flex=1 (camera column)`, `flex=3 (camera feed)`, `flex=1 (recognition+drive)`
- **Deps:** `@mui/material`, `../../components/Conversation/ConversationPanel`, `../../components/Audio/AudioPanel`, `../../components/Camera/CameraPanel`, `../../components/Camera/RecognitionChips`, `../../components/Drives/MiniDriveChart`

#### CodebaseView.tsx
*component* — Interactive visual knowledge graph explorer for the codebase using Cytoscape

React component that renders a dynamic, force-directed graph visualization of the Package Knowledge Graph (PKG). Displays nodes (Service, Module, Function, Type, Change, Constraint) with color-coded styling and edge types (CONTAINS, BELONGS_TO, CALLS, USES_TYPE, IMPORTS, EXTENDS, IMPLEMENTS, INJECTS). Core features: module expand/collapse with child counts, search-driven navigation with highlighting, context panel for selected nodes, pan/zoom with adaptive label visibility, progressive data loading via useProgressiveSnapshot. Builds hierarchical indices (moduleChildren, serviceModules, nodeById, edgeIndex) from graph snapshot on mount and recomputes visible elements when expanded modules change. Cytoscape initialized with preset layout, COSE physics on data updates (nodeRepulsion=12000, idealEdgeLength=80-120, gravity=0.3, 200 iterations). Single-tap selects node and dims/highlights neighborhood; double-tap on Module toggles expansion; blank canvas closes panel. Zoom threshold at 0.4 hides small node labels.

- **Exports:** `CodebaseView`
- **Key constants:** `nodeRepulsion=12000`, `idealEdgeLength=80-120 (expanded) or 120 (collapsed)`, `nodeOverlap=30`, `gravity=0.3`, `numIter=200`, `zoomThreshold=0.4`, `progressiveSnapshot timeout=30000ms`, `NODE_STYLES colors: Service=#FF6B6B, Module=#4ECDC4, Function=#45B7D1, Type=#CE93D8, Change=#FFB74D, Constraint=#EF5350`
- **Deps:** `useProgressiveSnapshot`, `SearchBar`, `ContextPanel`, `cytoscape`, `@mui/material`, `@mui/icons-material`
- **Gotchas:** Progressive snapshot uses 30s throttle window — large PKG updates may batch visibly. Cytoscape layout randomization only when no modules are expanded. Text wrapping to 100px max-width may truncate long names. No error boundary for snapshot/cytoscape failures. Search result pan uses hardcoded 500ms setTimeout, may race if graph layout is slow. Module child counts shown only in collapsed state label. Hierarchy rebuild is O(nodes + edges) every time pkgData changes — could be slow for very large graphs.

#### GraphsView.tsx
*component* — Dashboard view displaying three knowledge graphs (WKG, OKG, SKG) with progressive loading and view mode switching

GraphsView is the main dashboard page component that renders three knowledge graphs in a split layout: WKG (World Knowledge Graph) takes the top ~62% as a hero panel with view mode switching (ambient 3D or explorer), while OKG (Other KG, person models) and SKG (Self KG, Sylphie self-model) share the bottom ~38% as equal-sized mini panels. Uses useProgressiveSnapshot hook to poll OKG and SKG data every 15s, pushing loaded data into app store for downstream consumers. WKG delegates to WkgViewSwitcher which conditionally renders AmbientView (lazy-loaded) or ExplorerView based on wkgViewMode store state. OKG and SKG panels use MiniGraphPanel for visualization with loading states, progress bars, node/edge counts, and contextual empty messages. GlassPanel and PanelHeader are reusable styled containers (frosted glass effect with accent-colored headers, icons, and progress indicators).

- **Exports:** `GraphsView`
- **Key constants:** `okg_poll_interval_ms=15000`, `skg_poll_interval_ms=15000`, `wkg_flex=5`, `okg_skg_flex=3`, `glass_panel_bg=rgba(255,255,255,0.03)`, `glass_panel_border=1px solid rgba(184,217,198,0.12)`, `wkg_color=#64B5F6`, `okg_color=#CE93D8`, `skg_color=#FFB74D`, `panel_header_height_2px=2`, `linear_progress_bar_height=2`
- **Deps:** `./../../components/Graph/MiniGraphPanel`, `./../../components/Graph/WkgViewSwitcher`, `./../../components/Graph/ExplorerView`, `./../../store`, `./../../hooks/useProgressiveSnapshot`, `./../../components/Graph/AmbientView`
- **Gotchas:** AmbientView is lazy-loaded but no explicit error boundary; relies on Suspense fallback. OKG/SKG empty messages assume data structure {nodes, edges} but no validation that okg.data or skg.data conform. No handling for useProgressiveSnapshot errors or polling failures. PanelHeader receives optional nodeCount/edgeCount but formatting assumes numeric values without null checks. WkgViewSwitcher component behavior not visible here — view mode switching logic is delegated.

#### GuardianView.tsx
*component* — Guardian dashboard UI for rule approval workflow and tensor cognition monitoring

Main React component (GuardianView) renders a full-screen dual-column dashboard: left column manages proposed/active drive rules with approve/reject actions; right column shows tensor sidecar health via bootstrap progress, per-category agreement, training metrics, and model architecture. Fetches from /api/rules/proposed, /api/rules/active, /api/cognition/dashboard on mount and refreshes tensor data every 30s. Supports rule JSON effect parsing (drive delta notation), date formatting with localization, and number abbreviation (M/K). GlassPanel reusable component (rgba glass effect, border styling). Handles auth token from app store for protected endpoints.

- **Exports:** `GuardianView`
- **Key constants:** `BOOTSTRAP_STEPS=['shadow','audit','partial','full']`, `tensorRefresh=30_000ms`, `confidence_green_threshold=0.85`, `confidence_amber_threshold=0.5`
- **Deps:** `useAppStore`, `@mui/material`, `@mui/icons-material`
- **Gotchas:** Silent catch blocks on all fetch (rules, tensor) - errors go unlogged; tensor refresh interval never cancelled if component unmounts during interval (useRef cleanup present but leaks if promise hangs); effect JSON parsing fallback assumes DSL string if parse fails; no pagination/virtualization for rules lists (unbounded render); category agreement case-sensitivity (lowercase check but display preserves original); modelState extraction assumes 'parameters' field in state objects

### `frontend/src/services/`

#### feAgent.ts
*service* — Claude API integration service for real-time Sylphie state assistant in guardian browser interface

Provides read-only telemetry-grounded assistant to help guardians understand Sylphie's drives, pressures, executor state, and actions. Core exports: isAvailable() checks for VITE_ANTHROPIC_API_KEY; askFEAgent() streams Claude Haiku responses given a question, telemetry snapshot, and chat history. Uses Anthropic JS SDK with dangerouslyAllowBrowser=true (trusted browser context). System prompt hardcodes knowledge of 12 drives (4 core: system_health, moral_valence, integrity, cognitive_awareness; 8 complement: guilt, curiosity, boredom, anxiety, satisfaction, sadness, focus, social), Type 1/Type 2 cognition, executor states (idle, categorizing, querying, selecting, executing), and pressure semantics (0.0-1.0). Model hardcoded to claude-haiku-4-5-20251001 with max_tokens=1024. Streaming via contentBlockDelta events with callback per chunk. Client instantiation lazy-loads on first askFEAgent() call.

- **Exports:** `isAvailable`, `askFEAgent`, `FEAgentMessage`
- **Key constants:** `model=claude-haiku-4-5-20251001`, `max_tokens=1024`, `drives=12 (4 core + 8 complement)`, `pressure_range=0.0-1.0`
- **Deps:** `@anthropic-ai/sdk`
- **Gotchas:** No error handling if stream fails mid-response; dangerouslyAllowBrowser=true relies on trusted browser; VITE_ANTHROPIC_API_KEY in env is single point of failure; no conversation persistence (history managed by caller); system prompt knowledge of drives/executor/cognition may drift from actual Sylphie implementation

### `frontend/src/store/`

#### index.ts
*module* — Zustand application state store managing auth, graph data (main/OKG/SKG/PKG), conversation, voice, camera, WebRTC, telemetry, and UI panel state.

Exports useAppStore, a Zustand store managing 50+ state fields across auth (token/user), WebSocket connections (graph/conversation/telemetry), graph snapshots (graphData, okgData, skgData, pkgData with stats), conversation messages, session stats, voice/camera/WebRTC states, skills, telemetry pressure (12 drives), executor state, and UI toggles. Core actions: setters for auth/graphs/messages/telemetry; addMessage caps messages at MAX_MESSAGES=500 using monotonic clientId counter (m0, m1...) to survive slice-capping; updateTelemetry spreads ZERO_PRESSURE defaults and auto-appends action history + inner-monologue entries from executor_cycle events (non-LLM verbatim); stasis detection (10+ consecutive turns without graph changes triggers indicator); voice mute persists to localStorage. Notable: InnerMonologueEntry stores rawPayload as stringified JSON; action/prediction/innerMonologue capped at MAX_HISTORY=50; systemLogs capped at 200; explorerHistory max 10 items; explorer depth clamped 1-3; WKG view mode (ambient vs explorer); queue position tracking (WS4 T6).

- **Exports:** `useAppStore`, `InnerMonologueEntry`, `SystemLogEntry`
- **Key constants:** `ZERO_PRESSURE (12 drives all 0)`, `MAX_HISTORY=50`, `MAX_MESSAGES=500`, `messageCounter=0 (monotonic)`, `explorerHistory slice max 10`, `explorerDepth clamp 1-3`, `systemLogs slice 200`
- **Deps:** `zustand`, `types (WSState, GraphSnapshot, GraphStats, ConversationMessage, SkillPackage, SkillDto, SessionStats, VoiceState, CameraState, RecognizedItem, GraphFilters, TelemetryPressure, TelemetryCycle, WebRTCState, WkgViewMode)`
- **Gotchas:** messageCounter is module-scoped let, survives slice-capping but survives resets; action/prediction history timestamps differ (data.timestamp from event vs Date.now()/1000 for manual add); innerMonologue rawPayload is full stringified JSON (potentially large); explorerHistory is persisted in state but has no explicit garbage collection if app crashes during deep exploration; stasis detection only fires at 10 turns, may delay UX feedback

#### supervisorSlice.ts
*module* — Zustand store slice for DeepSeek supervisor state management, verdicts, and intervention tracking

Exports useSupervisorStore hook backed by Zustand. Manages supervisor enabled/disabled state, sampling policy (sampleRate, burstMode), budget tracking (budgetRemaining, budgetUsedToday), and verdict history. Core types: SupervisorVerdict (cycleId, timestamp, rating: good|acceptable|questionable|wrong, confidence 0-1, reasoning, flagForGuardian bool, token costs), SupervisorStatus (enabled, samplingPolicy, budget, verdicts count and list), SupervisorIntervention (type: flag|rollback|freeze). Store actions: togglePanel, setPanelOpen, addVerdict (appends and trims to MAX_VERDICTS=100), setStatus (bulk hydration), clearVerdicts. Verdict history capped at 100 entries; flaggedCount incremented on Guardian-flagged verdicts.

- **Exports:** `useSupervisorStore`, `VerdictRating`, `SupervisorVerdict`, `SupervisorStatus`, `SamplingPolicy`, `SupervisorIntervention`
- **Key constants:** `MAX_VERDICTS=100`, `VerdictRating: good\|acceptable\|questionable\|wrong`, `InterventionTypes: flag\|rollback\|freeze`
- **Deps:** `zustand`

### `frontend/src/theme/`

#### index.ts
*config* — Material-UI theme configuration for dark-mode UI

Exports a single default MUI theme object created via createTheme(). Defines a dark palette with primary=#64B5F6 (light blue), secondary=#CE93D8 (purple), background.default=#111827 (near-black), background.paper=#1a1a2e (very dark blue). Text colors set to #E0E0E0 primary, #111827 secondary. Error/warning/success mapped to MUI standards (#EF5350/#FFB74D/#66BB6A). Typography uses system font stack. Components section overrides MuiCssBaseline to force body/root to height 100vh, hidden overflow, and flexbox column layout—preparing the viewport for full-screen application layout.

- **Exports:** `default (theme)`
- **Key constants:** `primary.main=#64B5F6`, `secondary.main=#CE93D8`, `background.default=#111827`, `background.paper=#1a1a2e`, `text.primary=#E0E0E0`, `text.secondary=#111827`, `error.main=#EF5350`, `warning.main=#FFB74D`, `success.main=#66BB6A`, `divider=rgba(255,255,255,0.12)`
- **Deps:** `@mui/material`

### `frontend/src/types/`

#### index.ts
*type* — Centralized TypeScript type definitions for frontend domain models (graph, conversation, telemetry, skills, voice, camera, WebRTC)

Barrel export of ~60+ TypeScript interfaces and type aliases with no external dependencies (@cobeing/shared excluded). Core domains: GraphNode/GraphEdge/GraphSnapshot/GraphDelta for knowledge graph representation; ConversationMessage with grounding_ratio/knowledgeGrounding (GROUNDED/LLM_ASSISTED/UNKNOWN) for conversation state; TelemetryCycle/TelemetryPressure (12 drive axes: system_health, moral_valence, integrity, cognitive_awareness, guilt, curiosity, boredom, anxiety, satisfaction, sadness, focus, social) with metadata (sequence_number, is_stale, dynamic_threshold); SkillDto/SkillUploadResponse mirroring backend skills.dto; VoiceState (recording, muted, permissionDenied); CameraState (active, feedMode: webrtc/local/mjpeg/unavailable); RecognizedItem (type: object/face, discovered, nodeId, personId, VWM state: entering/present/leaving/gone); GraphFilters (schemaLevel, provenance, nodeTypes); WebRTC signaling types (offer/answer/candidate/ready/error); PendingTranscription awaiting guardian confirmation below 0.5 confidence threshold.

- **Exports:** `WSState`, `GraphNode`, `GraphEdge`, `GraphSnapshot`, `GraphDelta`, `GraphStats`, `WkgViewMode`, `SearchNodeResult`, `ConversationMessage`, `PendingTranscription`, `TelemetryPressure`, `DriveAxisName`, `TelemetryCycle`, `TelemetryStateTransition`, `TelemetryPrediction`, `TelemetryMaintenanceCycle`, `TelemetryMessage`, `SkillDto`, `SkillUploadResponse`, `SkillPackage`, `SkillInstallResponse`, `SkillResetResponse`, `SessionStats`, `VoiceState`, `CameraState`, `RecognizedItem`, `SchemaLevel`, `ProvenanceFilter`, `NodeTypeFilter`, `GraphFilters`, `WebRTCConnectionState`, `WebRTCState`, `SignalingOffer`, `SignalingAnswer`, `SignalingCandidate`, `SignalingError`, `SignalingReady`, `SignalingMessage`
- **Key constants:** `TelemetryPressure keys: system_health, moral_valence, integrity, cognitive_awareness, guilt, curiosity, boredom, anxiety, satisfaction, sadness, focus, social`, `GraphDelta union: node_added\|node_created\|node_updated\|node_removed\|node_deleted\|edge_added\|edge_created\|edge_updated\|edge_removed\|edge_deleted\|proposal_created\|proposal_resolved\|system_status\|snapshot`, `ConversationMessage types: thinking\|response\|transcription\|error\|system_status\|ping\|guardian\|cb_speech`, `knowledgeGrounding: GROUNDED\|LLM_ASSISTED\|UNKNOWN`, `CameraState feedMode: webrtc\|local\|mjpeg\|unavailable`, `RecognizedItem state: entering\|present\|leaving\|gone`, `CameraState mode: pip\|main`, `WSState: connected\|reconnecting\|disconnected`, `WkgViewMode: ambient\|explorer`, `confidence threshold for PendingTranscription: <0.5 requires guardian confirmation`
- **Gotchas:** No external imports beyond native TS types; conversational grounding_ratio and is_grounded fields are nullable; GraphDelta.data is optional but many delta types depend on it; PendingTranscription confidence<0.5 gate is implicit (comment-only); SkillDto.predictionMae nullable; SkillPackage marked as legacy; RecognizedItem.discovered/nodeId/personId/duration/state all optional; no validation or schema enforcement in type definitions themselves

## Risks / stubs / TODOs

- `frontend/src/App.tsx` — AuthGate useEffect has eslint-disable-line comment for missing setAuth/clearAuth deps — may cause stale closure bugs if auth functions change. No error handling UI for failed auth check beyond silent clearAuth. Legacy Dashboard route suggests migration in progress.
- `frontend/src/Dashboard.tsx` — VideoWidget replaced by CameraPanel (uses usePerception hook). Comment at line 41 signals legacy code removal. Observatory and Supervisor dialogs use full screen with maxWidth='lg' and height='80vh' but no error boundary around children. /api/voice/status fetch silently catches errors and sets available:false with no retry logic.
- `frontend/src/components/Alerts/AttractorAlertBanner.tsx` — Dismissed alerts cleared only on page reload (local state, no persistence). useObservatoryAlerts hook dependency not shown in this file; potential fragility if hook refactors or reachable/alerts/dismissed/dismiss contract changes.
- `frontend/src/components/Audio/AudioPanel.tsx` — Creates new AudioContext on each TTS event; no pooling or reuse (lines 87). Multiple unaborted audio playbacks could stack contexts. outputDecayRef allocated but never read (line 39). No sample-rate or stereo-channel normalization across devices.
- `frontend/src/components/Camera/CameraPanel.tsx` — No error boundary; canvas ref cast to HTMLCanvasElement assumes usePerception provides correct type; layer state mutations via spread operator; PIP/main layout is conditional render (not CSS media query) — layout changes on cameraState.mode change require parent to handle reflow
- `frontend/src/components/Codebase/ContextPanel.tsx` — Backend availability risk: 'Source code not available. The backend may need to be restarted' fallback message indicates silent fetch failures; no error logs. Floating dependency onHighlightDataFlow callback with eslint-disable-next-line (line 168) — missing onHighlightDataFlow in dependency array creates stale-closure risk. Filtering node.properties for bodyText and contentHash (line 303) is hardcoded tuple with no extensibility. Date formatting truncates to 10 chars (line 433) without validation. Data flow upstream/downstream counted but not paginated; no indicator if results truncated beyond 2-hop limit.
- `frontend/src/components/Codebase/SearchBar.tsx` — fetch response error sets results to empty without logging; abortRef can be null on unmount race; no keyboard navigation (arrow keys) in dropdown; matchLines truncated to first 2 with ellipsis, no line-number context shown; result deduplication relies on name+filePath+index composite key
- `frontend/src/components/Conversation/ConversationPanel.tsx` — MessageBubble memoized on referential equality, clientId stamping in parent required for correctness; ConversationInput isolated state prevents feed re-render on typing (intentional optimization); backend may send 'text' or 'content' so displayText checks both; voice-text listener added/removed in useEffect with dependency array [wsConnectionState, addMessage, sendTextMessage]; theater-check rendering depends on is_grounded explicitly false (not null/undefined); queue position hides during isThinking to avoid visual conflict with typing indicator
- `frontend/src/components/Conversation/WordRatingDrawer.tsx` — Phrase node ID presence is silent gate for marking; no error if missing, just disables interaction. Marked status shows 'wrong' label next to each marked word chip. onWordMarked fired immediately on mark (not unmark) with current word/position. No persistence or undo within component.
- `frontend/src/components/Drives/DriveBarChart.tsx` — No error handling for missing pressure data (defaults to 0); staleness logic duplicated in both components; zero-line highlighting assumes amber color constant across grid and ticks; no memoization of data/color arrays; chart re-renders on every store subscription even if pressure values unchanged.
- `frontend/src/components/Drives/DriveRadarChart.tsx` — Pressure object keys must match TelemetryPressure interface or default to 0; negative drive values silently clamped (no error). Staleness check hardcodes 5000ms; no configurability. Green and orange colors hardcoded in rgba form throughout (no shared constants). Loading state shows placeholder spinner only when pressureSeq is 0 (first-sync guard).
- `frontend/src/components/Drives/DrivesPanel.tsx` — No error handling for useAppStore or useDriveOverrides hook failures; assumes pressure/overrides always defined with fallback ?? 0; usePressureStatus.isStale logic not clear from component (assumed hook provides it); no explicit validation of drift rate bounds; handleResetAll button always enabled (disabled={false} hardcoded).
- `frontend/src/components/Drives/MiniDriveChart.tsx` — Normalization formula assumes raw values fit [-10,1] domain but does not validate input; bars clamp to [0,1] output range silently. No loading spinner, only text placeholder. TelemetryPressure type shape not verified in this file.
- `frontend/src/components/FEAgent/FEAgentPanel.tsx` — Graceful degradation via isAvailable() gate (returns null if API key missing); no error handling for chat/streaming failures visible; streamingText UI assumes non-null content; chat array keyed by index (i) not message ID—unstable if list reorders
- `frontend/src/components/Graph/AmbientView.tsx` — Material cache uses global Map, never cleared (potential memory leak if many colors added); hover node rescaling via scene.getObjectByName() can silently fail if object not found; no validation that graphData.nodes/edges exist before mapping (empty-state risk); keyboard listeners never removed if component unmounts during animation frame
- `frontend/src/components/Graph/ExplorerBreadcrumbs.tsx` — Early return null if explorerHistory.length === 0 (renders nothing). Last entry click handler is undefined, making it inert. Uses array index as key part, which is fragile if reordering occurs. No error handling if currentNodeType is missing from NODE_TYPE_COLORS.
- `frontend/src/components/Graph/ExplorerGraphPanel.tsx` — fingerprint dependency array missing 'fingerprint' variable itself (line 155 eslint-disable-next-line suggests intentional); confidence dimming hardcoded to 0.5 threshold; edge cascade logic iterates all edges per render; center node pinning via fixedNodeConstraint may not persist across layout runs if node position is not re-locked
- `frontend/src/components/Graph/ExplorerView.tsx` — No error boundary or error state handling for data fetch failures; loading state does not distinguish between initial load and refetch; no visual feedback for invalid nodes or search failures; breadcrumb navigation relies on direct store access (useAppStore.getState()) within callback rather than prop-driven; truncation warning shows only a count cap (500) with no indication of what was excluded or how to explore further
- `frontend/src/components/Graph/GraphPanel.tsx` — eslint-disable-next-line react-hooks/exhaustive-deps on line 328 (graphFingerprint + graphFilters dependency array) — justifiable because graphData is accessed via useAppStore.getState() inside the effect rather than as a direct dependency, but worth monitoring. Synthetic edges created for unconnected nodes may cause unexpected graph morphology if edge count changes dramatically. No error handling for Cytoscape initialization or layout failures. CoBeing node lookup is exact type match; if missing, falls back to first node.
- `frontend/src/components/Graph/MiniGraphPanel.tsx` — Fingerprint uses last node in array for identity hash — may miss reordered nodes with identical count/edges. Layout runs on every data update via fingerprint change; cose layout is non-deterministic. HAS_FACT edge styling is hardcoded dashed appearance. Empty state uses visibility:hidden rather than display:none to keep ref available.
- `frontend/src/components/Graph/NodeInspector.tsx` — Confidence display uses threshold of 0.5 (50%) for retrieval usability; below threshold triggers warning icon and disables retrieval. Properties table blindly JSON.stringify objects. No validation that selectedNode matches graphData nodes. Drawer always renders when open but returns null if selectedNode not found (defensive).
- `frontend/src/components/Graph/graphStyles.ts` — No imports from first-party code, pure styling constant; nodeLabel() has 15 type cases plus 4 id-prefix fallbacks (grounding-failure, drive-category, rule, meta) — maintainability risk if new node types added without updating label extraction
- `frontend/src/components/InnerMonologue/InnerMonologuePanel.tsx` — Key uses array index (key=i) instead of stable ID; potential perf issue on list reorder. rawPayload JSON parsing silently falls back to raw text on error. No truncation of large payloads; could cause scroll lag.
- `frontend/src/components/Layout/TopBar.tsx` — Audio/Video status derived from capability flags (voiceState.available, cameraState.active) rather than WebSocket state; no error handling for missing store/hook; onOpenObservatory and onOpenSupervisor callbacks are optional and may be undefined
- `frontend/src/components/MaintenanceLogs/MaintenanceLogsPanel.tsx` — Timestamp property initialized empty in parseMaintenanceEntry, populated after in useMemo map — potential for stale timestamps if called outside memo. Raw parsing with regex has no error handling if format doesn't match pattern (returns 0 for jobs_run/committed, false for phrase_consolidation). Component relies entirely on pre-routed maintenance_cycle entries; separate WebSocket connection was removed and consolidated into shared telemetry stream.
- `frontend/src/components/Metrics/MetricsPanel.tsx` — MetricsPanel is marked @deprecated in favor of using four individual panels; time formatting uses Date.now() / 1000 (Unix seconds, matches incoming timestamps); fill ratio calculated only when pressureValues.length > 0 to avoid division by zero; prediction accuracy colored by error threshold (>70% red, >40% warning, <40% success); ListItem keys use array index 'i' which is fragile if list order changes
- `frontend/src/components/Navigation/Sidebar.tsx` — Reset handler silently fails on error (catch block has no logging). Sidebar width is hardcoded constant exported for DashboardLayout offset calculation. Drive hue defaults to 160 if key not found in map. Reset dialog confirms destructive action but provides no rollback mechanism — documented as irreversible.
- `frontend/src/components/Observatory/ObservatoryDashboard.tsx` — DriveHeatmap hard-codes 12 drive names in parallel arrays (driveNames/driveLabels); mismatch risks silent misalignment. HeatColor diverging gradient has hand-tuned RGB ranges (66,133,244 for blue; 255,255,0 for red) — color accuracy depends on exact arithmetic. Null/undefined guards scattered (d.drives[drive]??0, s.duration_seconds!==undefined?format:'-') suggest upstream data volatility. BarChart labels only render if data.length<=15 (readability safeguard). ProvenanceDisplay shows empty state only if totalUtterances===0; other sections show NoData when array length 0. SVG viewBox in BarChart clamps to 600px max but could overflow if many bars; no horizontal scroll enforced. Session table maxHeight=220px hardcoded.
- `frontend/src/components/Skills/SkillManager.tsx` — resetGraph is awaited but no error handling visible; confirmation dialog description mentions "permanent delete" but actual deletion logic is in the hook; isResetting disables button but state flow depends entirely on hook implementation
- `frontend/src/components/Supervisor/SupervisorPanel.tsx` — Interventions (Freeze/Rollback buttons) are disabled stubs with Coming Soon tooltips; WebSocket connection always starts regardless of panel open state (useEffect at top level calls useSupervisorWebSocket() unconditionally); status polling only happens when open=true but WebSocket runs always; no error boundary for fetch failures beyond console.warn.
- `frontend/src/components/Supervisor/VerdictCard.tsx` — verdict.flagReason falls back to hardcoded 'Flagged for guardian review' if undefined; no error handling for invalid verdict.rating enum (defaults to questionable); timestamp conversion assumes verdict.timestamp is valid ISO-8601 parseable date; no loading/error states
- `frontend/src/components/SystemLogs/SystemLogsPanel.tsx` — Entry key uses array index (i) instead of stable ID — reorders/duplicates could cause React keying issues if log entries are modified in-place
- `frontend/src/components/UnderConstruction.tsx` — Hard-coded instruction text mentioning VITE_APP_ENABLED; no programmatic access to environment variable state to show actual current status; no fallback state management if enabled dynamically
- `frontend/src/hooks/useAudioStream.ts` — Edge case: WebSocket closed before cleanup fires — stream continues for visualization but recorder stopped (intentional design to preserve FFT). No explicit error recovery if MediaRecorder.start() fails post-reconnect. CustomEvent dispatch sylphie:voice_text lacks consumer validation — assumes window listener exists. mimeType negotiation prefers audio/webm;codecs=opus but falls back to audio/webm; backend codec handling must match or decode fails silently.
- `frontend/src/hooks/useAutoScroll.ts` — behavior parameter is read but not actually used in the scroll operation (line 29 voids it for lint purposes); dependency array uses eslint-disable which bypasses React hooks rules; scrollIntoView explicitly avoided in favor of manual scrollTop assignment to prevent page-level scrolling
- `frontend/src/hooks/useDevMode.ts` — Relies on Vite build-time env injection; any typo in VITE_APP_MODE or unexpected value will incorrectly enable dev mode. No fallback if env is undefined.
- `frontend/src/hooks/useDriveOverrides.ts` — handleOverrideToggle uses overrideValues and pressure as deps but never sets overrideValues when disabled (sets to 0 locally but doesn't update state before POST); error handling is silent console.error only, no user feedback or retry logic for failed API calls; debouncedPost never validates response status.
- `frontend/src/hooks/useFEAgentChat.ts` — Chat history window hardcoded to last 6 entries; no persistent storage; error handling swallows unknown error types with generic message; getSnapshot() called fresh per submission without validation
- `frontend/src/hooks/useKgSnapshot.ts` — Silent error handling may mask backend availability issues; no retry logic or exponential backoff; OKG/SKG polling interval (10s) may cause unnecessary network load if data rarely changes
- `frontend/src/hooks/useNeighborhood.ts` — Silent error handling (setState to null/false on non-AbortError) may mask real failures. No retry logic. truncated field defaults to false if missing from response.
- `frontend/src/hooks/useNodeSearch.ts` — fetch error handling silently empties results on non-AbortError; AbortErrors suppressed (intended behavior for cancellations); no explicit error state exposed to caller
- `frontend/src/hooks/useObservatoryAlerts.ts` — Dedicated /api/metrics/observatory/alerts endpoint is noted as future-sprint feature but not yet implemented; currently always falls back to deriving from /api/metrics/health. Dismiss callback creates new Set on each call which could trigger renders; dismissed state is tracked but never filtered from alerts display.
- `frontend/src/hooks/useObservatoryData.ts` — No error handling for network failures beyond fallback empty objects; Promise.all catches layer is belt-and-suspenders and unreachable per design; adaptSession assumes metricsSnapshot keys are flat (no nested validation); dev stage response passed raw to state without adapter (inconsistent pattern vs other endpoints).
- `frontend/src/hooks/usePerception.ts` — (1) Fallback from VWM entities to raw YOLO detections when VWM absent — YOLO is sensory hints, not knowledge, marked discovered:false; (2) friendlyLabel() normalizes underscore-delimited YOLO labels; (3) No labels on object/face geometry layers — identity labels only in tracking layer driven by VWM; (4) FACE_OCCLUDED events have no body, just bbox + '?' indicator; (5) Canvas/video dimensions sync on every frame; (6) ws.onerror does not close connection, allowing feed to continue; (7) Multiple refs (detections, faces, connections, tracked objects) updated from WebSocket message without state — mutations only, no re-render triggers.
- `frontend/src/hooks/usePressureStatus.ts` — Two independent state derivation paths (store + API polling) may diverge if API lags or WebSocket and polling return inconsistent data; no reconciliation logic between them. API error handling silently defaults rather than reporting error state.
- `frontend/src/hooks/useProgressiveSnapshot.ts` — Falls back to legacy endpoint without warning if paginated routes 404; fingerprint check is shallow (count-only, no content hash); error handling catches AbortError separately but swallows other network errors into legacy fallback cascade; no retry logic, single attempt per load cycle
- `frontend/src/hooks/useSessionTimer.ts` — No error handling if startTimestamp is invalid (negative, future, NaN); no memo/useMemo on the formatting logic, so the string is recreated on every interval tick even if the formatted output is identical to the previous tick.
- `frontend/src/hooks/useSkillPackages.ts` — Network errors caught but logged only to console, not surfaced in detail. Snapshot fetch (refreshGraphState) swallows errors silently with only console.error. No timeout or retry logic on fetch calls. resetStatus state not auto-cleared on new reset — caller must clearStatus() or it persists.
- `frontend/src/hooks/useTelemetryBuffer.ts` — stateCounts dict is computed but only used for extracting dominantState; entry.driveEntropy and entry.dominantDrive fields are declared in interface but never written or used in hook logic (dead fields)
- `frontend/src/hooks/useVoiceRecording.ts` — Legacy API path (transcription_text) dispatches message directly without confidence gate; modern path uses processTranscriptionResult(). CustomEvent('sylphie:voice_text') pattern for decoupled WS communication (comment notes simpler alternatives like store action). audioCleanupRef tracks only ONE audio playback at a time, revokes prior on new. playAudioBase64 catches and logs silently on decode/playback error, returns no-op cleanup. No explicit error recovery if transcribe endpoint connection fails permanently.
- `frontend/src/hooks/useWebRTC.ts` — ESLint disable on exhaustive-deps (line 349) suggests autoConnect dependency intentionally suppressed; reconnect loop can retry indefinitely while pcRef.connectionState !== closed; remoteDescription null-check gates ICE candidate add (line 205) to avoid errors before SDP; no explicit max reconnect attempts—only stops on full peer close; chat-like fallback to MJPEG feedMode on getUserMedia failure (line 309) but no guarantee remote decodes it
- `frontend/src/hooks/useWebSocket.ts` — WS4 T6 queue-position logic only on conversation socket; graph socket refetch omits re-fetch on initial connect (only on reconnect); conversation socket uses oldWs=wsRef.current then nulls ref before close to prevent double-delivery race; snapshot message handler accepts both cobeing-v1 {snapshot:{...}} and legacy {data:{...}} formats; thinking_indicator on conversation clears queue position when is_thinking=true; no explicit error handling for failed snapshot fetch (logs only)
- `frontend/src/layouts/DashboardLayout.tsx` — voice fetch has no retry logic; supervisor panel open state toggles via setSupervisorOpen(false) only (no open control from props)
- `frontend/src/lib/analytics.ts` — Module-scoped posthog and posthogReady variables persist across hook invocations; no cleanup/teardown logic; relies on environment variables that may be unset; no error handling if PostHog init fails.
- `frontend/src/main.tsx` — Root element with id='root' must exist in index.html; non-existent element would crash. initAnalytics() runs synchronously before React render, blocking mount if it fails. No error handling around ReactDOM.createRoot or render.
- `frontend/src/pages/LoginPage.tsx` — No input validation beyond required/empty check on client side; error handling relies entirely on server response.message; no CSRF token or rate-limiting; loading state set but network timeout unhandled (finally runs but no explicit timeout); hardcoded API paths (/api/auth/register, /api/auth/login) with no env-based config
- `frontend/src/pages/dashboard/AnalyticsView.tsx` — No error boundaries; no loading/fallback states; assumes all child panels render synchronously without network suspension; Observatory dialog height hardcoded to 80vh (responsive breakpoint not handled).
- `frontend/src/pages/dashboard/CodebaseView.tsx` — Progressive snapshot uses 30s throttle window — large PKG updates may batch visibly. Cytoscape layout randomization only when no modules are expanded. Text wrapping to 100px max-width may truncate long names. No error boundary for snapshot/cytoscape failures. Search result pan uses hardcoded 500ms setTimeout, may race if graph layout is slow. Module child counts shown only in collapsed state label. Hierarchy rebuild is O(nodes + edges) every time pkgData changes — could be slow for very large graphs.
- `frontend/src/pages/dashboard/GraphsView.tsx` — AmbientView is lazy-loaded but no explicit error boundary; relies on Suspense fallback. OKG/SKG empty messages assume data structure {nodes, edges} but no validation that okg.data or skg.data conform. No handling for useProgressiveSnapshot errors or polling failures. PanelHeader receives optional nodeCount/edgeCount but formatting assumes numeric values without null checks. WkgViewSwitcher component behavior not visible here — view mode switching logic is delegated.
- `frontend/src/pages/dashboard/GuardianView.tsx` — Silent catch blocks on all fetch (rules, tensor) - errors go unlogged; tensor refresh interval never cancelled if component unmounts during interval (useRef cleanup present but leaks if promise hangs); effect JSON parsing fallback assumes DSL string if parse fails; no pagination/virtualization for rules lists (unbounded render); category agreement case-sensitivity (lowercase check but display preserves original); modelState extraction assumes 'parameters' field in state objects
- `frontend/src/services/feAgent.ts` — No error handling if stream fails mid-response; dangerouslyAllowBrowser=true relies on trusted browser; VITE_ANTHROPIC_API_KEY in env is single point of failure; no conversation persistence (history managed by caller); system prompt knowledge of drives/executor/cognition may drift from actual Sylphie implementation
- `frontend/src/store/index.ts` — messageCounter is module-scoped let, survives slice-capping but survives resets; action/prediction history timestamps differ (data.timestamp from event vs Date.now()/1000 for manual add); innerMonologue rawPayload is full stringified JSON (potentially large); explorerHistory is persisted in state but has no explicit garbage collection if app crashes during deep exploration; stasis detection only fires at 10 turns, may delay UX feedback
- `frontend/src/types/index.ts` — No external imports beyond native TS types; conversational grounding_ratio and is_grounded fields are nullable; GraphDelta.data is optional but many delta types depend on it; PendingTranscription confidence<0.5 gate is implicit (comment-only); SkillDto.predictionMae nullable; SkillPackage marked as legacy; RecognizedItem.discovered/nodeId/personId/duration/state all optional; no validation or schema enforcement in type definitions themselves

## Change log
- 2026-06-13 — Initial auto-generated map (72 files read in full).
