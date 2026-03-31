# 2026-03-29 — Rule Engine Implementation (E4-T006)

## Changes

- NEW: `src/drive-engine/constants/rules.ts` — Rule engine configuration constants and default affects
- NEW: `src/drive-engine/drive-process/rule-matching.ts` — Pattern matching engine for trigger evaluation
- NEW: `src/drive-engine/drive-process/rule-application.ts` — Effect DSL parsing and application
- NEW: `src/drive-engine/drive-process/default-affect.ts` — Fallback affect contingencies
- NEW: `src/drive-engine/drive-process/rule-cache.ts` — LRU cache for matching results
- NEW: `src/drive-engine/drive-process/rule-engine.ts` — Main orchestrator (load, match, apply, cache)
- MODIFIED: `src/drive-engine/drive-process/drive-engine.ts` — Integration point for rule engine (pending manual merge)

## Wiring Changes

- Rule engine initializes in Drive Engine child process constructor
- Rules loaded from PostgreSQL `drive_rules` table on startup
- Periodic reload every 60s to pick up guardian-approved rules
- On each outcome event, rule engine matches and applies effects before guardian weighting
- Default affects provide fallback when no rules match

## Known Issues

- Manual integration needed in `drive-engine.ts` due to file conflicts (see RULE_ENGINE_IMPLEMENTATION_SUMMARY.md)
- Integration provides complete patch instructions for all six required changes

## Gotchas for Next Session

- The rule engine initializes with `async initialize(pool)` — ensure caller awaits this before calling `start()`
- Periodic rule reload runs in background; invalid rules are skipped silently (logged to stderr)
- Cache is cleared on every rule reload — expected behavior to ensure fresh rule matches
- Rule confidence threshold (0.3) filters out low-confidence experimental rules automatically

