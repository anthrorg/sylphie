# WS4 — Presence (one mind, many people): Authoritative Build Plan

**Author:** mythos (Opus reasoner) · **Date:** 2026-06-10 · **Verified against live source at HEAD (a68a826), not just the design doc.**

**Bottom line:** The design (`sylphie-chat-architecture.md`) is structurally accurate and its Part F decisions are sound — but **two Part F claims are factually wrong about the current code and must be reopened**, and the **concurrency guard recommendation is correct: it is WS4 ticket #1**. The build is 8 tickets. The single biggest risk is not the queue — it's that **the gate as written cannot prove any of WS4** (it opens one fresh socket per turn, so it never has two interlocutors contending), and that **per-person privacy (F.4) is actively violated in code today**. Both must be fixed inside WS4 or the done-state line is a vibe, not an assertion.

---

## 1. Fork audit (Part F)

| Fork | Doc decision | Verdict | Finding |
|---|---|---|---|
| **F.1 Ordering** — FIFO + guardian-priority lane, priority preempts *next selection* not in-flight turn | Decided | **CONFIRMED, build as written.** The "never yank a turn mid-cycle" constraint is exactly right and maps cleanly onto `tickInFlight` (decision-making.service.ts:203) + the pre-cycle guard (`:438`, throws if executor ≠ IDLE). | Sound. |
| **F.2 Observer visibility** — own-thread default, explicit observer role | Decided | **CONFIRMED.** Today `delivery$` is one shared `Subject` (communication.service.ts:73) and the gateway `broadcast`s to all (conversation.gateway.ts:77, 232). Targeted-delivery + observer-channel is a **gateway-only** change; nothing in Communication needs per-user fan-out. | Sound; cleanly localized. |
| **F.3 Drive state** — single shared affect, mood-bleed is a feature | Decided | **CONFIRMED.** Falls out of one drive process + one `:CoBeing`. Build nothing; the only action is the attractor-monitor alert (folded into Ticket 8). | Sound. |
| **F.4 Cross-talk in memory** — three-graph boundary is the privacy contract; "target=speaker → OKG, world-facts → WKG" | Decided, **claimed to "already fall out of existing routing"** | **REOPENED — the claim is false in code.** | **See below.** |

### F.4 is reopened — the doc's load-bearing assumption is contradicted by the source

The doc (Part F.4) says speaker-personal facts go to OKG and *world*-facts go to WKG via existing routing, and that the boundary "already falls out of the three-graph design." **It does not.** Verified in `person-model.service.ts:461` and `communication.service.ts:583`:

1. **There is no `target: 'world'`.** `extractFactsFromText` only emits `'speaker'` or `'sylphie'` (person-model.service.ts:51). The "world-fact" routing the doc relies on does not exist in the fast-fact path.
2. **`target: 'speaker'` writes to BOTH OKG *and* WKG** (communication.service.ts:590–601). So "I'm afraid of dogs" said by Person A becomes a WKG `Entity` keyed to A's userId — and the WKG is shared. The privacy contract F.4 declares is *violated by construction* the moment Person B exists.
3. **Every WKG fast-fact write hardcodes `provenance_type = 'GUARDIAN'` and `confidence = 0.90`** (communication.service.ts:639, 647, 653) regardless of speaker. When Person B (non-guardian) teaches a fact, it enters the WKG stamped GUARDIAN at 0.90 — **a direct Guardian-Asymmetry (Standard 5) and confidence-ceiling (Standard 3, ≤0.60 pre-confirmation) violation that is currently masked only because there is exactly one user, who is the guardian.**

**Recommendation:** F.4's *intent* (three-graph boundary as the privacy contract) stays. But it is not "already true" — it is **Ticket 5**, and it is **not optional**: the multi-person feature is the thing that turns this latent bug into a live CANON breach. This is the single most important correction to the design doc.

---

## 2. Ticket breakdown (build order)

Build order is dependency-driven: the concurrency guard and identity-threading are the substrate; privacy and gate come last because they *verify* the substrate.

### Ticket 1 — Decision-cycle concurrency guard *(do first)* → **ashby designs, opus-agent builds**
**Why first:** the unified queue means N interlocutors contend for one serial mind. The queue *is* a concurrency-control structure sitting directly on cycle semantics. Designing the queue before the guard is backwards — you'd be building queue semantics on an unprotected critical section. The `decision-cycle-concurrency-guard` ticket (`wiki/ideas/decision-cycle-concurrency-guard.md`) is the right #1.

