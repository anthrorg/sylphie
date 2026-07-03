# Codebase Audit — Findings & Remediation Roadmap

**Date:** 2026-06-21  ·  **Commit:** `5aa7821`  ·  **Scope:** whole first-party codebase (11 packages / ~476 src files)

This document consolidates the three whole-codebase audits run over the `codebase-pkg`
graph + source into one forward-looking plan. It is a **findings & remediation** doc —
nothing here has been changed in product code; each item is a candidate for a planned
ticket. The detailed evidence lives in the per-audit reports:

- `docs/audits/dead-code.md` — dead code / stubs / placeholders / theater
- `docs/audits/duplication.md` — duplication clusters + canonical homes
- `docs/audits/coherence.md` — structural quality + CANON alignment

The graph was also annotated (`isStub`, `dupCluster`/`DUPLICATES`, `coherenceFlag`) so
future queries can find these nodes. The audits were produced by a 33-agent workflow;
every finding below had its source file read in full before being flagged, and the P0
was independently re-verified against the SQL init scripts.

---

## TL;DR — what to fix, in order

| # | Severity | Finding | Owner / route |
|---|----------|---------|---------------|
| 1 | **P0 (CANON Std-6)** | `drive_rules` has no DB-level write-protection — runtime user can rewrite its own evaluation rules | `architect` decides, `sentinel` migrates |
| 2 | P1 | `decision-making.service.ts` god-object (~2,671 lines; `processInput` ~1,500) | `architect` / `cortex` |
| 3 | P1 | `metrics.controller.ts` god-object (1,777 lines) + layering inversion | `forge` |
| 4 | P1 | Dead fork-based `IpcChannelService` with stale "bidirectional IPC" docstring on the drive edge | `drive` |
| 5 | P1 | `/cognition` deliberation leg computed-but-discarded at the TS tier | `meridian` |
| 6 | P1 | Orphaned `/cognition/phase-transition` endpoint → EWC consolidation has no live trigger | `architect` |
| 7 | P1 | WebRTC signaling gateway is a reached **no-op** (frontend sends SDP/ICE the backend drops) | `vox` / `forge` |
| 8 | P2 | 11 duplication clusters (5 true / 6 near) — consolidate into `@sylphie/shared` | per-owner |
| 9 | P2 | 4 dead exports + 3 logging surfaces with no enforced `no-console` rule | cleanup |

---

## P0 — Drive-rule write-protection is not provisioned (CANON Std-6)

**Finding.** `infra/postgres/init/001-runtime-user.sql` grants `sylphie_app`
`SELECT, INSERT, UPDATE, DELETE` on **all** public tables via `ALTER DEFAULT
PRIVILEGES` — `drive_rules` included. `002-drive-rules-indexes.sql` only adds indexes.
There is **no `REVOKE` and no Row-Level Security** on `drive_rules` anywhere in the init
scripts (verified by reading both files). Guardian rule-approval writes through the same
runtime pool.

**Why it matters.** This collapses the intended three-layer isolation to a single
application-layer JWT guard. CANON's **no self-modification of evaluation** standard
expects the system to be *unable* to rewrite the rules it is judged by — but at the DB
layer it currently can. This is the sharpest CANON gap found.

**Remediation (sketch — for `architect` to decide, `sentinel` to implement):**
- Add a migration that `REVOKE`s `INSERT/UPDATE/DELETE` on `drive_rules` (and
  `proposed_drive_rules` write paths) from `sylphie_app`.
- Route guardian-approved rule writes through a separate, privileged role / connection
  that the runtime cognition path does not hold.
- Consider RLS as defense-in-depth.
- The repo already has `verify-rls.ts` and `guardian-rules.service.ts` as the TS-side
  touch-points — wire them to the new role boundary.

**Acceptance:** a runnable check proving the runtime user is denied a direct
`UPDATE drive_rules` while the guardian path still succeeds.

---

## P1 — Compounding structural debt

### God-objects
- **`packages/decision-making/src/decision-making.service.ts`** (~2,671 lines), with
  `processInput` alone ~1,500 lines. This is the cognitive loop's center of gravity; the
  hub analysis already flagged its core methods. Decompose along the predict → act →
  evaluate seams. *Route: `architect` for the seam decision, `cortex` to implement.*
