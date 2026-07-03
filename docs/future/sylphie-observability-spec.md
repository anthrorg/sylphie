# Sylphie — Observability Spec & Snapshot Metrics Schema

**Purpose.** One analytics page that reveals the whole system growing, in language a tired operator (and later a funder) can read in 30 seconds. It answers four questions: *Is she graduating off the LLM? Is her knowledge growing and staying trustworthy? Is she healthy or drifting? Is she accumulating experience?*

**Two data sources, by design:**
- **Live** — current state, queried from the running stores (drives, detector values, queue depth). Answers "what is she doing right now."
- **Historical** — derived from the **snapshot sequence**. Every backup is a timestamped state-of-the-self; the diff between snapshots *is* the growth curve. Answers "is she getting better over time." This is the half that proves the thesis, and it only exists if the schema below is captured from the first snapshot onward.

**Core principle:** observability is not a parallel system. It is mostly a *read* over the backup history you're already creating. Build the metrics block into the snapshot manifest (§1); the page (§2) is a view over it.

**Audience order:** operator view first (every signal, dense). A funder/public "proof" view is the same data with fewer panels and plain captions — noted per panel as `[also public]`.

---

## Part 1 — The Snapshot Metrics Schema

Every Sylphie Snapshot (from the persistence plan) carries a `metrics` block alongside the state dumps. This is the unit of the time series. **If it isn't captured here at snapshot time, it can never become a trend.** Compute it during the quiesce window (you already have the cycle paused).

```jsonc
{
  "snapshot_id": "...",
  "timestamp_utc": "2026-06-20T14:00:00Z",
  "code_git_sha": "...",
  "schema_version": 7,
  "tensor_arch_version": 3,
  "uptime_since_last_wipe_hours": 612.5,   // THE survival metric — see note

  "metrics": {

    // ── Q1: GRADUATION (the thesis) ────────────────────────────
    "graduation": {
      "type1_ratio": 0.18,                 // decisions made with NO llm call / total
      "type1_count": 0, "type2_count": 0, "shrug_count": 0,
      "llm_calls_total": 0,                // for cost + dependence trend
      "by_category": [                     // per action-category, the real story
        { "category": "graph_exploration", "stage": "partial",
          "agreement_with_llm": 0.88, "rolling_mae": 0.07,
          "max_confidence_seen": 0.79, "decisions": 1240 },
        { "category": "knowledge_query", "stage": "audit",
          "agreement_with_llm": 0.71, "rolling_mae": 0.14,
          "max_confidence_seen": 0.0, "decisions": 880 }
        // ... one row per category
      ],
      "tensor_global_mode": "shadow"       // shadow|audit|partial|full
    },

    // ── Q2: KNOWLEDGE GROWTH + TRUST ───────────────────────────
    "knowledge": {
      "wkg_nodes_total": 0,
      "wkg_nodes_by_provenance": {         // the provenance ladder, over time
        "sensor": 0, "guardian": 0, "inference": 0,
        "llm_generated": 0, "tess_confirmed": 0
      },
      "mean_confidence": 0.0,
      "confidence_weighted_knowledge": 0.0, // sum(confidence) — "real" knowledge mass
      "hallucination_ratio": 0.0,          // confident-but-unverified / total (DETECTOR G3)
      "skg_nodes": 0,                      // self-model size
      "okg_people": 0,                     // people she knows
      "okg_nodes_total": 0,
      "action_procedures": 0,              // learned "how to do X"
      "insights": 0,                       // synthesized higher-order nodes (consolidation output)
      "theories_open": 0,                  // proposed, awaiting Tess
      "theories_confirmed": 0,
      "theories_refuted": 0
    },

    // ── Q3: HEALTH / DRIFT ─────────────────────────────────────
    "health": {
      "detectors": {                       // value AND threshold, so trend-vs-line is plottable
        "type2_addict":        { "value": 0.0, "threshold": 0.90 },
        "hallucinated_knowledge": { "value": 0.0, "threshold": 0.20 },
        "depressive_attractor":{ "value": 0.0, "threshold": 0.60 },
        "planning_runaway":    { "value": 0.0, "threshold": 0.70 },
        "prediction_pessimist":{ "value": 0.0, "threshold": 0.30 }
      },
      "drives": {                          // all 12, current values [-10,+1]
        "guilt": 0.0, "curiosity": 0.0, "boredom": 0.0, "satisfaction": 0.0,
        "systemHealth": 0.0, "moralValence": 0.0, "integrity": 0.0,
        "cognitiveAwareness": 0.0 /* ...rest */
      },
      "total_pressure": 0.0,               // [0,12]
      "guilt_events": 0,                   // executor/tensor divergences felt this period
      "guilt_resolved_vindicated": 0,      // transgressions that paid off (→ rule loosening)
      "guilt_resolved_punished": 0,        // (→ rule strengthening)
      "floor_vetoes": 0                    // times the deterministic floor reasserted
    },

    // ── Q4: EXPERIENCE ACCUMULATION (the fuel) ─────────────────
    "experience": {
      "events_total": 0,                   // cumulative TimescaleDB event count
      "events_this_period": 0,             // delta since last snapshot — the throughput line
      "episodes_encoded": 0,               // passed the encoding gate
      "episodes_seen": 0,                  // for encode-rate = encoded/seen
      "verified_training_samples": 0,      // labeled samples available to the tensor — THE fuel for Q1
      "unique_users": 0,                   // distinct people interacted with
      "interaction_sessions": 0,
      "replay_buffer_fill": 0.0            // 0–1, how full the 100k ring is
    },

    // ── INTEGRITY (ties to backup verification) ────────────────
    "integrity": {
      "floor_checksum_ok": true,           // the immutable executor verified intact
      "cross_store_refs_ok": true,
      "schema_conformant": true
    }
  }
}
```

