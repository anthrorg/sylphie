# Sylphie Architecture — Reference Index

> ⚠️ **Staleness note (2026-07-02):** these maps are auto-generated snapshots from commit `4f0b473` (2026-06-13) and predate the full-repo bug audit. For current runtime *behavior* (as opposed to structure), read [`../../docs/audits/repo-bug-audit-2026-07-02.md`](../../docs/audits/repo-bug-audit-2026-07-02.md), [`../../sylphie-feature-inventory.md`](../../sylphie-feature-inventory.md), and [`../../sylphie-stub-inventory.md`](../../sylphie-stub-inventory.md). Several subsystems described here as functional are broken or theater at runtime (tensor cognition path, drive-server reconnect, RLS enforcement, contradiction gate). Confirm against source before relying on any map.

> Living index. Last updated: 2026-06-13. Per-subsystem docs are auto-generated from full-file reads (one agent per file). `cv-framework.md` is the hand-verified deep-dive exemplar.

**478 first-party source files** mapped across 12 subsystems. node_modules / .venv / dist / archive excluded.

## Deep dives (hand-verified)
- [Computer Vision Framework](cv-framework.md) — capture → sidecar models → tracking → face recognition → encoders → fusion; live + dormant paths.

## Subsystem maps (auto-generated)

| Subsystem | Files | Doc |
|---|---:|---|
| decision-making | 63 | [decision-making.md](decision-making.md) |
| app-drive-server | 2 | [app-drive-server.md](app-drive-server.md) |
| app-sylphie | 44 | [app-sylphie.md](app-sylphie.md) |
| cognition-service | 19 | [cognition-service.md](cognition-service.md) |
| drive-engine | 69 | [drive-engine.md](drive-engine.md) |
| frontend | 72 | [frontend.md](frontend.md) |
| learning | 21 | [learning.md](learning.md) |
| perception-service | 112 | [perception-service.md](perception-service.md) |
| planning | 16 | [planning.md](planning.md) |
| shared | 32 | [shared.md](shared.md) |
| supervisor | 8 | [supervisor.md](supervisor.md) |
| sylphie-pkg | 20 | [sylphie-pkg.md](sylphie-pkg.md) |

## How these were built
- 2026-06-13: a background workflow fanned out one Haiku agent per file; each read its file in full and wrote a JSON summary fragment to `_data/<subsystem>/`. A deterministic script (`wiki/_assemble.py`) renders the fragments into these docs. Faithful to source but spot-check before trusting any single line.