- **Scope:** Replace the implicit `tickInFlight` boolean (decision-making.service.ts:203, 376–406) with an explicit serial executor + bounded FIFO queue and a **watchdog timeout**. Today's protection is two layers: `tickInFlight` (skips overlap) and the executor pre-cycle guard that *throws* if state ≠ IDLE (`:438`). Under the queue, an overlapping arrival must **enqueue**, not throw or silently drop (today `updateText` would clobber — see Ticket 2).
- **Files/services:** `packages/decision-making/src/decision-making.service.ts` (tick loop, `processInput`), `executor-engine.service.ts` (FSM reset path), `DecisionEventLoggerService` (event-buffer flush is per-cycle and must not interleave).
- **Concurrency design direction — see §3.** Mutex + bounded queue + watchdog, NOT preemption.
- **Acceptance (gate-style, provable):** new Lesion-adjacent assertion **L8/concurrency-burst**: fire K=5 turns within <50ms of each other; assert (a) exactly K responses returned, (b) zero `executor not in IDLE` throws in logs, (c) responses are well-formed (no interleaved text), (d) a deliberately-wedged cycle (inject a hang) is killed by the watchdog within T_max and the queue drains the rest. Must hold **under lesion** too — see §3 interaction.
- **Builder:** **ashby** owns the stability/back-pressure/watchdog design. **opus-agent** implements once ashby fixes the parameters. Do not let opus-agent invent the timeout/queue-depth policy.

### Ticket 2 — `InboundTurn` queue at the Communication boundary → **opus-agent**
- **Scope:** Replace the single-slot clobber. Today `tickSampler.updateText(text)` does `latestValues.set('text', value)` (tick-sampler.ts:130, 154) — second writer wins, first message vanishes. Introduce `InboundTurn { turnId, userId, username, socketId, text, receivedAt }` (doc Part C.1), enqueue at `handleMessage`, and a drainer that feeds the cycle one turn at a time gated on Ticket 1's guard.
- **Critical design point the doc understates:** **`turnId` must be minted at intake, in the gateway/Communication boundary — not at decision-making.service.ts:1249 where it currently is.** Today turnId is born *inside* the cycle, after the originating userId is already lost to the global slot. Moving turnId minting upstream is what makes Tickets 3/4 possible.
- **Files:** `conversation.gateway.ts` (handleMessage), `communication.service.ts` (new intake/queue), `tick-sampler.ts` (the text slot becomes the per-turn payload, not a clobbered global).
- **Acceptance:** the burst assertion's "exactly K responses" (no message lost under burst). Unit test: 3 enqueues before first drain → 3 turns processed in FIFO order.

