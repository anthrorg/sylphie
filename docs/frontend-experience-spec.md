# Sylphie Frontend — Two Experiences (Feature Spec / Pipeline Intake)

> **Status:** draft spec for build. Not built.
> **Purpose:** collapse the current incoherent multi-URL frontend into **two coherent
> experiences split by where Sylphie runs.** This doc states the model, the two user
> stories, the layout plainly, and the features of each workflow — concrete enough to
> decompose into pipeline/contract tickets.
> **Out of scope here:** the color scheme / visual token system (handled separately —
> see the cohesion-audit direction). This spec is layout + workflow + features only.

---

## 1. The model — deployment decides everything

There is one axis, not two. Where Sylphie runs determines who you are and what you get.

| | **Online (hosted, shared)** | **Local (installed, private)** |
|---|---|---|
| **Who** | Anyone. The public. | Whoever installed her. |
| **Role** | Visitor (bounded) | **Guardian** (self-designated on install — it's their copy, so unrestricted) |
| **Experience** | **The Test-Drive** | **The Instrument** |
| **The instance** | One **shared** Sylphie, growing in a public space | Your **own** Sylphie, growing privately with you |
| **Video / camera** | Off (removed from hosted build) | On — full sensory |
| **Limits** | Rate + time limited | None |
| **Privacy posture** | Zero-trust | Your machine |

Key consequences of Jim's ruling (2026-07-02):
- **No "guardian on hosted" surface.** Guardian == local. This removes an entire branch.
- **The online instance is one shared Sylphie** that everyone plays with and that grows in
  public. Local installs are **separate private instances**.
- **Video is a local-only capability** — it's the reason to download her (performance +
  privacy + a real product pull).

---

## 2. The two user stories

### Story A — The Guardian (local install)
> **As** the person running Sylphie locally,
> **I want** a complete diagnostic view of her — the tech and how it's (supposedly) working —
> where I can talk to her in a chat window for a few minutes and then switch to the
> observability layers and **see exactly how that conversation impacted her**,
> **so that** I can understand, verify, and steer her development with nothing hidden.