- **`metrics.controller.ts`** (1,777 lines) — also a **layering inversion** (a
  presentation/controller surface doing work that belongs a layer down). Appeared in two
  coherence dimensions; merged to one P1. *Route: `forge`.*

### Dead / misleading wiring
- **`IpcChannelService` (fork-based)** is dead, and still carries a "bidirectional IPC"
  docstring on the drive boundary — actively misleading about how drive isolation works.
  Remove or correct. *Route: `drive`.*
- **`/cognition` deliberation leg** is computed at the TS tier and then **discarded** —
  wasted work and a coherence smell. *Route: `meridian`.*
- **`/cognition/phase-transition` endpoint is orphaned** — nothing live calls it, which
  means **EWC consolidation has no runtime trigger**. This is the highest-value P1 to
  confirm: a learning-loop mechanism may be silently inert. *Route: `architect`.*

### WebRTC no-op (also tracked as a stub)
- **`apps/sylphie/src/gateways/webrtc.gateway.ts`** accepts `/ws/webrtc` connections and
  only logs; it has no message handler. `frontend/src/hooks/useWebRTC.ts` actively sends
  SDP/ICE that the backend drops → WebRTC camera-feed signaling is non-functional. Either
  implement signaling or document it as a known stub. *Route: `vox` / `forge`.*

---

## P2 — Cleanup & consistency

### Duplication (11 confirmed clusters — see `duplication.md`)
Consolidate into a single canonical home (mostly `@sylphie/shared`), respecting
drive-process isolation and package layering. Highest impact first:

| Cluster | Kind | Sites | Canonical home |
|---|---|---|---|
| `procedure-bootstrap-helpers` | true | 4 (~100-line bodies) | shared / owning pkg |
| `cosine-similarity` (TS + Py) | near | 4 | shared (TS); Py stays split |
| `bbox-iou` (TS + Py) | true | 4 | language-split, un-bridgeable |
| `as-number-coercion` | true | 6 | `@sylphie/shared` |
| `parse-vector-literal` | true | 4 | `@sylphie/shared` |
| + 6 more (sidecar-breaker, supervisor-types-frontend, ipc-ws-handlers, jaccard, tokenize, cosine-ts) | mixed | 2–5 | see report |

Cross-boundary placements (`@sylphie/shared` wiring, frontend workspace) are flagged for
`architect`/`forge` before moving anything.

### Dead exports (remove or justify)
- `ModalityType` (`@deprecated`, zero consumers), `UnderConstruction.tsx`,
  `MetricsPanel.tsx` (`@deprecated`) — all zero-importer.

### Consistency
- Three logging surfaces with **no enforced `no-console` rule** — pick one logger idiom
  and lint it.

---

## What's already coherent (don't "fix" these)

- **Drive isolation is genuinely one-way** in both directions at the code level — the
  `BRIDGES` edges that looked like a violation were a method-name-collision false
  positive. (The P0 above is a *DB-provisioning* gap, not a code-path leak.)
- **Error handling** is a relative strength; folded into the positives.
- **`shared` is the dominant contract provider** (343 cross-package type usages) — the
  healthy direction for a layered system.
- **Stub-inventory §2.9** (`cobeing/layer3_knowledge` inert) is accurate, not drift — a
  deliberate Phase-3 reference spec, intentionally not wired.

---

## Stub-inventory drift to record

`sylphie-stub-inventory.md` should gain one entry it currently lacks:
- **WebRTC signaling gateway** server-side no-op (`webrtc.gateway.ts`) — the inventory's
  §3 notes the client `/ws/webrtc` stub but not the server-side drop.

---

## Suggested sequencing

1. **P0 first** — it's a CANON gap and the migration is well-scoped (`sentinel`).
2. **Confirm the two "silently inert" P1s** (`/cognition/phase-transition` → EWC trigger;
   discarded deliberation leg) — these may be correctness gaps hiding as cleanup.
3. **God-object decomposition** (`decision-making.service.ts`, `metrics.controller.ts`) —
   schedule deliberately; large surface, needs `architect` seam decisions.
4. **P2 cleanup** — duplication consolidation + dead-export removal can be batched as
   low-risk tickets once the canonical-home calls are made.

Each item that proceeds should become a `todo` node in `planning/contract.yaml` with
acceptance criteria, and run through the normal work-trio + gate. Re-run the audits
(`/audit-dead-code`, `/audit-duplication`, `/audit-coherence`) after a remediation wave
to measure the delta.
