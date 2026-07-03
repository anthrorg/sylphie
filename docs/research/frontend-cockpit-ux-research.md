# Guardian Cockpit — UI/UX Research & Pattern Brief

> **Type:** Findings report (research, not a verdict). Produced by `opus-agent`.
> **Purpose:** Design-lock research to unblock pipeline item `feature-fe-guardian-cockpit-and-impact`.
> **Routing:** Hand to `architect` for the design-lock ruling. Nothing here is binding until Fable rules.
> **Grounds:** `docs/frontend-experience-spec.md` §3A/§4A (the requirement); the live data surfaces
> (TimescaleDB event spine, three Neo4j graphs, 12-drive state, dual-process decisions, predictions/MAE,
> autonomy curve, supervisor, cost); the existing frontend components enumerated in that spec §8.
> **Honesty constraint (CANON, non-negotiable):** Theater Prohibition applies to the UI. Offline / unknown
> / theater states are first-class in every pattern below — never faked, never blanked.

---

## 1. Executive summary + recommended organizing model

**The ask, restated:** one instrument that does three things without three separate tools — (1) **pure stats at a glance**, (2) **causal drill-down** ("I chatted for a few minutes; show me exactly how that changed her"), and (3) **search everything she has ever stored and track it down**. Jim's constraint: *use every space — negative space is not what we want in a cockpit*; utility-first, maximally helpful.

**Verdict on the "debugger for a mind" model: validate it as the spine of the causal mode, but do not let it be the whole cockpit's metaphor.** It is the single best analog for mode (2) and I recommend building the causal core literally as a time-travel debugger. But a debugger is a poor top-level frame for the glance layer (debuggers have no vitals/at-a-glance culture) and only a partial frame for search. Forcing all three modes under one metaphor will strain.

**Recommended organizing model — one primitive, three lenses, one honest shell:**

- **The unifying primitive is the *selected turn* — a program counter over the conversation-as-execution-trace.** Everything in the cockpit is bound to "which turn are we looking at." This is the mechanism (from Grafana's global time range, the DAW playhead, and time-travel debuggers' current-point-of-execution) that fuses the three modes into one tool rather than three dashboards. Move the turn-selection and the *entire cockpit re-scopes* to that instant.
- **Lens A — Glance = flight deck.** A persistent, status-by-exception vitals strip/rail. Stable layout, small-multiples + sparklines, tabular numerics, severity-by-exception. Borrowed from mission control and trading terminals.
- **Lens B — Causal = time-travel debugger.** "Impact of this turn" is *stepping into a frame and inspecting state at that instant.* Call stack → her cognitive cycle; watch window → drives/predictions; step → turn navigation; breakpoints → her pathology/attractor detectors; console → search. This is the signature surface and the hardest one; build it as a real debugger, not a report card.
- **Lens C — Search = observability query surface + command palette.** A command-line pivot (Bloomberg mnemonic / VS Code Cmd-K / Honeycomb query) that queries her whole recorded life (event spine + 3 graphs + logs + drives + predictions) and **re-scopes the cockpit to the result** (Honeycomb heatmap→BubbleUp→exemplar drill, without losing context).
- **The shell is honest by construction.** Mission-control status-by-exception means most cells are quiet until something is off; and every subsystem has a first-class *offline / unknown / theater* rendering that is visually distinct from an earned zero.

**One-line statement for the design-lock:** *The guardian cockpit is a flight deck wrapped around a time-travel debugger, with an observability command line — all three bound to a single selected-turn scrubber, and every panel able to say "offline / unknown" as loudly as it says a number.*

Why this beats "pure debugger" or "pure dashboard": a pure dashboard (Grafana-only) nails glance + search but has no notion of "step into this turn and inspect her state" — it cannot answer Jim's core question. A pure debugger nails causal but has no vitals culture and no free-text search-everything. The hybrid keeps each mode's best-in-class metaphor while the shared turn-scrubber makes them one instrument.

---

## 2. Exemplar teardowns — concrete, transferable patterns