### Story B — The Visitor (online, hosted)
> **As** a curious visitor,
> **I want** to test Sylphie out in a space that tells me exactly what to expect — the privacy
> reality (zero-trust, don't share personal facts), my rate/time limits, a few headline
> metrics, and a view of the knowledge she's building **with me specifically** —
> **so that** I can get a genuine feel for what she is without being dropped into an
> operator's console or misled about what's real.

---

## 3. Layout, stated plainly

### 3A. The Instrument — local / guardian

Entry goes straight to the **Cockpit**. Depth is one click away, never in the way.
Five surfaces:

1. **Cockpit** (home)
   - Left: full conversation (chat, voice, teaching, guardian confirm/correct).
   - Right: **Impact rail** — updates live as she processes each turn; each of her turns is
     selectable and loads its full causal impact (see §4A "Impact of this turn").
   - Always-on strip: executor state · dominant drive · autonomy-so-far · cost tally.
2. **Her Mind**
   - All three knowledge graphs (World / Self / Other), full, with the node inspector.
   - Reasoning trace / inner monologue, working-memory selection, episodic memory.
3. **Her Growth**
   - The autonomy curve over the session's life (Type-1/Type-2 ratio), prediction accuracy
     (MAE), experiential-provenance ratio, graduation events, developmental stage.
4. **Timeline**
   - Scrub the whole session; replay any past turn's full impact after the fact.
5. **Instruments** (the ops bay)
   - Supervisor (live verdicts + controls: enable, sampling, burst, budget, interventions).
   - System + maintenance logs, raw telemetry.
   - Tensor cognition / bootstrap progress.
   - Guarded destructive controls (reset, skills) with confirm.

One rule across all five: **every number deep-links to its raw evidence** (no exceptions).

### 3B. The Test-Drive — online / public

A four-step pathway. No operator's console anywhere in it.

1. **Landing** (public, no wall)
   - Who she is, the honest status (what's real vs. still cooking), one "Meet her" button,
     and a secondary "run her locally" pointer.
2. **What to expect** (consent gate — shown before entering)
   - Zero-trust privacy pact: *don't share anything private; we're still hardening isolation.*
   - Early-development honesty: some things work, some don't — and we show which.
   - Your limits: ~N minutes / ~M messages, counter always visible. (Numbers = open decision.)
   - No camera on the hosted demo; vision runs locally.
   - What you teach stays a **candidate** until a guardian confirms it (shown as pending).
   - Enter deliberately (explicit acknowledge).
3. **Meet** (the test-drive)
   - Center: conversation. Her replies carry **grounding badges** (grounded / inferred /
     unsure) inline. "I don't know" is a first-class answer, not an error.
   - Her **mood** headline (one line, e.g. "curious, a little restless" — no drive internals).
   - **"What we're building"**: a small live graph of *this session's* candidate facts — the
     visitor's own knowledge slice, each marked "pending guardian."
   - One **autonomy headline** ("autonomy 6% · what's this?"), honest, explained on tap.
   - Budget indicator (time + messages remaining).
4. **Wrap** (limit reached)
   - "What we built together" — the session knowledge slice as a shareable keepsake.
   - Download / run-locally call to action + community links.

---

## 4. Features of each workflow

Concrete, buildable items. Group ≈ epics; each bullet ≈ a candidate ticket.

### 4A. Instrument (local / guardian)

**Cockpit**
- Conversation panel with voice (push-to-talk) and teaching input.
- Guardian confirm/correct affordance on facts (confirmation is what actually lifts a
  candidate to belief — Std-5).
- Selectable turns: clicking any of her turns loads its impact on the right.
- **"Impact of this turn"** causal readout, sourced from the TimescaleDB event spine
  (verbatim, no re-summarizing). For the selected turn, show what actually happened:
  - Drives moved (which, by how much, and the cross-modulation reason).
  - What she perceived at that moment (local: incl. visual frame).
  - Decision path: Type 1 / Type 2 / **SHRUG**, with her confidence.
  - Candidate facts staged + provenance stamp (SENSOR / GUARDIAN / LLM_GENERATED / …).
  - Grounding of her reply (grounded / inferred / unknown).
  - Episode recorded (if any).
  - Supervisor verdict (if that cycle was sampled).
  - Prediction she made, and — when the outcome lands — its accuracy (MAE).
  - LLM cost for the turn (tokens / $).
  - Whether this turn used the model at all (autonomy contribution).
- **Honest-offline rule:** where a subsystem is offline/broken/theater, the impact view
  states it ("tensor cognition: offline — no influence this turn") instead of inventing an
  effect. (Theater Prohibition, applied to the UI.)
- Always-on vitals strip (executor state, dominant drive, autonomy-so-far, cost tally).

**Her Mind**
- Three-graph view (WKG / SKG / OKG) with provenance + confidence on every node/edge.
- Node inspector with deep-link to the facts/edges behind a claim.
- Reasoning trace / inner monologue stream (verbatim telemetry).
- Working-memory activation view + episodic memory recall list.

**Her Growth**
- Autonomy curve (Type-1/Type-2 over session), live.
- Prediction accuracy (MAE) trend; experiential-provenance ratio.
- Graduation events feed (a decision moving Type 2 → Type 1) — milestone only when real.
- Developmental-stage indicator.

**Timeline**
- Session event timeline; scrub + jump to any turn.
- Replay a turn's full impact after the fact (re-uses the §4A impact component).

**Instruments**
- Supervisor: live verdict feed + controls (enable/disable, sampling rate, burst, daily
  budget, interventions where real; label unbuilt ones honestly).
- System + maintenance logs with level filtering.
- Tensor/bootstrap progress + training metrics.
- Guarded destructive actions (WKG reset, skills) behind confirm.

**Cross-cutting**
- Unify all of the above under one shell + token system (kills the current legacy grid /
  three dialogs / drawer / light-themed pop-out fragmentation).
- Deep-link rule enforced everywhere.

### 4B. Test-Drive (online / public)

**Landing**
- Public, unauthenticated. Story + honest status + "Meet her" + "run locally" pointer.

**What-to-expect / consent**
- Renders the privacy pact, limits, and what's on/off; requires explicit acknowledge.
- Copy is plain-language and honest (draft copy above; final wording TBD).

**Meet**
- Conversation with grounding badges on her replies; graceful "I don't know" state.
- Voice (push-to-talk) — *open decision whether to keep on public* (see §7).
- Her mood headline (single line; no internals).
- **User-relative knowledge slice**: live mini-graph of only this session's candidate facts,
  marked pending-guardian.
- One autonomy headline with on-tap explainer.
- Budget indicator (time + messages), enforced.

**Wrap**
- Session-knowledge keepsake + download/community CTAs.

**Cross-cutting (public)**
- **Hide** everything operator-grade: other users' data, drive internals, supervisor,
  raw telemetry, cost, controls.
- **Enforce** zero-trust: candidate-only staging, no cross-user reads.
- **No video** in the hosted build.

---

## 5. Capability summary (build target)

| Capability | Online (public) | Local (guardian) |
|---|---|---|
| Chat (text) | ✓ | ✓ |
| Voice (push-to-talk) | ✓ (privacy-gated; open decision) | ✓ |
| Video / camera perception | ✕ (removed from hosted) | ✓ |
| Her mood | headline only | full detail |
| Grounding badges | ✓ | ✓ |
| Autonomy | headline | headline + full curve |
| Knowledge graph | your session slice only | all three, full |
| Drive internals / reasoning trace | ✕ | ✓ |
| "Impact of this turn" | ✕ | ✓ (signature) |
| Supervisor / telemetry / tensor | ✕ | ✓ |
| Destructive controls | ✕ | guarded + confirm |
| Rate / time limit | enforced | none |

---

## 6. Constraints & honest boundaries (must hold)

- **Theater Prohibition in the UI:** never show a number that isn't earned; where a subsystem
  is offline/theater, say so. The honest low autonomy (~6%) is the hero, not a fake high one.
- **Zero-trust is a real requirement, not caution theater:** person-fact isolation has a
  *known open leak* (WKG person-fact leak), so the public build must enforce candidate-only
  staging + no cross-user reads, and state the disclaimer plainly.
- **Public launch is gated** (from architect ruling AD-0043) on: closing the anonymous
  destructive endpoints, getting the Anthropic key out of the served bundle, and fixing the
  zombie socket reconnect. Owner: `sentinel`.
- **Video is local-only** — remove from the hosted build entirely.
- **Deep-link rule** (guardian): every stated number reaches its raw evidence.

---

## 7. Open decisions (need Jim)

1. **Rate/time limits — real numbers?** (~10 min / ~20 messages is a placeholder.)
2. **Public session persistence?** Ephemeral at session end (cleanest for zero-trust) vs.
   a lightweight account so a returning visitor continues. Lean: ephemeral now.
3. **Voice on the public build — keep or cut?** Video is cut; voice is a live mic in a
   zero-trust space. Lean: keep push-to-talk (transcribed, not stored).
4. **Guardian self-designation on local** — automatic on first run, or an explicit toggle?

---

## 8. Reuse — the good basis already in the repo

Most building blocks exist; the work is cohesion + the two-audience gating + the Impact view,
not greenfield. Existing pieces to reuse/reorganize (from the live frontend audit):
- Chat: `ConversationPanel` (grounding badges already present).
- Graphs: `GraphPanel` / `ExplorerView` / `NodeInspector` (WKG/OKG/SKG).
- Drives/mood: `DriveRadarChart` / `DrivesPanel` / `MiniDriveChart`.
- Growth/metrics: `ObservatoryDashboard` (autonomy, provenance, dev stage), `MetricsPanel`.
- Reasoning/logs: `InnerMonologuePanel`, `SystemLogsPanel`, `MaintenanceLogsPanel`.
- Supervisor: `SupervisorPanel` / `VerdictCard`.
- Perception (local only): `CameraPanel` / `usePerception`.
- Alerts: `AttractorAlertBanner`.

New to build: the **role/deployment gate** (public vs guardian shell), the **"Impact of this
turn"** causal readout + **Timeline** replay, the **What-to-expect/consent** screen, the
**user-relative knowledge slice** for public, and **hosted video removal**.

---

## 9. Suggested epic breakdown (for the pipeline / contract)

1. **EP — Shell & role gate:** one unified app shell; public vs guardian (local) routing;
   retire the legacy dashboard.
2. **EP — Guardian Cockpit & Impact:** cockpit layout + "Impact of this turn" + honest-offline.
3. **EP — Guardian depth surfaces:** Her Mind, Her Growth, Timeline, Instruments (reorganized).
4. **EP — Public Test-Drive:** Landing, What-to-expect, Meet, Wrap + user-KG slice + limits.
5. **EP — Hosted hardening (sentinel):** video removal, zero-trust enforcement, launch-security
   preconditions (AD-0043).
6. **EP — (later) Visual token system / color** — deferred, tracked separately.
