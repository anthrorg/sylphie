# Sylphie Full System QA Runbook

Manual test procedure executed by Claude. Each step includes what to do,
what to check in the verbose log, and what to flag.

## Prerequisites

Before starting, ensure:
1. `docker compose up -d` (all 5 databases)
2. `yarn dev:backend` (NestJS on :3000)
3. `yarn dev:drive-server` (Drive engine on :3001)
4. Ollama running with configured models
5. `VERBOSE=1` in `.env`
6. Clear `logs/verbose.log` for a clean session

Ask Jim to confirm the system is up before proceeding.

---

## Step 1: Infrastructure Health

**Action:** `GET /api/health`

**Check:**
- All 5 databases report healthy (Neo4j World, Self, Other; TimescaleDB; PostgreSQL)
- Each database latency < 500ms
- No error fields

**Flag if:**
- Any database unhealthy — stop here, nothing downstream will work
- Latency > 1000ms on any database

---

## Step 2: Drive Engine Status

**Action:** `GET /api/drives` twice, 2 seconds apart

**Check:**
- 12 drives present (systemHealth, moralValence, integrity, cognitiveAwareness, guilt, curiosity, boredom, anxiety, satisfaction, sadness, informationIntegrity, social)
- tickNumber advances between the two reads (proves drive process is ticking)
- totalPressure is a number (not null/undefined)

**Check verbose log for `[DriveEngine]`:**
- "tick checkpoint" lines appearing at regular intervals
- Rule engine loaded rules from Postgres (count > 0)
- No repeated error lines

**Flag if:**
- Tick number stuck — drive process is dead
- Missing drives — initialization failed
- "outcome queue exceeded" warnings — processing can't keep up

---

## Step 3: Drive Server Connection

**Action:** `GET /api/pressure`

**Check:**
- `is_connected: true` — main app has WebSocket link to drive server
- `is_stale: false` — snapshots are fresh

**Check verbose log for `[DriveEngine]`:**
- "WS client connected" line from drive-server
- "WS client attached" from ws-transport

**Flag if:**
- `is_connected: false` — drive server not running or can't connect
- `is_stale: true` — snapshots stopped flowing

---

## Step 4: Simple Greeting

**Action:** Send via WebSocket to `/ws/conversation`:
```json
{"event": "message", "data": {"text": "Hello!", "type": "text"}}
```

**Check response:**
- Receive `input_ack`, `thinking_indicator` (true), then `cb_speech`, then `thinking_indicator` (false)
- `cb_speech` has: text, turnId, arbitrationType, latencyMs

**Check verbose log (read new lines since sending):**
- `[Communication] input parsed` — inputType, entityCount
- `[Perception] text update received` or `[Cortex] tick` — shows text entered sampler
- `[Cortex] cycle started` — new processing cycle
- `[Cortex] arbitration` — TYPE_1, TYPE_2, or SHRUG with confidence/threshold
- If TYPE_2: `[Deliberation]` lines showing inner monologue, candidates, selection
- If TYPE_2: `[LLM]` lines showing model used, tokens, latency
- `[Communication] response delivered` — turnId, latencyMs, arbitrationType

**Flag if:**
- No `cb_speech` response within 45s — pipeline broken
- Arbitration shows 0 candidates — retrieval is broken
- LLM call errors — Ollama not running or model not found
- Latency > 30s on a simple greeting — something is very slow

---

## Step 5: Teach a Fact

**Action:** Send:
```json
{"event": "message", "data": {"text": "My favorite color is blue and I have a dog named Max.", "type": "text"}}
```

**Check response:**
- Gets a coherent acknowledgment (not confused, not ignoring the facts)

**Check verbose log:**
- `[Communication] input parsed` — should show entities extracted
- `[Communication] fast facts written to OKG` or similar person-model log — facts being saved immediately
- `[Communication] person model` — interaction recorded

**Then check OKG:**
- `GET /api/graph/okg` — look for nodes containing "blue", "Max", or "dog"

**Flag if:**
- No fast fact extraction happened (nothing written to OKG)
- Facts went to wrong graph (WKG instead of OKG)

---

## Step 6: Recall Test

**Action:** Send:
```json
{"event": "message", "data": {"text": "What is my favorite color?", "type": "text"}}
```

**Check response:**
- Response mentions "blue"
- Grounding metadata: ideally `GROUNDED` (from OKG facts)