### 2.1 Trading terminals (Bloomberg)
- **Density is the product, not a flaw.** The Terminal is the canonical "great information-dense app," explicitly contrasted with whitespace-first web design ([HN teardown](https://news.ycombinator.com/item?id=19153875)). Transferable: in a cockpit, packed-but-legible is the expected aesthetic; do not import consumer-web whitespace norms.
- **Legibility engineered at the glyph level.** The Terminal commissioned a bespoke monospace (Matthew Carter) rendered thicker specifically for readability at density ([Bloomberg color-accessibility](https://www.bloomberg.com/company/stories/designing-the-terminal-for-color-accessibility/)). Transferable: **numeric columns in a monospaced / tabular-nums font** so digits align and scan; this is the single cheapest density win.
- **Color is semantic, and accessibility-bounded.** Bloomberg rebuilt its color framework for color-vision-deficiency because color *carries meaning* (direction, severity) and a bad palette is a functional failure, not a cosmetic one ([Bloomberg color-accessibility](https://www.bloomberg.com/company/stories/designing-the-terminal-for-color-accessibility/)). Transferable: reserve color for **state/severity/direction only**; never decorative. Pair color with a second channel (icon/shape/position) so meaning survives CVD.
- **Command-line mnemonic pivot.** Function-code navigation (type a mnemonic, jump anywhere) is the power-user spine — keyboard-first, no menu hunting. Transferable directly to Lens C.
- **Change rolls out incrementally because muscle memory is sacred.** Redesigns ship in slow increments because users make mission-critical decisions and hate layout churn. Transferable: **the cockpit layout must be stable** — power comes from memorized positions, not rearrangeable widgets.

### 2.2 Observability platforms (Grafana, Honeycomb, Datadog, Kibana)
- **Global time range binds every panel (Grafana).** A single time-range control is a variable every panel query interpolates (`$__from`/`$__to`); change it once and *every element updates* ([Grafana variables](https://grafana.com/docs/grafana/latest/visualizations/dashboards/variables/), [global variables](https://grafana.com/docs/grafana/latest/visualizations/dashboards/variables/global-variables/)). **This is the mechanism for our shared turn-scrubber.** Transferable exactly: one selected-turn/time value that every cockpit panel reads.
- **Template variables = dashboard-level pivots.** Dropdowns/vars at the top re-scope the whole board without editing it ([Grafana use-dashboards](https://grafana.com/docs/grafana/latest/visualizations/dashboards/use-dashboards/)). Transferable: a "which subject / which graph / which drive" selector re-scopes the cockpit.
- **Small multiples via repeated panels (Grafana).** Same viz repeated per variable value gives instant visual comparison ([Grafana variables](https://grafana.com/docs/grafana/latest/visualizations/dashboards/variables/)). Transferable: render the **12 drives as a 12-up small-multiple of sparklines**, not one cluttered chart, for at-a-glance scanning.
- **The Core Analysis Loop (Honeycomb): the canonical drill-without-losing-context.** Define → Visualize (confirm the anomaly is real) → Investigate (group/filter within the anomalous region) → Evaluate (does this dimension explain it? if not, refilter) ([Honeycomb core analysis loop](https://docs.honeycomb.io/get-started/basics/observability/concepts/core-analysis-loop)). **BubbleUp:** drag-select an outlier region on a heatmap; it computes every dimension *inside* the box vs the *baseline* outside and ranks by percent-difference, shown as baseline-vs-anomaly histograms ([Honeycomb BubbleUp](https://www.honeycomb.io/platform/bubbleup)). Crucially, "**the selected region remains bounded while dimensional analysis deepens**" — context is preserved. Transferable: **drill happens in place**; selecting an anomalous turn/metric expands explanation *around* the selection, it does not navigate away.
- **Exemplar traces:** click anywhere on the heatmap to recall one concrete request matching that shape "from millions" ([Honeycomb core analysis loop](https://docs.honeycomb.io/get-started/basics/observability/concepts/core-analysis-loop)). Transferable: from any aggregate metric, click to jump to **the actual turn** that produced it — this is the deep-link-to-raw-evidence rule the spec §3A already mandates.
- **Natural-language / assistted query (Query Assistant).** "slow endpoints by status code" → a real query to iterate on ([Honeycomb query assistant](https://www.honeycomb.io/blog/introducing-query-assistant)). Transferable (optional): a plain-English entry into her recorded life, but keep the structured query visible so results stay honest and inspectable.

### 2.3 Mission control / flight decks
- **Status by exception.** Normal telemetry is *not* shown; only critical always-on values (O2, battery, water) persist, and abnormalities surface loudly ([Beyond LunAR, arXiv 2011.14535](https://arxiv.org/pdf/2011.14535)). Transferable: the vitals strip shows a **small always-on set** (executor state, dominant drive, autonomy-so-far, cost) and everything else stays quiet until it deviates — density without noise comes from *silence being the default*.
- **Tiered alarm surfacing.** Critical → whole UI flashes red; important-but-not-critical → corner warning, no full flash ([Beyond LunAR](https://arxiv.org/pdf/2011.14535)). Transferable: her attractor/pathology alerts get a **severity ladder**, not a single alarm style. (`AttractorAlertBanner` already exists — give it tiers.)
- **Comprehension via shape+color+position+behavior together.** Operators read state through *combined* channels, so anomalous states are instantly visible ([Human Factors in Satellite Ops, arXiv 2110.04880](https://arxiv.org/pdf/2110.04880)). Transferable: encode severity redundantly (never color alone).
- **Persistent, stable display priorities.** Live feed, groundtrack, alarms, clocks/next-events — fixed positions operators trust. Transferable: fixed regions; the guardian should always know where to look.

### 2.4 Debuggers / profilers / time-travel debuggers — *the closest analog; mine hard*
- **Record-and-replay = deterministic re-inspection of any past state.** rr / Replay record all non-deterministic inputs, then replay to reconstruct *any prior state* ([Undo/rr](https://undo.io/resources/gdb-watchpoint/time-travel-debugging-rr-debugger/), [Replay how-it-works](https://docs.replay.io/basics/time-travel/how-does-time-travel-work)). **This is precisely our TimescaleDB event spine** — verbatim per-turn telemetry, no re-summarization, is exactly a recording you can replay. The spec's "replay a turn's impact after the fact" is literally reverse execution over the spine.
- **Everything is inspectable at any moment.** In Replay, component state, stores, and local variables are inspectable "at any moment in the recording," and you see the *actual* DOM at that instant, not a reconstruction ([Replay debugging](https://www.replay.io/debugging)). Transferable, and it maps cleanly onto the honesty rule: show **her actual recorded state at the selected turn**, never a re-derived guess.
- **Reverse-step to inspect state *before* an effect.** `reverse-next` lands you at the line before a breakpoint; "hit a crash, then go backwards to inspect state before it" ([Undo/rr](https://undo.io/resources/gdb-watchpoint/time-travel-debugging-rr-debugger/)). Transferable: from a bad outcome (a wrong prediction, a hostile appraisal, a low-confidence SHRUG) step *backward* to see the state that led there.
- **Flame charts = state of the stack at every instant + scrubbing.** A flame chart shows the call stack over time (x = time, y = stack depth); "move your mouse left and right to replay the recording — scrubbing" ([Chrome DevTools performance reference](https://developer.chrome.com/docs/devtools/performance/reference), [analyze runtime performance](https://developer.chrome.com/docs/devtools/performance)). Transferable: a **scrubbable timeline of turns** where hovering previews the cognitive-cycle "stack" of that turn.
- **Perfetto: one timeline, many stacked tracks, all sharing an x-axis of time.** CPU samples become flamegraph tracks aligned on a common timeline ([Perfetto formats](https://perfetto.dev/docs/getting-started/other-formats)). Transferable: stack her subsystems as **aligned tracks under one turn-timeline** (drives track, decision track, prediction track, cost track) — DAW-like, but for cognition.
- **The debugger primitive map (used in §7):** call stack, watch window, step/step-into, breakpoints, console — each has a clean Sylphie counterpart.

### 2.5 DAWs / IDEs — dense-but-usable multi-pane
- **Multitrack + one playhead.** Stacked tracks share a timeline; a single vertical playhead sweeps left→right and triggers each track's content as it passes ([DAW Wikipedia](https://en.wikipedia.org/wiki/Digital_audio_workstation), [DAW basics/Fiveable](https://fiveable.me/music-production-and-recording/unit-1/basic-daw-operations-interface-navigation/study-guide/rXaKlZcs8grfekB5)). **This is the visual model for the shared turn-scrubber over stacked subsystem tracks.**
- **Transport as a fixed, memorized control.** Play/pause/rewind/loop in a fixed transport panel — muscle memory ([DAW basics/Fiveable](https://fiveable.me/music-production-and-recording/unit-1/basic-daw-operations-interface-navigation/study-guide/rXaKlZcs8grfekB5)). Transferable: fixed turn-transport (prev turn / next turn / jump-to-live / loop-a-range).
- **"Views" switch perspective over the same project** (arrange / mix / edit) ([DAW basics/Fiveable](https://fiveable.me/music-production-and-recording/unit-1/basic-daw-operations-interface-navigation/study-guide/rXaKlZcs8grfekB5)). Transferable: our three lenses are three *views* of the same recording, not three apps — matching spec's five surfaces sharing one shell.
- **Keyboard shortcuts are the workflow** (split/zoom/toggle-mixer). Transferable: cockpit navigation is keyboard-first.

### 2.6 Command palette (VS Code / Superhuman) — the search-pivot mechanism
- **One universal shortcut, available everywhere, restores focus on dismiss** ([Superhuman](https://blog.superhuman.com/how-to-build-a-remarkable-command-palette/)). Transferable: a single Cmd-K opens the cockpit's query line from any lens.
- **Fuzzy match with forgiveness + synonyms; show the matched alias** ("Mark Done (Archive)") ([Superhuman](https://blog.superhuman.com/how-to-build-a-remarkable-command-palette/)). Transferable: querying "hostility" should also find "hostile appraisal," "threat drive"; show what it matched so results stay honest.
- **Context-aware ranking and hiding** — boost relevant commands by current view/state, hide fully-irrelevant ones ([Superhuman](https://blog.superhuman.com/how-to-build-a-remarkable-command-palette/)). Transferable: when a turn is selected, bias search toward that turn's entities.
- **The palette teaches its own shortcuts** (shows the keybind beside each result) ([Superhuman](https://blog.superhuman.com/how-to-build-a-remarkable-command-palette/), [VS Code command palette](https://stevekinney.com/courses/visual-studio-code/vscode-command-palette)). Transferable: the guardian graduates from mouse to keyboard for free.
- **Monospace + centered "visual authority" + intentional cutoff** (implies more below) ([Superhuman](https://blog.superhuman.com/how-to-build-a-remarkable-command-palette/)). Minor but consistent with the terminal aesthetic.

### 2.7 Density theory (Tufte) — the enforceable rules under all of the above
- **Data-ink ratio:** maximize ink that encodes data; erase non-data ink; "chartjunk" is useless/obscuring decoration ([Tufte principles/EDAV](https://jtr13.github.io/cc19/tuftes-principles-of-data-ink.html), [Tufte/Wikipedia](https://en.wikipedia.org/wiki/Edward_Tufte)). Transferable: **Jim's "use every space" ≠ add decoration; it means raise data density.** Fill space with *more earned data*, not chrome.
- **Small multiples:** many small comparative panels beat one busy chart — "comparative, multivariate, shrunken, high-density" ([Tufte/Wikipedia](https://en.wikipedia.org/wiki/Edward_Tufte)).
- **Sparklines:** a datapoint-word conveying trend inline; "sparklines improve the attention span of tables" ([Tufte/Wikipedia](https://en.wikipedia.org/wiki/Edward_Tufte)). Transferable: **every KPI carries an inline sparkline of its own history** — trend at zero extra space.
- **Data density = entries ÷ area.** The metric to optimize is legitimate data per pixel — the quantitative form of Jim's no-negative-space rule.

---

## 3. Pattern library mapped to Sylphie's three modes + the shared control

### 3.0 The shared turn/time control (fuses all three modes)
- **One selected-turn value, globally bound** (Grafana global time range + DAW playhead). Selecting a turn re-scopes every panel to that instant. Live mode = "follow the playhead" (auto-advance to newest turn); pause to inspect.
- **Rendered as a scrubbable turn-timeline** (flame-chart scrubbing) with a fixed transport (prev/next/jump-to-live/loop-range). Hover = preview; click = commit selection.
- **Two clocks, always visible** (mission-control): wall-clock/"live" indicator and the selected-turn marker, so the guardian never confuses "now" with "the turn I'm inspecting."

### 3.1 GLANCE (flight-deck vitals)
| Pattern | Source | Sylphie mapping |
|---|---|---|
| Always-on critical few, status-by-exception | Mission control | Vitals strip: executor state · dominant drive · autonomy-so-far · cost tally (spec §3A). Everything else quiet until deviating. |
| Small multiples | Tufte / Grafana repeat | 12 drives as a 12-up sparkline grid; not one radar blob. |
| Inline sparkline per KPI | Tufte | Autonomy %, MAE, graph node counts each carry a trend sparkline. |
| Tabular-nums / monospace numerics | Bloomberg | All numeric columns align and scan. |
| Severity via redundant encoding | Mission control / Bloomberg CVD | Color + icon + position for state; never color alone. |
| Tiered alarm ladder | Mission control | Attractor/pathology alerts: corner-warn vs full-surface; reuse `AttractorAlertBanner` with tiers. |

### 3.2 CAUSAL (time-travel debugger) — "Impact of this turn"
| Debugger primitive | Source | "Impact of this turn" surface (spec §4A) |
|---|---|---|
| Current execution point | rr / Replay / DevTools scrub | The selected turn = program counter over the event-spine recording. |
| Inspect actual state at instant (not reconstruction) | Replay | Show her *recorded* state at that turn: drives moved (which/how much/cross-modulation reason), perception snapshot (local: visual frame), decision path (Type1/Type2/SHRUG + confidence), candidate facts staged + provenance stamp, reply grounding, episode recorded, supervisor verdict, prediction made, cost, model-used? |
| Watch window | DevTools / GDB | Pin drives / a prediction / a fact across turns and watch it change as you step. |
| Step / step-into / reverse-step | rr `reverse-next` | Next/prev turn; reverse-step from a bad outcome to the state that caused it. |
| Drill in place, context preserved | Honeycomb BubbleUp | Expanding a cause (e.g. "why did threat spike?") deepens *around* the selection; never navigates away. |
| Exemplar → raw evidence | Honeycomb exemplar | Every number deep-links to the verbatim event-spine row (spec's deep-link rule). |
| Stacked aligned tracks | Perfetto / DAW | Drives track / decision track / prediction track / cost track under one turn-timeline. |

### 3.3 SEARCH (observability query + command palette)
| Pattern | Source | Sylphie mapping |
|---|---|---|
| Universal Cmd-K query line | Superhuman / VS Code | One entry to her whole recorded life: event spine + WKG/SKG/OKG + logs + drives + predictions. |
| Fuzzy + synonym, show what matched | Superhuman | "hostility" finds threat-drive/hostile-appraisal; display the matched alias for honesty. |
| Structured query + NL assist, structure stays visible | Honeycomb Query Assistant | Optional plain-English, but always render the resolved query so results are inspectable/earned. |
| Result re-scopes the whole cockpit | Grafana template vars | A search result (a fact, a turn, a subject) becomes the new global scope — timeline filters to it, graphs highlight it, vitals contextualize. |
| Drill from aggregate to the one exemplar | Honeycomb | From "MAE trend" click into the exact mispredicted turn. |
| Existing graph search reused | repo | `ExplorerSearchBar` / `ExplorerView` / `NodeInspector` become the graph-scoped facet of the global search. |

### 3.4 Honest offline / unknown / theater — first-class in every pattern
- **Three distinct visual tokens, never conflated:** *earned value* (normal), *earned zero* (real 0 / "she made no prediction"), and *unknown/offline/theater* (a subsystem didn't run, is broken, or is not-yet-real). An earned 0 and an "offline" must never render the same.
- **The impact view states absence explicitly** — spec's rule: "tensor cognition: offline — no influence this turn" instead of inventing an effect (spec §4A honest-offline rule). Pattern: every impact row can render an `OFFLINE`/`NOT SAMPLED`/`THEATER` chip in place of a value.
- **Status-by-exception makes honesty cheap:** an offline subsystem is a *deviation* and surfaces as such, rather than being silently blanked (blanking reads as "fine").
- **Confidence ceiling is shown, not hidden:** the 0.60 pre-guardian ceiling (CANON Std) renders as a visible cap on confidence bars, so the guardian sees why a fact is capped and that confirming it is what lifts it (Std-5).
- **Not-sampled ≠ passed:** supervisor verdicts only exist for sampled cycles; unsampled turns say "not sampled," never a green tick.

---

## 4. Density-without-noise — concrete, enforceable principles

1. **Fill space with data, not chrome (Tufte data-ink).** Jim's "use every space / no negative space" is satisfied by *higher data density*, not decoration. Enforce: every added pixel must encode an earned datum or be removed. Ban gradients, drop-shadows, oversized padding, decorative icons.
2. **Silence is the default (status-by-exception).** Density stays scannable because quiet = normal; only deviations draw the eye. A screen where everything shouts is noise; a screen where only the abnormal shouts is dense-and-calm.
3. **Hierarchy via type/weight/color/position, not whitespace.** Group by grid position and rule-lines (Bloomberg), differentiate by weight and a *tiny* semantic palette. Whitespace is a last-resort separator, used sparingly and deliberately even by dense tools.
4. **Numbers in tabular-nums/monospace, right-aligned.** Cheapest scannability win (Bloomberg).
5. **Trend inline via sparklines; comparison via small multiples.** Never spend a full chart where a sparkline does; never overplot where 12 small multiples read faster (Tufte).
6. **Color = meaning only, CVD-safe, redundantly encoded.** A fixed severity/direction palette; always pair color with icon/shape/position (Bloomberg CVD, mission control).
7. **One thing moves at a time.** The playhead/selected-turn is the only global motion; live-follow can be paused. Avoid independently animating panels (motion is expensive attention).
8. **Progressive disclosure with context preserved.** Detail expands *in place* around a selection (BubbleUp), it does not spawn modals/drawers that hide the parent — kills the current "three dialogs / drawer / pop-out" fragmentation the spec calls out (§4A cross-cutting).
9. **Stable, memorizable layout.** Fixed regions; power = knowing where to look + keyboard, not rearranging widgets (Bloomberg incremental-change discipline).
10. **Earned-only rendering.** No placeholder numbers, no zero-vectors dressed as data (repo CANON + stub-honesty value). Unknown renders as unknown.

---

## 5. Proposed cockpit layout + interaction model (design-lock candidate)

A single-shell, fixed-region layout. Coordinates are relative; forge to tokenize spacing later (color/token system is explicitly out of scope per spec §0).

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ VITALS STRIP  executor · dominant-drive · autonomy-so-far · cost · [LIVE ●]    │  ← flight deck, always-on, status-by-exception
├───────────────────────────────┬──────────────────────────────────────────────┤
│  A. CONVERSATION (left)        │  B. IMPACT OF THIS TURN (right rail)          │
│  chat / voice PTT / teaching   │  time-travel "inspect state at this turn":    │
│  each of HER turns selectable  │  drives moved (Δ + cross-mod reason)          │
│  guardian confirm/correct      │  perception snapshot (local: frame)           │
│  grounding badges inline       │  decision path Type1/Type2/SHRUG + conf       │
│  [selected turn highlighted]   │  candidate facts + provenance stamp           │
│                                │  reply grounding · episode · supervisor       │
│                                │  prediction + (later) MAE · cost · model-used?│
│                                │  every row → deep-link to event-spine row     │
│                                │  offline rows say "offline — no influence"    │
├───────────────────────────────┴──────────────────────────────────────────────┤
│  C. TURN-TIMELINE SCRUBBER  ◀◀ ◀ ▮ ▶ ▶▶  jump-to-live · loop-range             │  ← DAW transport + flame scrub
│  stacked aligned tracks: [drives][decision][prediction/MAE][cost][alerts ▲]    │  ← Perfetto-style tracks, shared x = turns
└──────────────────────────────────────────────────────────────────────────────┘
   Cmd-K → COMMAND LINE (search everything; result re-scopes the whole cockpit)     ← Superhuman/Bloomberg pivot
```

**The interaction spine:**
1. **Guardian chats** (region A). Live mode: the playhead follows the newest turn; the Impact rail (B) and tracks (C) advance in real time.
2. **Guardian selects one of her turns** (click in A, or scrub in C, or arrow-keys). *The whole cockpit binds to that turn* (Grafana global-range mechanic): B shows that turn's full recorded state; C marks the point; vitals show the value *as of* that turn.
3. **Drill in place** (B). Expanding a cause (e.g. "threat +0.18 — why?") deepens *around* the row (BubbleUp), showing the cross-modulation inputs and the verbatim event-spine evidence — no modal, parent stays visible.
4. **Step** through turns (transport / arrows): next/prev; **reverse-step** from a bad outcome to its cause. Watch-pin any drive/prediction/fact to track it across steps.
5. **Search everything** (Cmd-K): query her whole life; a result **re-scopes the cockpit** — timeline filters to matching turns, graphs highlight matching nodes, B contextualizes. From any aggregate (MAE trend, graph growth) click through to the exemplar turn.
6. **Depth is one click, never in the way** (spec §3A): the five surfaces (Cockpit / Her Mind / Her Growth / Timeline / Instruments) are **views over the same recording bound to the same selected turn** (DAW view-switching), not separate apps. "Her Mind" is the graphs+inspector at the selected turn; "Timeline" is the full-session scrub; "Instruments" is the ops bay.

**Breakpoints (her pathology/attractor detectors):** the alerts track (C) and tiered banner surface an attractor/pathology event as a marker on the timeline; clicking it *jumps the playhead there and opens B on that turn* — i.e. "execution broke here, inspect the state." This is the debugger-breakpoint primitive made literal and is a strong, honest use of the model.

**Reuse map (spec §8 — mostly reorganize, not greenfield):**
- A ← `ConversationPanel` (grounding badges already present).
- B (**new — the signature build**) ← composed from `DrivesPanel`/`MiniDriveChart`, `InnerMonologuePanel`, `SupervisorPanel`/`VerdictCard`, `MetricsPanel`, sourced from the TimescaleDB event spine verbatim.
- C (**new**) ← turn-timeline + Perfetto-style tracks; drive track reuses `MiniDriveChart` data.
- Vitals ← `ObservatoryDashboard`/`MetricsPanel` distilled to the critical few.
- Her Mind ← `GraphPanel`/`ExplorerView`/`NodeInspector` bound to selected turn.
- Cmd-K search ← generalize `ExplorerSearchBar` to a global command line.
- Alerts ← `AttractorAlertBanner` given a severity ladder.

---

## 6. Anti-patterns / risks (explicitly avoid)

1. **Whitespace-as-polish / consumer-web padding.** Reads as "under-informed" in a cockpit and violates Jim's brief. Density = more data, not more air (Tufte).
2. **Decoration mistaken for density (chartjunk).** Gradients, 3D, glow, animated backgrounds add ink without data — the opposite of the goal.
3. **Everything-shouts.** If every cell is colored/bold/alarmed, nothing is legible. Status-by-exception or bust (mission control).
4. **Color-only encoding.** Fails CVD and fails at-a-glance under stress; always redundant-encode (Bloomberg CVD).
5. **Modal/drawer fragmentation** (the current legacy grid / three dialogs / drawer / pop-out the spec wants killed). Drill *in place*; never hide the parent.
6. **Rearrangeable-widget "flexibility."** Kills muscle memory; power users want a *stable* board (Bloomberg). Offer density/zoom, not layout chaos.
7. **Faking or blanking offline subsystems.** A blank cell reads as "healthy 0." CANON theater prohibition demands an explicit `OFFLINE/UNKNOWN/THEATER` token distinct from an earned zero. This is the single highest-risk failure mode for *this* product.
8. **Green-ticking un-sampled/un-earned states.** Supervisor "not sampled," confidence-capped facts, and no-prediction turns must say exactly that.
9. **Over-metaphoring.** Do not force glance and search into debugger vocabulary; the debugger metaphor is the causal core, not a costume for the whole app.
10. **A live-follow view that never lets you stop.** Inspecting a past turn requires *pausing* the playhead; auto-scroll that fights the guardian is noise.
11. **Search that navigates away.** Results must re-scope in place (Grafana/Honeycomb), not throw the guardian into a separate results page that loses the cockpit.

---

## 7. Validating "debugger for a mind" — the mapping, where it fits, where it strains

| Debugger primitive | Sylphie counterpart | Fit |
|---|---|---|
| Program counter / current line | Selected turn over the event-spine trace | **Strong** — the spine is a real recording; a turn is a real step. |
| Call stack | Her cognitive cycle for that turn (perceive → appraise drives → decide Type1/2/SHRUG → predict → act) | **Good** — a genuine ordered stack of frames; render as an expandable per-turn stack. |
| Watch window | Pinned drives / prediction / fact tracked across turns | **Strong.** |
| Step / step-into / reverse-step | Next/prev turn; expand a cycle stage; reverse-step from bad outcome | **Strong** — rr's reverse-execution maps cleanly to "why did she end up here?" |
| Breakpoints | Attractor / pathology detectors → timeline markers that jump-and-inspect | **Strong and honest** — a real, earned trigger, not decorative. |
| Console | Cmd-K search over her whole recorded life | **Good** — but this is really an *observability query*, richer than a REPL. |
| Watch/inspect "actual state, not reconstruction" | Verbatim event-spine rows (no re-summarization) | **Strong** — the no-re-summarize rule *is* Replay's "actual DOM, not a reconstruction." |

**Where it strains:**
- **Glance/vitals has no debugger analog.** Debuggers don't do at-a-glance health. Hence the flight-deck shell — don't debugger-ify the vitals.
- **"Step" over a *conversation* is coarser than over instructions.** A turn bundles many sub-events; mitigate by letting the per-turn stack expand into its cycle stages (step-into), but don't promise instruction-level granularity the spine doesn't record.
- **No re-execution / no counterfactuals.** A real debugger can re-run with changes; Sylphie's cockpit can only *replay* what happened (the spine is a recording, not a re-runnable program). Be honest: it is a **time-travel *inspector*, not a what-if simulator.** Don't imply the guardian can re-run a turn differently.
- **Search is bigger than a console.** Her "console" spans three graphs + logs + drives + predictions; it's closer to Honeycomb than to a GDB prompt. Build it as an observability query surface with a command-palette front door.

**Better organizing metaphor?** No single alternative beats the hybrid. Flight-deck-only loses causal; trading-terminal-only loses the step/replay; observability-trace-view is the closest *single* frame (it has time-range, drill, exemplars, query) but lacks the "step into a frame and read state" intuition that makes Jim's ask click. **Recommendation: keep "debugger for a mind" as the named model for the causal core, inside a flight-deck shell with an observability command line — and be explicit in the UI copy that it is a *time-travel inspector/replayer*, not a re-simulator.**

---

## 8. Open questions for architect / Jim

1. **Turn granularity.** Is "a turn" = one of her utterances (spec's selectable unit), or the full cognitive cycle behind it? Recommend: turn = her utterance; the cycle is *step-into* depth. Architect to confirm the event-spine's atomic unit supports this.
2. **Live-follow default.** Does the cockpit auto-follow the newest turn (DAW live-record) or stay where the guardian last parked? Recommend follow-with-easy-pause; confirm.
3. **Reverse-step scope.** How far back can the spine reconstruct state cheaply — whole session, or a rolling window? Affects whether reverse-step is "any turn ever" or "recent turns." Needs a data-surface answer (sentinel/atlas).
4. **NL query surface — in or out for v1?** Honeycomb-style Query Assistant is high-value but adds an LLM dependency and a theater risk (must show the resolved structured query). Recommend structured search v1, NL later.
5. **Watch-window persistence.** Do pinned watches persist across sessions? (Product decision.)
6. **Which "critical few" go in the always-on vitals strip?** Spec fixes four (executor / dominant drive / autonomy / cost). Confirm that set, and the deviation thresholds that make each one surface as an exception.
7. **Attractor/pathology detectors as breakpoints — which are real today?** The breakpoint pattern is only honest for *earned* detectors. Need the current list of live vs theater detectors (drive hostility-appraisal gap is a known blind spot per memory) so we don't render a breakpoint on a detector that doesn't fire.
8. **Density/zoom control vs fixed layout.** Offer a global density toggle (compact/comfortable) as the *only* layout flexibility, or fully fixed? Recommend a density toggle, no widget rearrange.
9. **Confidence-ceiling rendering.** Confirm the 0.60 pre-guardian cap should render as a visible ceiling line on confidence bars (recommended, honors Std-5 visibly).

---

## 9. Sources

Trading terminals / density:
- [How Bloomberg Terminal is a great information-dense app (HN teardown)](https://news.ycombinator.com/item?id=19153875)
- [Designing the Terminal for Color Accessibility — Bloomberg](https://www.bloomberg.com/company/stories/designing-the-terminal-for-color-accessibility/)

Observability:
- [Grafana — Variables](https://grafana.com/docs/grafana/latest/visualizations/dashboards/variables/) · [Global variables](https://grafana.com/docs/grafana/latest/visualizations/dashboards/variables/global-variables/) · [Use dashboards](https://grafana.com/docs/grafana/latest/visualizations/dashboards/use-dashboards/)
- [Honeycomb — Core Analysis Loop](https://docs.honeycomb.io/get-started/basics/observability/concepts/core-analysis-loop) · [BubbleUp](https://www.honeycomb.io/platform/bubbleup) · [Query Assistant / NLQ](https://www.honeycomb.io/blog/introducing-query-assistant)

Mission control / flight decks:
- [Beyond LunAR: an AR UI for deep-space missions (arXiv 2011.14535)](https://arxiv.org/pdf/2011.14535)
- [Human Factors in Satellite Operations HCI (arXiv 2110.04880)](https://arxiv.org/pdf/2110.04880)

Debuggers / profilers / time-travel:
- [Time-travel debugging with rr — Undo.io](https://undo.io/resources/gdb-watchpoint/time-travel-debugging-rr-debugger/)
- [Replay — Individual Debugging (inspect any state)](https://www.replay.io/debugging) · [How time travel works](https://docs.replay.io/basics/time-travel/how-does-time-travel-work)
- [Chrome DevTools — Performance features reference](https://developer.chrome.com/docs/devtools/performance/reference) · [Analyze runtime performance (scrubbing/frames)](https://developer.chrome.com/docs/devtools/performance)
- [Perfetto — visualizing external trace formats (flamegraph tracks)](https://perfetto.dev/docs/getting-started/other-formats)

DAWs / IDEs:
- [Digital audio workstation — Wikipedia](https://en.wikipedia.org/wiki/Digital_audio_workstation)
- [Basic DAW operations & interface navigation — Fiveable](https://fiveable.me/music-production-and-recording/unit-1/basic-daw-operations-interface-navigation/study-guide/rXaKlZcs8grfekB5)

Command palette:
- [Superhuman — How to build a remarkable command palette](https://blog.superhuman.com/how-to-build-a-remarkable-command-palette/)
- [VS Code command palette — Steve Kinney](https://stevekinney.com/courses/visual-studio-code/vscode-command-palette)

Density theory (Tufte):
- [Tufte's Principles of Data-Ink — EDAV](https://jtr13.github.io/cc19/tuftes-principles-of-data-ink.html)
- [Edward Tufte — Wikipedia (data-ink, small multiples, sparklines, data density)](https://en.wikipedia.org/wiki/Edward_Tufte)

Internal (requirement + data surfaces):
- `docs/frontend-experience-spec.md` §3A / §4A / §6 / §8 (the guardian cockpit requirement, Impact-of-this-turn, honest-offline rule, reuse inventory).
