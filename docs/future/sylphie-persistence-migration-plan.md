# Sylphie — Persistence, Migration & Tensor-Contract Plan

**Problem statement.** The tensor has never graduated because Sylphie's accumulated state is wiped between iterations. For graduation to *ever* happen, her learned state must survive code changes. This document specifies how to (a) make her state durable and restorable, (b) evolve the code without corrupting that state, and (c) protect the tensor's learned weights across schema and architecture changes.

**Core principle:** Sylphie's *identity and progress* are not in the code. They are in the data — four Neo4j graphs, the Postgres drive state, the TimescaleDB event history, and the tensor weights. Code is replaceable; that state is the thing we are protecting. Every mechanism below treats the state as the crown jewels and the code as the disposable layer on top.

---

## 1. What actually constitutes "her progress" (the state inventory)

Before you can protect state, you have to enumerate it. Sylphie's durable self is spread across five stores, and they must stay *mutually consistent* — a backup of one without the others is a corrupt snapshot.

| Store | Port | Contains | If lost… |
|---|---|---|---|
| WKG (Neo4j) | 7687 | World facts, action procedures, conversations, insights, provenance | She forgets what she knows and what she's learned to do |
| SKG (Neo4j) | 7690 | Self-model | She forgets who she is |
| OKG (Neo4j) | 7689 | Per-person models | She forgets the people she's met |
| PKG (Neo4j) | 7691 | Codebase graph | Tooling only — rebuildable from source |
| Drive state (Postgres) | 5434 | Current drive values, drive_rules overrides | She loses her current motivational state and learned rule refinements |
| Event history (TimescaleDB) | 5433 | The full SylphieEvent log (the ground-truth record of everything she did) | She loses her episodic/experiential audit trail and replay source |
| Tensor weights | (cognition-service) | GlobalModel, panels, convergence, deliberation, EWC Fisher anchors | She loses everything the tensor learned — graduation resets to zero |

**The consistency requirement is the hard part.** These five stores reference each other. A WKG procedure node has a confidence that was shaped by events in TimescaleDB; the tensor's Fisher anchors correspond to a *specific* distribution of those events. Backing them up at different moments produces a snapshot where the tensor "remembers" training on events the event log no longer contains. Therefore: **snapshots must be coordinated, point-in-time, and versioned together as a single unit.**

---

## 2. The Snapshot — a coordinated, versioned "save state"

Define a **Sylphie Snapshot**: a single restorable artifact capturing all five stores at one logical point in time, tagged with the code version that produced it.

```
snapshot/
  manifest.json            # snapshot id, UTC timestamp, code git SHA,
                           #   schema_version, tensor_arch_version, store checksums
  neo4j/  wkg.dump  skg.dump  okg.dump  pkg.dump
  postgres/  drive_state.sql  drive_rules.sql
  timescale/  events.dump   # or a watermark + incremental since last full
  tensor/  weights/         # per-model checkpoints
           fisher/          # EWC anchors — MUST travel with the weights
           tensor_manifest.json  # arch version, param counts, bootstrap stage per category
```

**Coordination protocol (avoids the inconsistent-snapshot trap):**
1. **Quiesce:** pause the decision cycle (you already have a concurrency guard / epoch fence — reuse it). No new events enter while snapshotting.
2. **Watermark:** record the latest TimescaleDB event id. This is the logical clock for the whole snapshot.
3. **Dump** all five stores. Neo4j dumps per instance; Postgres `pg_dump`; Timescale up to the watermark; tensor checkpoints + Fisher.
4. **Checksum** every file into the manifest.
5. **Resume** the cycle.

