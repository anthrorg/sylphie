# Feature: Theory loop — curiosity-driven acquisition + Tess confirmation

**Priority:** P1  ·  **Engineering level:** prototype
**Area / component:** decision-making / WKG / drive coupling / Tess integration

## Why (required)
Drives accumulate pressure independent of any user, so Sylphie is architecturally capable
of self-directed learning during idle time — she just isn't pointed at a rich action
space. Naive web reading would hoard unverified assertions and trip the
Hallucinated-Knowledge detector. The unit of work must be a **theory** (a falsifiable
claim) that can be confirmed or refuted — and shallow multi-source web echo is not a
truth check. Tess (10-stage pipeline, Beta-statistics promotion gates) is a *reasoned*
verdict, so confidence earned via Tess is worth more than confidence earned via agreement
counts.

## What it should do (required)
**Acquisition (awake, curiosity-driven):**
- When Curiosity pressure crosses threshold and no interaction is active, the executor
  selects a `research` action targeting a WKG node that is low-confidence or stale under
  ACT-R decay (read at the frontier of uncertainty, not what's already known).
- Reading produces a **theory object** written to the WKG at low confidence with
  provenance `LLM_GENERATED`. Schema (open question #2 in the source doc — resolve in
  planning): id, claim, source nodes, provenance, confidence, status
  (open/confirmed/refuted), verdict ref, spawned-from.
- Forming a theory does **not** fully relieve Curiosity; only resolution does — so the
  system closes loops instead of opening infinite new ones.

**Confirmation (Tess as epistemic authority):**
- New provenance tier `Tess_Confirmed`: the only path to high confidence for
  non-experiential knowledge. `LLM_GENERATED` stays low and decays fast (0.08/hr);
  Tess-confirmed is promoted and decays slowly.
- **Asynchronous contract** (open question #3 — resolve in planning): Sylphie proposes
  theories continuously; Tess verdicts land on their own schedule and trigger
  promotion/demotion. Define the request payload, verdict payload, and the
  verdict→confidence-delta promotion function.
- **Refutation is the high-value event:** discharge Curiosity, demote/remove the node,
  and spawn a new theory about *why* the original was wrong.
- The Hallucinated-Knowledge detector gets precise: alarm on the ratio of
  confidently-held facts that have never received a Tess verdict.

## Scope hints
`packages/decision-making/**` (executor `research` action, drive coupling — owner
`cortex`, conceptual reviewer `luria`); WKG node shapes + provenance
(`packages/decision-making/src/wkg/**` — `atlas`, reviewer `scout`); drive contingencies
(`packages/drive-engine/**` — `drive`, reviewer `skinner`); Tess CLI integration point
(new — `architect` to place it).

## Dependencies (required)
Depends on **feature-snapshot-restore** + **feature-schema-versioning** (theory nodes and
the new provenance tier need versioned schema + durable state — pointless if wiped).
Sequence AFTER **bug-audit-wkg-knowledge-graph** (theory writes ride the same plumbing it
fixes: `writeEntity` phantom node_ids, the confidence-ceiling escape, zero-row no-op
writes logging success) and **bug-audit-learning-planning-supervisor** (provenance
falsification — the provenance ladder is meaningless while speaker facts get stamped
GUARDIAN). Blocks: feature-consolidation-loop (consumes verdicts). The `Tess_Confirmed`
provenance migration is exactly the kind of change the migration framework exists for.

## Database impact (required)
**Touches a database / schema / migration?** yes
WKG (Neo4j): new theory node shape + new provenance enum value (migration:
`add_tess_confirmed_provenance`). Postgres drive state: Curiosity contingency updates via
the guardian-approved path only (never direct `drive_rules` writes — CANON Std-6).

## Acceptance — how we'll know it works (required)
1. Given idle + Curiosity over threshold, when the executor cycles, then a `research`
   action targets a low-confidence/stale WKG node and produces a well-formed theory node
   (provenance `LLM_GENERATED`, low confidence) — verifiable by Cypher query.
2. Given an open theory, when a Tess `confirmed` verdict lands, then the node is promoted
   to `Tess_Confirmed` with slow decay; when `refuted`, then confidence demotes, Curiosity
   discharges, and a spawned-from-linked "why was I wrong" theory appears.
3. Given theories forming without resolution, then Curiosity is NOT fully relieved by
   proposal alone (drive trace shows relief only at verdict).
4. Given a set of confident-but-never-verdicted facts exceeding the detector ratio, then
   the Hallucinated-Knowledge detector fires.
5. Theater check: no claim is written as high-confidence without either experiential
   provenance or a Tess verdict (provenance-required + confidence ceiling respected).

## Non-goals / scope guard (required)
No consolidation/insight synthesis (separate feature). No executor tensor involvement.
No unbounded web crawling — the research action is one targeted read per curiosity
discharge, rate-limited. Tess itself is external; this feature builds the contract and
the Sylphie side only.

## Source / references
`docs/future/sylphie-autonomous-cognition-research.md` §1, §2, §5 (theory schema), §7
open questions 2–3.
