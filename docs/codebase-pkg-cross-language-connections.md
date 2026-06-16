# codebase-pkg — Cross-Language / Cross-Tier Connection Capture

**Audience:** the agent maintaining `@sylphie-labs/codebase-pkg` (the external seeder + MCP server).
**Date:** 2026-06-15. **Author:** Sylphie coordinator session.
**Status:** skill-side heuristics shipped (see below); upstream seeder changes recommended.

---

## Why this exists

The seeded `CALLS` graph is built by **single-language AST resolution**. Three whole classes of
real connection are therefore missing from the graph, which (a) hides the actual system topology
and (b) inflated dead-code false positives to ~40% of all functions:

1. **Cross-tier HTTP** — TS (NestJS/`sylphie`) → Python sidecars (`perception-service`,
   `cognition-service`), and `frontend` → NestJS controllers. These are runtime calls over a URL
   string, so no AST edge exists.
2. **WebSocket message contracts** — emitter and handler are coupled by an *event-name string*,
   not a call.
3. **DI / dynamic dispatch** — `this.injectedSvc.method()` is never resolved into `CALLS`.

Symptom we hit: a bogus `perception-service → frontend` "bridge" (31 `USES_TYPE`) that was really a
cross-language **name collision** (`Detection` / `TrackedObject` / `Frame` defined in both Python
and `frontend/.../usePerception.ts`) standing in for coupling nobody captured.

## The seam (what made a skill-side fix possible)

The seeder already stores enough to reconstruct these post-hoc:

- `Function.routePath` + `Function.httpMethod` on **both** NestJS controllers (66 routes) **and**
  Python FastAPI routes (20 routes).
- `Function.decorators` as JSON — WS handlers expose the event name
  (`@SubscribeMessage` → `args:["message"]`).
- `Type -[:INJECTS]-> Type` — consumer class → injected service (194 edges).
- `CodeBlock.bodyText` — **full source text** of every function (this is the key; call-sites with
  URL/event-name string literals are searchable).

## What was shipped skill-side (no seeder change required)

Added to `.claude/skills/infer-pkg-connections/SKILL.md` as new analyses. These synthesize
**heuristic, reversible** edge types — deliberately distinct from the seeder's precise `CALLS`:

| Analysis | New edge | Result on current graph |
|---|---|---|
| `cross-language` (§7) | `CALLS_ENDPOINT` (TS/FE → route `Function`, `{protocol,method,routePath}`) | **69 edges** — full TS→Python sidecar + frontend→API graph |
| `di-calls` (§9) | `RESOLVED_CALL` (caller → injected-service method, `{via:'di'}`) | **479 edges** across 172 callees |
| `ws-events` (§8) | `EMITS_EVENT` (emitter → `@SubscribeMessage` handler, `{event}`) | **0 edges** — blocked upstream (see below) |
| `dead-code` (§5, updated) | honors `CALLS` + `RESOLVED_CALL` + `CALLS_ENDPOINT`; adds `deadConfidence` tier | **964 → 808** flags (156 rescued); 105 medium / 703 low |

Guardrails encoded in §7/§9: static-prefix match for route params, HTTP-verb token proximity,
`*.types.ts` exclusion, `>3`-char method-name guard for DI. Reset:
`MATCH ()-[r:CALLS_ENDPOINT|RESOLVED_CALL|EMITS_EVENT]->() DELETE r`.

These are good enough for reachability/topology, but they are **string-matching heuristics**. The
right home for the high-value ones is the seeder, as first-class resolved edges.

---

## Recommended upstream (seeder) changes — priority order

### P1. First-class DI call resolution
`INJECTS` already binds `consumerType → serviceType`. At seed time, when resolving a method body,
bind constructor params (`private readonly foo: FooService`) to their types, then resolve
`this.foo.bar()` → real `CALLS` to `FooService.bar`. This is the single biggest correctness win —
it removes ~156+ dead-code false positives and makes the precise call graph actually traverse
service boundaries. (Skill-side `RESOLVED_CALL` over-approximates by method-name; the seeder can do
it precisely via the param→type binding.)

### P2. Capture WebSocket event-name literals (unblocks `ws-events`)
The `ws-events` analysis returns 0 today because **`.emit(` appears in zero captured `bodyText`s** —
broadcasts go through typed wrappers / `socket.send`, and event-name constants aren't inlined.
Capture, as structured properties or nodes/edges:
- `@SubscribeMessage('x')` handler ↔ event name (already in `decorators` — expose as a first-class
  field, e.g. `Function.wsEvent`).
- emit sites: `server.emit('x')`, `client.emit('x')`, `socket.emit('x')`, and frontend
  `socket.on('x')` / `addEventListener('x')`. Emit an `Event` node or `EMITS`/`HANDLES` edges.
This is what makes the WS contract graph (both inbound and the larger **broadcast** direction)
reconstructable.

### P3. First-class cross-tier HTTP edges
Generalize what the skill does: extract the URL string literal from HTTP-client calls
(`httpService.post(url,…)`, `fetch(url)`, `axios`) as a structured property on the call, then join
to the `routePath` of the matching route `Function` and emit a real `CALLS_ENDPOINT`/`INVOKES_HTTP`
edge at seed time. Handle base-URL-from-config by matching on **path suffix** (clients prepend a
configured base like `COGNITION_URL`).

### P4. Richer route metadata
Store both the raw route (`/graph/:instance/count`) and a normalized match key (static prefix +
param arity), so endpoint↔caller joins don't depend on ad-hoc `split(':')` normalization.

### P5. Cross-language schema mirroring (replaces the false `USES_TYPE` bridge)
TS `interface`/DTO ↔ Python pydantic model with the same name + field shape should be a dedicated
`MIRRORS` / `SCHEMA_OF` edge, **not** a `USES_TYPE`. Today a same-named type in two languages
collides into a spurious cross-package `USES_TYPE` (the `perception-service → frontend` artifact).
Two fixes: (a) namespace `Type` nodes by language/package so names don't collide, and (b) add the
explicit mirror edge for genuine shared contracts (`Detection`, `TrackedObject`, `Frame`,
`SensoryFrame`, etc.).

### P6 (minor). Keep `CodeBlock.bodyText`
It's what enabled all the skill-side heuristics — please keep it populated and untruncated.

---

## Verified metrics (live graph, commit-era 2026-06-15)

- Functions: 2377 · `CALLS`: 1546 · `USES_TYPE`: 1559 · `INJECTS`: 194 · `IMPLEMENTS`: 56 · `EXTENDS`: 84
- Routes with `routePath`: 86 (66 TS controllers, 20 Python FastAPI)
- New synthetic edges: `CALLS_ENDPOINT` 69 · `RESOLVED_CALL` 479 · `EMITS_EVENT` 0
- Dead-code flags: 964 → **808** after richer reachability (156 rescued)

## How to see the cross-tier graph now

```cypher
// TS/Frontend -> service endpoints
MATCH (caller)-[r:CALLS_ENDPOINT]->(ep)
RETURN caller.name, r.method, r.routePath, ep.filePath ORDER BY r.routePath;

// DI-resolved reachability
MATCH ()-[r:RESOLVED_CALL]->(callee) RETURN callee.name, count(*) ORDER BY count(*) DESC;
```