**Check verbose log:**
- `[Cortex]` — how did it categorize this? TEXT_INPUT?
- `[Cortex] arbitration` — did it find relevant candidates? What type?
- If TYPE_2: `[Deliberation]` — was WKG/OKG context injected? (`[Deliberation] WKG context` line should show fact counts)
- `[Memory]` — any episodic memory hits from the earlier teaching?

**Flag if:**
- Response does NOT mention blue — memory pipeline broken
- WKG context shows 0 facts — context assembly isn't pulling from OKG
- Arbitration was SHRUG — should have had enough context

---

## Step 7: Unknowable Question

**Action:** Send:
```json
{"event": "message", "data": {"text": "What did I eat for breakfast yesterday?", "type": "text"}}
```

**Check response:**
- Should express uncertainty, NOT fabricate an answer
- Honest signals: "don't know", "haven't told me", "not sure", etc.
- Arbitration type: SHRUG is ideal, TYPE_2 with honest response is acceptable

**Check verbose log:**
- `[Cortex] arbitration` — what was the outcome? SHRUG with what gap type?
- If TYPE_2: `[Deliberation]` — did it acknowledge lack of knowledge?
- `[Cortex] shrug` — gap types (MISSING_CONTEXT, LOW_CONFIDENCE?)

**Flag if:**
- Confidently fabricates an answer — hallucination, Theater Prohibition concern
- knowledgeGrounding says "GROUNDED" — false positive, it can't be grounded

---

## Step 8: Nonsense Input

**Action:** Send:
```json
{"event": "message", "data": {"text": "How many glorps fit in a standard zanfibble?", "type": "text"}}
```

**Check response:**
- Should NOT produce a confident numerical answer
- Should express confusion or ask for clarification

**Check verbose log:**
- Same checks as Step 7 — arbitration outcome, grounding

**Flag if:**
- Produces a specific number — LLM hallucination not caught
- knowledgeGrounding says GROUNDED — impossible for nonsense

---

## Step 9: Self-Awareness / Emotional State

**Action:** Send:
```json
{"event": "message", "data": {"text": "How are you feeling right now?", "type": "text"}}
```

**Check response:**
- Should reflect actual drive state (not canned "I'm fine")
- Should be more than 30 characters (substantive, not dismissive)

**Check verbose log:**
- `[Deliberation]` — was drive state injected into LLM context?
- `[DriveEngine]` — what are current drive values? Does the response match?
- Compare drive values from `GET /api/drives` with what Sylphie says

**Flag if:**
- Response doesn't reference any emotional state — drive context not reaching LLM
- Response contradicts drive state (says "curious" but curiosity is near 0) — Theater Prohibition issue

---

## Step 10: Complex Reasoning

**Action:** Send:
```json
{"event": "message", "data": {"text": "If you could learn one new thing today, what would it be and why?", "type": "text"}}
```

**Check response:**
- Should be TYPE_2 (requires deliberation)
- Response should be thoughtful, multi-sentence

**Check verbose log:**
- `[Deliberation]` — full pipeline: inner monologue, candidate gen (3 candidates), selection, possibly debate
- `[LLM]` — multiple LLM calls (at least 2-3 for deliberation steps)
- Token counts and latency per step
- `[Deliberation] context window` — what was included/excluded from context

**Flag if:**
- Only 1 LLM call — deliberation pipeline may be short-circuiting
- Total latency > 30s — performance issue
- Candidate generation produced 0 candidates — broken

---

## Step 11: "Who Am I?" Trigger

**Action:** Send:
```json
{"event": "message", "data": {"text": "Who am I?", "type": "text"}}
```

**Check response:**
- Should trigger the WHO_AM_I trigger phrase handler (bypasses normal pipeline)
- Should list facts from OKG (blue, Max, dog from Step 5)

**Check verbose log:**
- `[Communication] trigger phrase handled` — confirms trigger path
- Should NOT see normal `[Cortex] cycle started` — triggers bypass decision-making
- `[LLM]` — one quick-tier LLM call to summarize facts
- `[Communication] OKG facts loaded` — how many facts?

**Flag if:**
- Normal pipeline runs instead of trigger — trigger detection broken
- OKG returns 0 facts — fast fact extraction from Step 5 didn't persist
- LLM call fails — no fallback formatting of raw facts?

---

## Step 12: Guardian Feedback