**Notes that matter:**

- **`uptime_since_last_wipe_hours` is the most important number on the whole page.** Everything else is conditional on it. The thesis can't progress across wipes; this number going up and *staying* up is the precondition for every other trend. Make it the first thing the page shows. It's also, bluntly, your proof-to-funders that the persistence work succeeded.
- **Detectors store value AND threshold** so the page can plot the line and the limit together. A raw value is meaningless without its bar.
- **Deltas where it counts** (`events_this_period`) so the page can show throughput without diffing snapshots client-side for the common case — though most trends *are* computed by diffing the snapshot series.
- **Everything here is cheap to compute** — counts and current values, gathered during the existing quiesce pause. No new heavy instrumentation; mostly aggregate queries over stores you already have.

---

## Part 2 — The Page Spec

Layout philosophy: **the answer is the headline, the chart is the evidence.** Each panel leads with a single plain-language verdict and a trend; detail is secondary. Top-to-bottom = most-important-first, so the operator gets the story by scrolling and the funder gets it from the first screen.

### Row 0 — The Vital Sign (full width, can't-miss)  `[also public]`
- **`Alive for: 25d 12h`** — `uptime_since_last_wipe_hours`, huge. Green if climbing, red the moment it resets (a wipe happened — the one event that must scream).
- Three small companion stats: total events, unique users, last snapshot age.
- *Why first:* it's the precondition for everything. If this resets, nothing below matters.

### Row 1 — Is She Graduating? (the hero)  `[also public]`
- **Headline:** "Running **18%** of decisions without the LLM" + arrow vs. last period.
- **Hero chart:** Type-1 ratio over time (the snapshot series). The one line that proves the thesis. Annotate milestone snapshots ("first partial graduation") as markers on the line.
- **Category table:** per-category stage (shadow→audit→partial→full as a little progress pill), agreement %, rolling MAE vs. the 0.10/0.15 lines, decision count. This is where the operator sees *which* parts of her mind are maturing.
- **Secondary:** LLM-calls-per-decision trending down = the same story from the cost side (also a nice funder number: "X% cheaper per decision than 30 days ago").

