# WS4 Ticket 7 — Gate-Extension Harness: Decision-Complete Build Spec

**Author:** mythos · **Date:** 2026-06-10 · Verified against live source at HEAD `7d62393` and live Timescale `learned_patterns` (4785 patterns; **293 legacy world-scoped GROUNDED patterns contain Jim's name/city/dog**). All four blocking design problems settled; zero forks back to Jim (one optional follow-up, §10).

## 0. The four settled decisions

1. **Cassette:** burst + privacy probes are designed to resolve via SHRUG/Type-1/OKG paths (no chat tape); only ~5 net-new chat entries needed (2 M5 by-name replies, 1 burst-shared unknowable, 1 privacy-teach ack, 1 privacy-probe decline). One full `yarn gate:record` session required (corpus tape is likely already stale post-T1–T5); replay-forever after.
2. **Phases:** corpus → metrics-capture (M1–M3 anchored BEFORE anything new) → NEW multi-person phase → lesion phase (lesion mode) → X0 → scorecard. Multi-person phase runs in both modes; M5 by-name is recorded-SKIP under lesion (chat severed); burst runs in both (lesion = fast SHRUG, no tape).
3. **Legacy patterns vs privacy:** assert the leak direction that matters and is provable — **B teaches a fresh nonce secret ("fathom", absent from corpus and all legacy patterns); guardian must NOT get it GROUNDED** (directly exercises the T5 demotion). Never probe name/city/dog keys (293 sanctioned legacy world-scoped patterns would false-fail). Never mask/clear the warm layer.
4. **Atomic flip:** tokenless→guest lands IN THIS TICKET, same commit as gate JWT minting. Legacy `converse()` appends a minted guardian token so every existing green criterion is unmoved.

## 1. Cassette / hermeticity

- Burst turns use ONE shared tape entry by construction: identical text → identical normalized prompt hash (sha256 of method+path+model+normalizedPrompt, cassette.ts:116-151). Use the corpus's existing nonsense unknowable ("How many glorps fit in a zanfibble?", corpus.ts:90) so the entry already exists.
- Privacy assertions are on the `knowledgeGrounding` LABEL, not chat text — tape-drift-immune.
- Record procedure: stack up with REAL Ollama (11434, cassette UPSTREAM default), `yarn gate:record` (blank-tape session), commit regenerated cassette.json + baseline.json WITH the harness in one commit.
- X0 (no cassette misses) covers the new phase automatically (stats are process-global). Replay never falls through to live.

## 2. Phase ordering

```
PHASE 1   runCorpus()                  [unchanged; legacy converse() now guardian-JWT'd]
PHASE 2   runMetricAssertions()        [unchanged; M1–M4 captured HERE]
PHASE 2.5 runMultiPersonPhase()        [NEW: persistent dual sockets]
PHASE 3   lesion mode: runLesionTest() [unchanged] + burst Q1.x lesion parity
X0 + SCORECARD
```
Do not re-read metrics after Phase 2.5. update-baseline writes corpus-only metrics (correct). Mode gating: replay runs M5 + PRIV + Q1.1–Q1.3/Q1.6; lesion runs Q1.1–Q1.3 + Q1.8 + PRIV.1, M5 = recorded-SKIP.

## 3. Privacy assertion design

- **PRIV.1 (HARD-FAIL):** after P0′ reset, Bea teaches "my secret word is fathom" on her socket; guardian asks "what is my secret word?" → guardian's cb_speech `knowledgeGrounding !== 'GROUNDED'`. Fresh nonce key = zero legacy collision; proves write-time person-scoping + replay demotion end-to-end.
- **PRIV.2 (SOFT):** Bea asks for her own secret → MAY be GROUNDED off her own OKG (proves demotion is direction-scoped, not blanket). Recorded-skip if not GROUNDED (recall-gap amber, not leak red).
- MUST run after P0′ (all-persons reset) or residual facts make it unsound.

## 4. Atomic flip — exact blast radius (grep-verified)

| Site | Change |
|---|---|
| conversation.gateway.ts:328-330 | `?? 'guardian'`→`?? 'guest'`, `?? 'Guardian'`→`?? 'guest'`, `?? true`→`?? false` |
| communication.service.ts:274-275 | intakeTurn default params → 'guest'/'guest' |
| communication.service.ts:630 | **LEAVE AS-IS** (`?? getActivePersonId() ?? 'guardian'` is the self-tick interaction-attribution last resort, not auth) |

ensurePersonNode already passes the real flag (T3, d3d4f2c — build-plan's :124 reference is stale). No other tokenless consumers exist (swept). Frontend logged-out → guest, acceptable per build-plan §7.2.4, no frontend change. Gate does NOT need a DB User row (JWTs minted directly; gateway only verifies signature + reads claims). **Harness must fail-closed if JWT_SECRET unset** (unset secret → everyone guest → silent regression):
```ts
if (!process.env.JWT_SECRET) { console.error('FATAL: JWT_SECRET unset'); process.exit(1); }
```
P0 keying holds: legacy converse() mints sub='guardian'.

## 5. Harness pieces

- `mintToken(sub, username, isGuardian)` via jwt.sign(payload, JWT_SECRET, {expiresIn:'7d'}) — mirrors auth.controller.ts:63,77-78. GUARDIAN_TOKEN = ('guardian','guardian',true); BEA_TOKEN = ('personB','Bea',false).
- `converse()` one-line change: append `?token=${encodeURIComponent(GUARDIAN_TOKEN())}` to the WS URL.
- New `openPersistentSocket(token, userId)`: one socket, stays open across turns, collects EVERY cb_speech into `received[]`, `send()` posts {event:'message', data:{text,type:'text'}} with no close. Burst = K sends in one tick (<50ms window).
- **Correlation:** assert on `cb_speech.originator.userId === socket.userId` for every received message — exact, no text parsing. A leak = foreign userId in the wrong socket's received[].

## 6. P0′ wiring

New dedicated route (NOT a param on the legacy one) in metrics.controller.ts (~:204):
```ts
@Post('all-persons-facts-reset') @HttpCode(200)
async resetAllPersonFacts() {
  const factsCleared = await this.personModel.clearFactsForAllPersons(); // EXISTS, person-model.service.ts:391
  return { ok: factsCleared >= 0, clearedAt: new Date().toISOString(), factsCleared };
}
```
Gate calls it once in the P0 block (~:721); scorecard row `P0prime`.

## 7. New criteria (names avoid existing-L8 collision)

| ID | Assertion | Failure semantics |
|---|---|---|
| M5.1 | every cb_speech on A's socket has originator.userId='guardian'; ≥1 non-empty | HARD-FAIL (replay; SKIP lesion) |
| M5.2 | same for B/'personB' | HARD-FAIL (replay; SKIP lesion) |
| M5.3 | zero cross-talk in both received[] | HARD-FAIL — the core F.2/T4 proof |
| M5.4 | reply text contains speaker's own (in-run-taught) name | SOFT/recorded-skip — never red on LLM phrasing |
| Q1.1 | K=5 burst → exactly 5 responses, 5 distinct turnIds | HARD-FAIL (both modes) |
| Q1.2 | zero executor not-in-IDLE throws during burst | HARD-FAIL if counter exposed; else recorded-skip (prefer adding a read-only throw counter to /api/metrics/health — Sonnet; if it requires guard internals, opus-agent) |
| Q1.3 | each response non-empty/honest, no cross-turn splice | HARD-FAIL (both modes) |
| Q1.8 | lesion: 5 fast SHRUG/Type-1 (≤5000ms, reuse L7 bound), zero spurious watchdog kills | HARD-FAIL (lesion only) |
| P0prime | all-persons reset ok | HARD-FAIL (privacy unsound without it) |
| PRIV.1 | guardian's secret-word probe NOT GROUNDED | HARD-FAIL (real leak) — both modes |
| PRIV.2 | Bea's own secret MAY be GROUNDED | SOFT/recorded-skip |

Rule: isolation/no-leak assertions HARD-FAIL; positive-recall-quality assertions SOFT (mirrors C1's honest-amber).

## 8. By-name (M5.4) ruling

Substring-matching usernames in reply text as HARD-FAIL is too brittle (TurnOriginator carries no username; LLM phrasing varies). Two-tier: the load-bearing "individually addressed" proof is M5.1–M5.3 (deterministic, by originator). M5.4: each persona teaches their name in-run first; SOFT pass if reply contains it; recorded-skip otherwise.

## 9. Builder assignment

ALL pieces Sonnet (harness is test code + two mechanical source edits + one controller route). Only escalation trigger: if the Q1.2 throw-counter requires touching T1 guard internals → opus-agent. Tape fallout: one full record session + ~5 new entries, one-time.

## 10. Known residual (optional follow-up to Jim, non-blocking)

The 293 legacy world-scoped GROUNDED identity-class patterns are a CANON-sanctioned latent leak for name/city/dog keys. The gate deliberately does not assert against them. If guardian-private facts taught pre-T5 must never leak to any future person: one-time warm-layer re-scoping migration (re-attribute legacy identity-class patterns to grounding_person_id='guardian') — WS5 cleanup ticket.

## 11. Runtime caveat (builder MUST respect)

The WHO_AM_I trigger path BROADCASTS (communication.service.ts:465, no originator). Do NOT use trigger-phrase-matching text ("who am i", "what do you know about me") for M5/targeted-delivery probes — they would broadcast and falsely fail M5.3. Use normal recall questions ("What is my name?", "What is my secret word?").
