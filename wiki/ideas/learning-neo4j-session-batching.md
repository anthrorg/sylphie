# Idea: Batch Neo4j Sessions in Learning Pipeline Entity Loops

**Created:** 2026-04-10
**Status:** proposed

## Summary

Several learning pipeline services open a new Neo4j session for every individual entity or phrase processed in a loop, rather than opening a single session and running all operations within it. Batching these into one session per pipeline step would reduce connection overhead and improve cycle throughput.

## Motivation

In `upsert-entities.service.ts`, the `mergeEntityNode()` helper (line 129) opens a fresh Neo4j WRITE session for each entity label. The calling loop (line 86) iterates over up to `MAX_ENTITIES_PER_EVENT = 20` labels, meaning a single event can trigger 20 separate session open/close cycles. The same pattern appears in `can-produce-edges.service.ts` where individual CAN_PRODUCE edge writes each get their own session.

Neo4j session creation involves TCP-level work (connection checkout from pool, transaction setup). While each session is properly closed in a `finally` block so there's no leak, the per-item overhead adds up during maintenance cycles that process up to 5 events — potentially 100 session round-trips for entity upserts alone in a single cycle.

The `extract-edges.service.ts` already demonstrates the better pattern: it opens one session and runs multiple MERGE queries for RELATED_TO edges within it. Applying this same pattern to upsert-entities and can-produce-edges would bring consistency and measurably reduce cycle latency.

## Subsystems Affected

- Learning (pipeline steps 2, 4 — upsert-entities, can-produce-edges)

## Open Questions

- Should the batched writes use explicit transactions (`session.beginTransaction()`) for atomicity, or remain as individual auto-commit runs within a single session?
- Would UNWIND-based batching (single Cypher query with parameter list) be even more efficient than looping runs within one session?
- Does the current per-entity error isolation (one failure doesn't block the rest) need to be preserved, and if so, how does that interact with transaction-level batching?