### Ticket 3 — Thread identity end-to-end (frame → CycleResponse → DeliveryPayload) → **opus-agent**
- **Scope:** Carry `turnId`/`userId`/`speaker` on the sensory frame → `CycleResponse` → `DeliveryPayload`. `CycleResponse` (communication.types.ts:52) has `turnId` but **no `userId`/originator**; `DeliveryPayload` (`:184`) likewise. Add `originator: { userId, socketId, isGuardian }` to both (the `isGuardian` bit feeds Ticket 5's per-speaker provenance and the ×2/×3 asymmetry — see §7.2). Doc Part C.3 **Recommended option (thread through frame)** is correct — take it, **not** the correlation-registry fallback.
- **This is where text-attribution lands.** The April text-attribution need ("text must carry speaker identity before entering encoders/episodic memory") is *the same plumbing*. **Do them as one change** — the doc's "one change, two payoffs" is correct. Ticket 5 depends on this landing first.
- **Files:** `communication.types.ts` (both types), `tick-sampler.ts` (frame carries speaker), `decision-making.service.ts` (thread to CycleResponse), `communication.service.ts` (thread to DeliveryPayload), the encoder/episodic-write path (consume speaker).
- **Acceptance:** every `DeliveryPayload` carries a non-null `originator.userId` matching the turn's sender; episodic writes carry speaker id (gate can read the episode after a teach turn). **C1 grounded recall must not regress** (currently 87%) — verify `groundingProvenance` (communication.types.ts:93) survives the originator addition.

### Ticket 4 — Targeted delivery + per-turn speaker context → **opus-agent (forge consults on gateway shape)**
- **Scope:** (a) Replace `broadcast(delivery)` (conversation.gateway.ts:77) with a routed send to the originator's socket; keep `broadcast` only for genuinely-global events. (b) Replace the racing global `activePersonId` (person-model.service.ts:66, `setActivePerson` :370) with **per-turn speaker context** bound for the cycle's duration. Today `setActivePerson(userId)` is called from *two* places (gateway :167, `communication.parseInput` :172) and is overwritten by whoever speaks last — F.4's "active-person thrash" (doc Part B.4) is real.
- **Design note:** `getActivePersonModel()` (person-model.service.ts:362) reads the single mutable field. The cycle must instead read the speaker from the in-flight `InboundTurn`. Keep `activePersonId` only as a legacy/idle fallback or delete it.
- **Files:** `conversation.gateway.ts` (routing + observer channel), `person-model.service.ts` (per-turn context accessor), `communication.service.ts` (bind speaker for cycle).
- **Acceptance:** the done-state gate assertion (Ticket 7) — Person B's reply goes only to B's socket; Person A never receives B's reply.

### Ticket 5 — Per-person memory + privacy boundary (F.4 made real) → **atlas designs graph contract, opus-agent builds** — **CANON-BLOCKING**
- **Scope:** Fix the confirmed F.4 violation. (a) Stop writing `target: 'speaker'` personal facts into the shared WKG (communication.service.ts:597–601), OR make the WKG write provenance-correct per speaker. (b) Fix the hardcoded `provenance_type='GUARDIAN'`/`confidence=0.90` (communication.service.ts:639–653) to reflect the *actual* speaker's guardian status and the confidence ceiling. (c) **Resolved (§7.1): no `target: 'world'` path in WS4** — delete the `target:'speaker'` WKG dual-write entirely (don't provenance-correct it); world-fact promotion deferred to WS5-T1.
- **Person-A/Person-B pattern-replay:** latent-space Type-1 patterns are NOT person-scoped — the hot layer is global. A Type-1 reflex learned while talking to A *will* fire for B. Correct for world-knowledge patterns; a privacy leak for person-specific ones. The discriminator is the three-graph boundary: cached-pattern replay must check the pattern's `knowledgeGrounding` provenance is either world-scoped (WKG) or matches the *current* speaker's OKG; an OKG-A-grounded pattern replayed to B must drop to ungrounded rather than claiming GROUNDED. This protects the `knowledgeGrounding` column added 2026-06-10.
- **Files:** `communication.service.ts` (writeFastFacts, writeFactToWkg), `person-model.service.ts`, latent-space replay path (decision-making.service.ts grounding-for-cached-pattern).
- **Builder:** **atlas** owns the graph schema/provenance contract; **opus-agent** implements.

### Ticket 6 — Queue UX (position / now-serving / scoped thinking indicator) → **coordinator + forge**
- **Scope:** Doc Part D. Waiting speakers see "you're next / position N"; active speaker sees their thinking indicator + addressed reply. Today the thinking indicator is `broadcast` to everyone (conversation.gateway.ts:74, 161) — scope it to the active turn's socket.
- **Acceptance:** waiting socket receives a `queue_position` message, not a foreign reply.

### Ticket 7 — Gate extension: multi-interlocutor done-state assertions → **mythos defines, opus-agent builds harness**
Turns the done-state line into a provable gate. Non-trivial: the current gate structurally cannot exercise WS4 (see §6).

### Ticket 8 — Attractor-monitor alert for hostile-interlocutor mood-bleed (F.3 action item) → **ashby**
- **Scope:** ensure attractor monitors treat "one abusive interlocutor degrading global affect" as alertable, with the guardian-priority lane (F.1) as the intended circuit-breaker. Low priority within WS4; listed so it isn't lost.

---

## 3. Concurrency guard — design direction

**Protect:** the critical section is `processInput()` → the full 8-state executor cycle (CATEGORIZING…LEARNING, decision-making.service.ts:433+) plus the per-cycle event-buffer flush and `pendingLatentPatterns`/`recentGapTypes` mutation. One cycle owns all of this at a time.

