# The Provability Gate

`yarn gate` makes "is it working?" a question with a hard, automated, visible answer.
It drives the **live** system and intercepts only the outbound LLM HTTP call (Ollama)
via a cassette — every internal NestJS service runs for real.

## Prerequisites

1. `docker compose up -d` (databases + sidecars)
2. `yarn dev:drive-server` (drive engine on :3001)
3. Point the backend's Ollama at the cassette, then start it:
   `OLLAMA_HOST=http://localhost:11500 yarn dev:backend`
   (the cassette listens on `GATE_CASSETTE_PORT`, default 11500)
4. For `gate:record` only: real Ollama must be running on :11434 (or set `GATE_OLLAMA_UPSTREAM`).

## Commands

- `yarn gate` — replay mode. Requires `cassette.json` to exist (else hard-fails with record instructions).
- `yarn gate:record` — proxy LLM calls live and record them into `cassette.json`.
- `yarn gate:lesion` — run the corpus, then disconnect the LLM cassette and assert the 8 Lesion criteria (L1–L8).
- `yarn gate:update-baseline` — replay, then write fresh metrics into `baseline.json`.

## Output

A scorecard of PASS / FAIL / SKIP rows (C* = corpus, M* = metrics, L* = lesion, X0 = cassette integrity).
Exit 0 on all-pass, 1 on any FAIL. SKIP is non-blocking (insufficient data, honestly reported).

## Notes

- Cassette **miss = hard fail** in replay/lesion/update-baseline — never a silent passthrough to live Ollama.
- The seed `baseline.json` is permissive; capture a real one with `gate:update-baseline` after the first healthy run.
- TODO: no `POST /api/metrics/reset` endpoint yet, so the type-ratio asserts on lifetime in-process counters (see gate.ts).