The quiesce window is short (it's a dump, not a retrain). This is the difference between a *consistent* save and a `cp -r` that silently tears state across a write.

**Cadence:**
- **Automated rolling snapshots** — e.g. every N hours and before every deploy. Keep a retention ladder (hourly→daily→weekly) so you can roll back to *before* a regression you didn't notice for two days.
- **Named milestone snapshots** — manually tagged ("first Type-1 graduation", "pre-perception-refactor"). These are the ones you never auto-delete.

**Restore is a first-class, tested operation.** A backup you've never restored is a hypothesis, not a backup. Restore must be a single command that rebuilds all five stores from a snapshot and verifies checksums + the post-restore invariants in §5. Test it on every snapshot format change.

---

## 3. Schema migration — evolving the data without breaking it

Code changes that touch data shape (a new node property, a new event field, a renamed drive) are where silent corruption happens. Treat the data stores like a production database: **versioned, forward-only, reversible migrations.**

### 3.1 Stamp a schema version
Add a `schema_version` to the manifest and to a metadata node/row in each store. Code refuses to boot against a snapshot whose `schema_version` it doesn't understand — fail loud, never silently misread old data.

### 3.2 Migration scripts, not implicit drift
Every schema-affecting change ships with a migration: `migrations/0007_add_tess_confirmed_provenance.ts` that transforms vN → vN+1 and is idempotent. On boot/restore, the system applies any pending migrations in order, bumping the stamp. This is standard practice (Prisma/Flyway-style) — you already use Prisma in `packages/shared`, so extend that discipline to Neo4j and the tensor manifest, which usually get neglected.

### 3.3 The Neo4j-specific risk
Neo4j has no enforced schema, which is exactly why it drifts silently. A code change that starts writing `provenance_type` in a new format won't error — it'll just create a graph where half the nodes are one shape and half another, and your `ProvenanceMissingError` won't catch a *malformed* (vs. *missing*) value. **Mitigation:** a migration that rewrites all existing nodes to the new shape, plus a post-migration validation pass (§5) that asserts every node matches the current schema. Do not rely on read-time tolerance; it hides corruption until it compounds.

### 3.4 Forward-only with a tested down-path
Prefer additive, forward-only migrations (add a property, backfill it, then later stop reading the old one — the classic expand/contract). But every milestone snapshot is your real "undo": if a migration goes wrong, you restore the pre-migration snapshot rather than trusting a down-migration to perfectly reverse a lossy change.

---

## 4. The Tensor Contract — protecting learned weights across change

This is the subtlest part, because the tensor is the one store where "the schema" includes the *shape of the model itself*, and a careless code change silently invalidates thousands of training steps.

### 4.1 Separate three version axes
The tensor has three independently-changing things, and conflating them is how progress gets destroyed:

| Axis | Example change | Safe to change weights? |
|---|---|---|
| **Input contract** (the fused `SensoryFrame` schema) | add an audio modality → input dim grows | **No** — old weights expect the old input dim |
| **Architecture** (layer sizes, # panels) | resize a panel; add a deliberation pipeline | **No** — checkpoint shape mismatch |
| **Weights** (learned parameters) | continued training | Yes — this is the point |

The `tensor_manifest.json` records the **input-contract version** and the **architecture version** alongside the weights. The cognition-service refuses to load weights whose contract/arch versions don't match the running code. **Fail loud instead of loading mismatched weights** — a silently mis-loaded checkpoint is worse than no checkpoint, because it produces confident garbage and poisons graduation.

### 4.2 The fusion-layer freeze problem (your specific architecture)
Because *all inputs — including drives — feed through one modality-fusion projection* (`W`, Xavier-init), `W` is the single most schema-sensitive object in the system. Adding or reordering a modality changes `W`'s input dimension and invalidates every downstream weight trained against the old fused representation.

**Contract rule:** the fusion input layout is a **versioned, ordered registry**. Modalities have fixed slot indices. You may *append* a new modality at a new slot (old slots keep their meaning → old weights stay partially valid and you can expand the projection by initializing only the new slice). You may **never** reorder or repurpose an existing slot without a full retrain. This turns "add a modality" from "silently breaks everything" into "additive, mostly-safe expand."

### 4.3 Migration strategies for the tensor (in increasing cost)
- **Continue (cheap):** contract + arch unchanged → just load weights and keep training. Most deploys.
- **Expand (moderate):** additive input/arch change → load old weights into the matching sub-tensor, initialize only the new slice, **re-anchor EWC Fisher** on the new shape, run a shadow-audit period before trusting the expanded model. Never let an expanded model act until it re-passes the agreement gate.
- **Retrain-from-experience (expensive but lossless-in-principle):** breaking change → because the **TimescaleDB event log is the ground truth**, you can *regenerate* training data and retrain the tensor from the real history rather than losing the learning. This is the deep payoff of the event-sourced design: the tensor's knowledge isn't only in the weights, it's *reconstructible* from the event log. The weights are a cache; the events are the source.

That last point is the strategic insight: **as long as the event history is preserved, no tensor change is truly catastrophic** — worst case you replay history to rebuild the policy. Protecting the event log is therefore even more important than protecting the weights.

### 4.4 EWC anchors travel with weights, always
The Fisher matrices are *part of the checkpoint*, not a derived artifact. A snapshot that restores weights without the matching Fisher anchors will let the next training phase catastrophically forget. The `tensor/fisher/` directory in §2 is non-optional, and the tensor_manifest ties a Fisher set to the exact weights and bootstrap stage it was computed against.

---

## 5. Post-restore / post-migration invariants (the safety net)

After any restore or migration, run an automated verification pass *before* the decision cycle is allowed to start. This is the analog of your existing startup checks, extended to state integrity:

1. **Checksums** match the manifest (no silent corruption / partial dump).
2. **Cross-store referential integrity:** every OKG person referenced by recent events exists; every action procedure the tensor has graduated still exists in WKG; no dangling provenance.
3. **Schema conformance:** every Neo4j node matches the current schema_version shape (catches the §3.3 drift).
4. **Drive state sanity:** all drives within `[-10, +1]`; pressure ≤ 12; no NaN.
5. **Tensor contract match:** tensor_manifest input-contract + arch versions equal the running code's; weight tensor shapes load without mismatch; Fisher present for each graduated category.
6. **Floor integrity:** the deterministic executor defaults (`ACTION_TYPE_DEFAULTS`) and the veto logic load and match their expected checksum — the immutable floor must be verifiably the floor (ties directly to the CANON Standard 6 immutability story).

If any invariant fails → refuse to start the cycle, surface the failure, fall back to the last good snapshot. **Never run on state you couldn't verify.** A wrong restore that silently runs is how you'd get a confidently-broken Sylphie, which is worse than a down one.

---

## 6. Why this *enables graduation* (closing the loop with the thesis)

Graduation requires accumulated verified experience over a long horizon. That horizon is exactly what the wipe destroys. With this plan:
- Experience **accumulates across code iterations** instead of resetting — so the tensor finally gets the thousands of verified samples it needs.
- Code can **evolve aggressively** (the whole point of staying in active development) because state is decoupled from code and protected by migrations + snapshots.
- The **event log as source of truth** means even breaking architectural changes don't lose learning — they trigger a replay, not a reset.
- The **floor's integrity is verified on every restore**, so the safety guarantees that make graduated autonomy acceptable survive every iteration too.

In short: this is the infrastructure that turns "she gets wiped and never graduates" into "she persists, keeps learning, and the code can change underneath her without her losing herself." It is the precondition for everything in the autonomous-cognition research note.

---

## 7. Build order (pragmatic)

1. **Snapshot + restore (coordinated, all five stores, tested).** Nothing else matters until a wipe is survivable. This alone unblocks "iterate without losing her."
2. **Schema versioning + the boot-time invariant checks (§5).** Cheap, and they catch corruption immediately instead of weeks later.
3. **The tensor contract + fusion-slot registry (§4.1–4.2).** Do this *before* you add the next modality or resize anything, not after.
4. **Migration framework** (extend Prisma discipline to Neo4j + tensor). Add migrations from here forward; you don't need to retro-migrate a wiped system.
5. **Replay-from-events tooling (§4.3).** The insurance policy. Build it once the loops are generating real history worth replaying.

Items 1–2 are what you need *before release*. 3 is needed before the next architecture change. 4–5 are ongoing discipline.

---

## Appendix — Grant amounts (hard figures, June 2026)

You asked exactly how much money these carry. Verified ranges:

**Survival and Flourishing Fund**
- Individual grants historically range **$10,000 – $4,000,000**.
- **Speculation Grants** are the fast path: each of ~40 "Speculators" holds a budget of **~$400k** to deploy on rolling, ~1-week-decision grants; combined Speculator budget ~$20M. A Speculation Grant of **$10k+ guarantees eligibility** for the big annual S-Process round.
- 2025 round distributed **$34.9M total**; 2026 round estimated **$20–40M**. ~95% of applicants receive a Speculation Grant. For-profits (your LLC) are eligible, administered via SFC.
- *Realistic first ask for a solo independent: a Speculation Grant in the low-to-mid five figures to low six figures, sized to "keep her running + compute for N months."*

**Open Philanthropy / Coefficient Giving — Technical AI Safety RFP**
- Grants **typically $50,000 – $5,000,000**. ~$40M across the RFP, "substantially more depending on application quality."
- Grant types include **research expenses** (compute, frontier-model APIs, cloud) — and these specifically can be **expedited**. Note: "research expenses" does *not* include your salary; for salary you apply as a **discrete project** (0.5–2 yrs, covers salaries + expenses).
- Starts with a **300-word EOI**. They explicitly want a low bar to apply.
- *For scale: a single independent PI recently pulled ~$1.02M across two OpenPhil RFPs. Don't anchor low.*

**Compute / credits (non-dilutive, stackable)**
- **NVIDIA Inception** (free, no equity): up to **$100k AWS credits**, up to **$150k Nebius credits**, **$10k NVIDIA training credits**, preferred GPU pricing. Requires incorporation + active dev + website. You qualify.
- **NVIDIA Academic Grant** (if you angle academic): ~**30,000 H100 GPU-hours**.
- **NSF ACCESS**: GPU allocations off a 1-page abstract ("Explore"), no PI status needed; "Maximize" window open through **July 31, 2026**.
- **NAIRR**: access (GPU hours, data, models), not cash — pair with a cash grant.
- **Microsoft Founders Hub / AWS Activate / GCP**: typically **$10k–$200k** credit ranges depending on program and tier; Founders Hub is the easiest to get (just company details).

**Federal cash (heavier, dilution-free)**
- **NSF SBIR/STTR Phase I:** up to **~$305,000**, no equity — real payroll money, but months and a full technical/commercialization proposal.

**Bottom line on amounts:** the *fast, realistic, runway-saving* money is an SFF Speculation Grant (five-to-six figures, ~1 week) stacked with NVIDIA Inception + ACCESS compute (zeroing your GPU bill). The *bigger* money (OpenPhil discrete project, $50k–$5M; SBIR ~$305k) takes longer but can fund your time, not just the machines. Lead every one of them with the **safety/control framing** — the immutable floor and graduated autonomy — because that is what SFF and OpenPhil exist to fund.