**Mechanism — mutex + bounded FIFO queue, NOT preemption:**
- A single async mutex gates entry to `processInput`. The current `tickInFlight` boolean is the degenerate form; formalize it.
- Overlapping arrivals **enqueue** (bounded, suggest depth 8–16 — ashby to set). On overflow, apply **back-pressure**: reject the oldest *waiting* turn with an addressed "I'm a bit overwhelmed, ask me again in a moment" (never drop silently — theater prohibition).
- **Guardian-priority lane (F.1):** guardian turns insert at queue front, but **only affect the next selection** — the in-flight cycle always completes (preserves the executor's IDLE-entry invariant :438).
- **Never preempt a running cycle.** Yanking attention mid-cycle corrupts FSM state.

**Stalled-cycle detection & recovery — watchdog:**
- Wrap each cycle in a watchdog timeout (T_max — ashby to set; embed timeout is already 3000ms and the LLM has its own circuit breaker, so T_max bounds the *whole* cycle, suggest ~15–20s). On expiry: force-reset the executor to IDLE (the `finally { tickInFlight = false }` seam at decision-making.service.ts:403–406), emit an honest SHRUG/decline addressed to that turn's originator, log `CYCLE_WATCHDOG_KILL`, drain the next queued turn. This fixes the real-but-untested cascading-stall vulnerability from the 2026-06-10 lesion work.
- Circuit breaker on repeated watchdog kills (e.g., 3 in a row) → degraded mode (pure Type-1/SHRUG): right second layer, follow-up, not WS4-blocking.

**Interaction with the lesion degraded path (commit a68a826):** under lesion, cycles complete fast as Type-1/SHRUG. The watchdog must be tuned **above** normal lesion-mode cycle time or it fires spuriously during healthy lesion operation. The burst assertion must run **in both modes**. This is the one place Ticket 1 and the lesion work can collide — call it out to ashby.

---

## 4. Per-person memory + attribution — where identity enters

- **Input parse:** identity exists at the door (`clientUsers.get(client)`, conversation.gateway.ts:153) — keep.
- **Frame (the fix):** speaker rides the sensory frame from Ticket 3. The single correct insertion point — both the attribution-into-encoder/episodic point *and* the source of the addressed-reply identity. One write, both needs.
- **Episodic write:** consumes frame speaker → episodic memory correctly attributed (closes the April text-attribution gap).
- **OKG scoping vs. gate P0:** the gate's `clearFactsForPerson('guardian')` (person-model.service.ts:295) must wipe **every** corpus person (guardian + Person B) or replay non-determinism returns. Fold into Ticket 7.
- **Pattern replay:** addressed in Ticket 5 — OKG-A-grounded patterns must not replay GROUNDED to B; world-grounded patterns may.

---

## 5. CANON compliance check

- **Drive isolation:** untouched. No conflict.
- **Provenance-required (Std 1):** Ticket 3 strengthens it; Ticket 5 fixes a violation (hardcoded GUARDIAN provenance).
- **Confidence ceiling 0.60 (Std 3):** **active violation found** — non-guardian WKG fast-facts written at 0.90 (communication.service.ts:647). Ticket 5 must drop non-guardian self-reported facts to ≤0.60 until guardian-confirmed.
- **Theater prohibition (Std 4):** queue overflow and watchdog kills must produce honest addressed declines, never silent drops or fabricated "still thinking."
- **Guardian asymmetry (Std 5):** the CANON crux of WS4. (a) The guardian-priority lane is the mechanism that preserves it in the queue. (b) The WKG provenance hardcode currently grants every speaker guardian authority — the asymmetry is fictional until Ticket 5 lands. **Ticket 5 is CANON-blocking.**
- **No self-modification of evaluation:** untouched.

---

## 6. Gate extension (Ticket 7 detail)

**The current gate cannot prove WS4.** `converse()` (gate.ts:135–175) opens a fresh WebSocket per turn and closes it after the reply: it never has two sockets open at once (targeted-delivery passes trivially), it's inherently serial (queue/guard never exercised), and all turns are the anonymous `guardian` default (no token, gate.ts:137). **A WS4 build could ship completely broken and this gate would stay green.**

New provable criteria:
- **M5 "answers both individually, by name":** two persistent sockets with distinct JWTs (guardian + Person B). A asks, B asks (interleaved, <50ms). Assert: (a) A's `cb_speech` arrives only on A's socket and addresses A by name; (b) B's only on B's socket, by name; (c) neither receives the other's reply; (d) both non-empty and well-formed.
- **Concurrency burst (Ticket 1):** K=5 simultaneous turns → K responses, no executor throws, watchdog recovers an injected hang. Normal AND lesion mode.
- **P0′ multi-person reset:** gate hermeticity wipes every corpus person.
- **Privacy assertion:** teach a personal fact as Person B; assert it does NOT appear when querying as guardian (and vice versa) — proves Ticket 5.

Requires a persistent-socket, multi-user rewrite of `converse()` and JWT minting in the harness.

---

## 7. Risks / unknowns

Jim delegated forks 1 and 2 to mythos ("I'll defer to mythos on both", 2026-06-10). Both are now DECIDED below.

### 7.1 World-fact policy — **DECIDED (mythos, 2026-06-10, authority delegated by Jim)**

**Ratified, not revised.** WS4 is OKG-only for self-reported facts. World-fact promotion to WKG is deferred behind a guardian-confirmation gate to a named follow-up. Preserves Std 1 (provenance), Std 3 (≤0.60 ceiling pre-confirmation), Std 5 (guardian asymmetry). Grounded in `communication.service.ts:590-601` (dual-write) and `:626-659` (GUARDIAN/0.90 hardcode), verified at HEAD.

1. **The dual-write to WKG (`communication.service.ts:597-601`, the `target:'speaker'` branch) is removed for everyone, guardian included.** Self-reported personal facts are *person facts*, not world facts, regardless of speaker. They belong on the speaker's OKG anchor (`personModel.writeFact`) and nowhere else. "Keep for guardian only" is rejected: it re-introduces the category error F.4 fixes, narrowed to one user, and leaks the guardian's private statements into a graph Person B can read.
2. **Guardian self-facts do NOT dual-write to WKG.** Guardian self-facts go OKG-only at provenance `GUARDIAN`, confidence `0.90` (guardian self-knowledge is guardian-confirmed by definition). Non-guardian self-facts land OKG-only at ≤0.60 with non-guardian provenance (Ticket 5 fixes the hardcode). The asymmetry survives in the confidence/provenance tier, not in graph choice.
   - Ticket 5 note: the `target:'sylphie'` branch (`:602-613`, Self-KG + WKG CoBeing) is **out of scope and unchanged** — facts about Sylphie legitimately belong in the shared self/world view.
3. **No `target:'world'` extraction path in WS4.** `extractFactsFromText` continues to emit only `'speaker'`/`'sylphie'`. Deferred to named ticket **WS5-T1 "World-fact promotion + guardian-confirmation gate"** (create the wiki stub when WS4 closes).
4. **Shape of the deferred confirmation gate (WS5-T1, NOT WS4):** a `CandidateWorldFact` staging store (Prisma table or `:Candidate` WKG node, `provenance_type='CANDIDATE'`, confidence capped at speaker tier ≤0.60) — visible to reasoning as low-confidence, never GROUNDED. Promotion to a real WKG `Entity` only via explicit guardian action, reusing the existing `reportGuardianFeedback(turnId,'confirmation')` (communication.service.ts:518) + `guardian_feedback` WS message (conversation.gateway.ts:219) with a `candidateId` variant. No new auth surface.

**Acceptance adjustments → Ticket 5:** (a) after a `target:'speaker'` fast-fact write, WKG contains **zero** new `Entity` nodes keyed to the speaker's userId; the fact exists only on the OKG anchor. (b) Non-guardian self-fact written at confidence ≤0.60 with actual-speaker provenance. (c) Guardian self-fact OKG-only at 0.90. Ticket 5 scope item (c) is **resolved: ruled out of WS4** — delete the dual-write rather than provenance-correct it. The §6 privacy assertion then holds *by construction*.

### 7.2 Guardian identity bootstrap — **DECIDED (mythos, 2026-06-10, authority delegated by Jim)**

**The auth stack already exists and is the right one — stop discarding the guardian bit it already mints; make anonymous mean guest, not guardian.** No new auth mechanism. Grounded in: `auth.controller.ts:45-79` (bcrypt login + JWT with `isGuardian`, gated on `approved`), `schema.prisma:14-15` (`User.isGuardian`/`approved`), `auth.guard.ts` (HTTP guard already reads `isGuardian`), `rules.controller.ts:45,57` (existing isGuardian-gate precedent), frontend already passing `?token=` (`useWebSocket.ts:239-241`).

The defect is gateway-local: `extractUserFromConnection` verifies the JWT but drops `isGuardian` (conversation.gateway.ts:262); `handleMessage` defaults tokenless to `userId='guardian'` (`:154`); `handleConnection` hardcodes `ensurePersonNode(..., true)` (`:124`).

1. **What marks a connection as guardian:** the **`isGuardian: true` claim in the verified JWT** — nothing else. Signed by the login endpoint, backed by the DB `User.isGuardian` column only Jim can set. `ConnectedUser` gains `isGuardian: boolean`; `extractUserFromConnection` reads `payload.isGuardian ?? false`. The ×2/×3 guardian-asymmetry path keys off `user.isGuardian` carried on the in-flight turn, never identity-string matching.
2. **Anonymous (tokenless / invalid-token) connections become a named, non-guardian guest** — never `'guardian'`, never rejected: `{ userId: 'guest', username: 'guest', isGuardian: false }`. Replace `userId ?? 'guardian'` with `userId ?? 'guest'` (`:154`); pass `user?.isGuardian ?? false` to `ensurePersonNode` (`:124`). Guests get a real OKG anchor, can converse, get the non-guardian ceiling. Localhost dev stays frictionless; guardian status is unreachable without a signed token. Not gold-plated: no OAuth, no per-request re-auth, no IP checks.
3. **The gate (Ticket 7) mints its own JWTs** with `JWT_SECRET` + `jwt.sign`, identical to `auth.controller.ts:76-79` — it does not call `/api/auth/login`. Two tokens: guardian (`{sub:'guardian', username:'guardian', isGuardian:true}`) and Person B (`{sub:'personB', username:'Bea', isGuardian:false}`), each passed as `?token=` on its persistent socket. Legacy single-socket `converse()` mints the guardian token so current green criteria don't regress.
4. **Frontend migration: none.** A logged-out session becomes `guest` instead of silently-guardian; Jim logs in and his token carries `isGuardian:true` from his DB row. **One-time setup:** an idempotent seed (`yarn seed:guardian` or one-line Prisma update) ensuring Jim's `User` row has `isGuardian=true, approved=true`. `JWT_SECRET` must be set for server and gate — **verified SET in live `.env` (2026-06-10)**; note `.env.example:100` is empty, an unset secret silently reverts everyone to anonymous-guest.

**Acceptance adjustments:** **Ticket 4** gains: tokenless connection resolves to `userId='guest', isGuardian=false`; `ensurePersonNode` called with the real guardian flag, never literal `true`. **Ticket 7** gains a privilege assertion: a guest self-reported fact lands at ≤0.60 / non-guardian provenance and does NOT get ×2/×3 weighting; the guardian-token turn does — proving the asymmetry keys to the JWT bit. **Ticket 3** must carry `isGuardian` on the originator: `originator: { userId, socketId, isGuardian }` in `communication.types.ts`.

### 7.3 Remaining (open)

3. **Watchdog T_max vs. healthy lesion-mode latency** — needs empirical measurement before ashby fixes the number.
4. **Voice cache is global** (communication.service.ts:415, keyed text+valence, not person). Acceptable (TTS audio, not knowledge); no action unless Jim wants per-person voice.

---

## Build sequence (one line)
**1 (ashby+opus) → 2 (opus) → 3 (opus) → 4 (opus+forge) → 5 (atlas+opus, CANON-blocking) → 7 (mythos+opus, the proof) → 6 (self+forge) → 8 (ashby).** Tickets 1–5 are the substrate; 7 is the gate that proves it; 6 and 8 are polish/safety.

## Files that matter most
- `packages/decision-making/src/decision-making.service.ts` (tickInFlight :203, cycle :376/:433, turnId mint :1249)
- `packages/decision-making/src/inputs/sampling/tick-sampler.ts` (single-slot clobber :130/:154)
- `apps/sylphie/src/gateways/conversation.gateway.ts` (broadcast :77/:232, setActivePerson :167, anonymous-guardian :154)
- `apps/sylphie/src/services/communication.service.ts` (delivery$ :73, writeFastFacts :583, **GUARDIAN/0.90 hardcode :639–653**)
- `apps/sylphie/src/services/person-model.service.ts` (activePersonId :66, no target=world :461, clearFactsForPerson :295)
- `packages/shared/src/types/communication.types.ts` (CycleResponse :52, DeliveryPayload :184 — neither carries originator)
- `test/gate/gate.ts` (fresh-socket-per-turn :135 — cannot prove WS4), `test/gate/corpus.ts` (single-user)
- `wiki/ideas/decision-cycle-concurrency-guard.md` (Ticket 1 source)

## Specialist handoffs
ashby (concurrency-guard stability + watchdog params + attractor alert), atlas (Ticket 5 graph provenance contract), forge (gateway/WS shape for Tickets 4/6), opus-agent (all heavy builds). mythos re-engages only if Jim's answer to risk #1 reopens a design fork, and for Ticket 7 assertion definition + final WS4 verification/live smoke per the mandatory-verification policy.