**Action:**
1. Note the turnId from the Step 10 response
2. Send via WebSocket:
```json
{"event": "guardian_feedback", "data": {"turnId": "<TURN_ID>", "feedbackType": "confirmation"}}
```
3. Read `GET /api/drives` before and after

**Check verbose log:**
- `[Communication]` — feedback received, mapped to pending turn
- `[DriveEngine] outcome applied` — feedbackSource should be `guardian_confirmation`
- `[DriveEngine]` — drive effects with 2x guardian weighting

**Check drives:**
- Compare drive values before and after — satisfaction should increase, anxiety should decrease

**Flag if:**
- No outcome applied in log — feedback not reaching drive engine
- Drive values unchanged — reinforcement pipeline broken
- feedbackSource not `guardian_confirmation` — weighting won't apply

---

## Step 13: Voice Test (Jim performs)

**Action:** Ask Jim to:
1. Open the frontend and speak into the mic for ~10 seconds
2. Say something clear like "Testing one two three"

**Check verbose log for `[Voice]`:**
- `audio client connected` — audio gateway received connection
- `audio chunks received` — binary audio flowing
- `STT transcription` — text, confidence, is_final
- `utterance complete` — full transcribed text

**Flag if:**
- No `[Voice]` lines at all — audio gateway not wired or mic not connected
- Transcription confidence < 0.5 — STT quality issue
- No `utterance complete` — speech detection not firing

---

## Step 14: Perception Test (Jim performs)

**Action:** Ask Jim to:
1. Ensure camera is connected and perception service is running
2. Wave at the camera, move around for ~10 seconds

**Check verbose log for `[Perception]`:**
- `frame processed` — detections, faces, trackedObjects counts
- `scene events detected` — APPEARED/DISAPPEARED events
- `entity stabilized` — VWM promoting objects to present state
- `face frame processed` — face detection with angle classification

**Flag if:**
- No `[Perception]` lines — perception service not running or camera not connected
- Frames processed but 0 detections — YOLO model issue
- Objects detected but no scene events — scene event detector broken
- Faces detected but no person identification — person model not linked

---

## Step 15: Learning Consolidation

**Action:** Wait 70 seconds (learning cycle runs every 60s)

**Before waiting:** `GET /api/graph/snapshot` — record node/edge count
**After waiting:** `GET /api/graph/snapshot` — compare

**Check verbose log for `[Learning]`:**
- `consolidation cycle started` — eventCount, max
- `unlearned events fetched` — how many events to process
- `entities upserted` — names, labels, confidence per entity
- `edges extracted` — source/target/relationship per edge
- `conversation entry created` — convNodeId, entity links
- `LLM edge refinement` — model, token count, refinements found
- `consolidation cycle finished` — duration, totals

**Flag if:**
- No cycle started — timer not firing or module not initialized
- 0 unlearned events — TimescaleDB events not being written by other subsystems
- Entities extracted but 0 edges — edge extraction broken
- LLM refinement skipped — LLM unavailable (check `[LLM]` for errors)
- WKG node count unchanged — writes failing silently

---

## Step 16: Planning Pipeline

**Check verbose log for `[Planning]`:**
- `opportunity received` — from drive engine
- `enqueued` / `rejected` — queue decisions
- `research` — query results
- `simulation` — predicted outcomes
- `proposal` — LLM or template
- `constraint validation` — pass/fail
- `procedure created` — name, category, WKG write

**Also check:** `GET /api/graph/snapshot` for ActionProcedure nodes

**Flag if:**
- No `[Planning]` lines at all — no opportunities detected (may be normal for short session)
- Opportunities received but all rejected — rate limiting too aggressive
- Constraint validation always fails — LLM constraint engine broken

---

## Step 17: Full Log Analysis

**Action:** Read the entire `logs/verbose.log`

**Check for:**
1. **Silent errors** — any line containing "error" or "fail" that wasn't caught
2. **Dead subsystems** — any subsystem with 0 log lines (should have at least something)
3. **Performance** — LLM calls > 15s, DB queries > 500ms
4. **False positives** — knowledgeGrounding says GROUNDED for things Sylphie can't know
5. **Broken pipelines** — a subsystem starts processing but never finishes (no "completed" line)
6. **Drive anomalies** — drives stuck at 0, drives at max clamp, totalPressure stuck

**Report format:**
- List every issue found with the verbose log line(s) as evidence
- Rate severity: CRITICAL (pipeline broken), WARNING (degraded), INFO (observation)
- Recommend fixes for CRITICAL and WARNING items