### Row 2 — Is Her Knowledge Growing *and* Trustworthy? (two lines, read together)  `[also public]`
- **Headline:** "Knows **4,210** verified things, hallucination risk **3%** and falling."
- **Chart A:** confidence-weighted knowledge mass over time (climbing = learning).
- **Chart B (overlaid or beside):** hallucination_ratio vs. its 0.20 threshold (flat-low = trustworthy). *These must sit together* — growth is only good if trust holds.
- **Provenance ladder, stacked-area over time:** llm_generated → inference → tess_confirmed. Watching the confirmed tier grow is watching her *earn* her knowledge. (Once Tess is wired, this becomes the most compelling single visual in the system.)
- **Small stats:** people known (OKG), action procedures learned, insights synthesized, theory confirm/refute counts.

### Row 3 — Is She Healthy? (operator-critical; `[public: simplified to one "health: OK" badge]`)
- **Headline:** "All systems nominal" or the specific alarm.
- **Five detector sparklines**, each value tracked against its threshold line. Red when approaching. The *trend toward* a threshold is the signal, not the current value.
- **Drive state:** the 12 drives as a small over-time view (radar for "now," or sparklines for trend). Total pressure line. Healthy = oscillating; stuck = investigate.
- **Guilt panel (your differentiator):** guilt events, vindicated vs. punished resolution counts, floor vetoes. This is where "she's developing a conscience and learning from transgression" becomes *visible* — vindicated guilt loosening rules, punished guilt strengthening them. A funder who groks this panel groks the whole safety story.

### Row 4 — Is She Accumulating Experience? (the "is it working or just slow" answer)
- **Headline:** "Gained **8,400** experiences this week, **1,200** verified."
- **Chart:** events-per-period throughput + verified-training-samples (the tensor's fuel) over time. If Row 1 is flat, *this* row tells you whether it's because she's starved (low fuel → keep waiting) or stalled (fuel but no graduation → investigate).
- **Replay buffer fill, encode rate, sessions.** Operator-only detail.

### Cross-cutting interactions
- **Time range selector** (24h / 7d / 30d / all) — drives every trend; default 7d.
- **Milestone markers** — named snapshots annotate every time-axis (deploys, first graduation, schema migrations). Lets you *see* whether a code change helped or hurt — directly answers the migration-plan worry "did this change ruin progress?"
- **Live vs. historical toggle is implicit per panel:** current values are live; all trends are the snapshot series. Show last-snapshot-age so the operator knows how stale the trend tail is.
- **One alarm strip** at the very top under Row 0: any detector over threshold, any failed integrity check, or a floor-checksum failure surfaces here in red regardless of scroll position.

### The funder/public view (later, same data)
Strip to Row 0 + Row 1 hero chart + Row 2 provenance ladder + a single green health badge. Four visuals, plain captions, no jargon. That's the "proof the thesis works" page — and because it's built from the same snapshot series, it's *not* a marketing mockup, it's the real instrument with the operator detail hidden. That authenticity is itself the pitch.

---

## Part 3 — Build notes

- **Schema first, before the next snapshot.** The metrics block must ship with the backup system, or you start the time series late and lose the most precious data — the *early* growth, when the curves are steepest and the "from zero" story lives.
- **Most metrics are aggregate queries** over existing stores, run in the quiesce window. Budget the added quiesce time; keep each query cheap (counts, not scans where avoidable).
- **The page reads snapshots, not live stores, for everything historical** — which means the analytics load never touches the running cognitive cycle. Observability can't perturb the thing it observes. (Live panel reads are the only exception and should be read-only, cached briefly.)
- **Graduation-event capture (from the launch-sequence discussion) falls out for free here:** when a category first crosses to `partial`, that's a detectable transition between two snapshots' `by_category` arrays. Fire a milestone snapshot + alert on it automatically. You will not miss the moment, and you'll have the before/after the funders want.
- Build order: metrics block in snapshot → Row 0 + Row 1 (the thesis) → Row 3 alarms (so you're safe during public exposure) → Rows 2 & 4 → public view.

---

## Why this is the right shape

You already observe a lot live. The gap was never *more* signals — it was a **time axis** and a **plain-language verdict** on top of the signals. This spec adds exactly those two things by reusing the backup history as the time series, so the same work that keeps her alive across iterations also produces the growth story. Durability and observability become the same system, and the page that proves the thesis to funders is the same page you use to know she's okay.
