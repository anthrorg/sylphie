# Sylphie — Chat System Wiring & the Multi-Interlocutor Queue

Date: 2026-06-09 · HEAD `5e99a46`
Method: direct code reading (`apps/sylphie/src/gateways/conversation.gateway.ts`, `services/conversation-history.service.ts`, `services/person-model.service.ts`, `packages/decision-making/*`, `packages/shared/src/types/communication.types.ts`)

This document describes **how the chat path is wired today**, **why every connected user sees the same stream**, and the design for the target state Jim described: *one mind that melds all questions into a single queue and responds independently, one at a time.*

---

## Part A — How it's wired today

### A.1 The shape of it

The conversation path is a thin WebSocket transport (`ConversationGateway`) in front of a **single, process-wide cognitive loop**. There is exactly one Sylphie: one decision-making service, one drive engine, one conversation history, one "active person." Every connected client feeds into that one mind, and every response fans back out to all of them.

```
                  ┌──────────── all clients in one Set ────────────┐
   User A ─ws─┐   │                                                 │
   User B ─ws─┼──▶│  ConversationGateway                            │
   User C ─ws─┘   │   handleMessage(text, client)                   │
                  │     │                                           │
                  │     ├─ tickSampler.updateText(text)  ◀── SINGLE global 'text' slot
                  │     ├─ personModel.setActivePerson(userId) ◀── SINGLE global field
                  │     └─ conversationHistory (one global array)   │
                  │                  │                              │
                  │                  ▼                              │
                  │   DecisionMakingService (singleton, 1 tick loop)│
                  │     tickInFlight guard → one cycle at a time    │
                  │                  │                              │
                  │                  ▼                              │
                  │   CommunicationService.delivery$                │
                  │     emits DeliveryPayload { turnId, text, ... } │  ◀── NO originator id
                  │                  │                              │
                  │                  ▼                              │
                  │   broadcast(delivery) ── sends to EVERY client ─┼──▶ A, B, C all receive it
                  └─────────────────────────────────────────────────┘
```

### A.2 Input path (verbatim)

`conversation.gateway.ts:146` `handleMessage(data, client)`:

- Identifies the sender per-socket: `const user = this.clientUsers.get(client)` (`:153`). Good — identity *exists* at the door.
- Sets the **global** active person: `this.personModel.setActivePerson(userId)` (`:167`).
- Pushes the text into a **single global modality slot**: `this.tickSampler.updateText(data.text)` (`:184`).
- Pushes conversation history / summary / person-model / speaker_name into other single global slots (`:190`–`:211`).

`person-model.service.ts:66`: `private activePersonId: string | null = null;` — one field, overwritten by whoever spoke last.

`conversation-history.service.ts`: `private readonly history: ConversationEntry[] = []` (one array) and `private readonly sessionId = randomUUID()` (one id minted **once per process**, not per connection).

`decision-making.service.ts:188`: `private tickInFlight = false;` — a single boolean that serializes cognition. (This is actually the right primitive for the target design — see Part C.)

### A.3 Output path (verbatim)

`conversation.gateway.ts:71` (`onModuleInit`): subscribes to `this.communication.delivery$` and on every delivery calls `this.broadcast(delivery)` (`:77`).

`conversation.gateway.ts:232` `broadcast(payload)`:
```ts
for (const client of this.clients) {
  if (client.readyState === WebSocket.OPEN) {
    client.send(message);          // sent to EVERY connected socket
  }
}
```

`communication.types.ts:168` `DeliveryPayload` carries `type`, `text`, `turnId`, audio, badges — **but no `userId` / `sessionId` / originator.** The response does not know who asked.

---

## Part B — Why all users see the same stream

Two independent structural defects, either of which alone would cause it:

1. **Broadcast output.** Responses are sent to *all* clients (`broadcast`, `:234`), never to the originating socket. Even single-user, this is "send to everyone."

2. **Identity is not threaded end-to-end.** The sender is known at intake (`clientUsers.get(client)`) but is **dropped** before the response exists — `DeliveryPayload` has no originator field. So the gateway *could not* address the reply to the right user even if it wanted to.

And two amplifiers that corrupt the content itself under concurrency:

3. **Single-slot input clobber.** `tickSampler.updateText()` overwrites one global `'text'` value. Two users typing close together → the second overwrites the first before a tick consumes it. Messages don't queue; they race, and the loser vanishes.

4. **Active-person thrash.** `setActivePerson(userId)` overwrites one global field. While User A's turn is being deliberated, User B's message can flip `activePersonId` to B — so A's response may be assembled against B's person-model and OKG context.

**Net behavior:** there is one shared conversation, one shared "who am I talking to," and one outbound firehose. It behaves like a single chat room with one occupant (Sylphie) whose attention pointer and input buffer are global mutable state.

### What this is *not*

It is **not** a per-user isolation bug to be fixed by sharding Sylphie into one instance per user. Sylphie is, by CANON, a *single being* — one `:CoBeing` anchor, one drive substrate, one self-model. Spinning up a Sylphie-per-user would be N separate minds and would violate the entire premise. The correct fix keeps **one mind** and gives it **structured attention over many interlocutors.** That is Part C.

---

## Part C — The correct model: one mind, many interlocutors

The mental model is a person in a room with several people talking to them. One mind. It attends to **one speaker at a time**, answers *that* speaker, then turns to the next. It remembers each person distinctly. It can feel pulled in several directions (Social/Focus drives). This maps cleanly onto the existing architecture — the `tickInFlight` serial guard is already the cognitive equivalent of "I can only think one thought at a time."

Four moves turn today's broadcast room into that:

### C.1 An intake queue (meld all questions into one queue)

Replace the single-slot `updateText` race with a **turn queue** at the Communication boundary. Each inbound message becomes a `Turn`:

```ts
interface InboundTurn {
  turnId: string;        // minted at intake, rides the whole cycle
  userId: string;        // who asked
  username: string;
  socketId: string;      // where the answer goes back
  text: string;
  receivedAt: number;
}
```

Messages are **enqueued, not clobbered.** Nothing is lost under concurrency.

### C.2 Serial draining (respond one at a time)

Sylphie drains the queue one turn at a time. The existing `tickInFlight` guard already enforces "one cognitive cycle at a time" — wire the queue to feed the next turn only when the previous cycle completes. This is not a workaround; it's the honest model of a single attention. While a turn is in flight, new arrivals join the back of the queue.

Decision to make: **ordering policy.** FIFO is the default. But Guardian Asymmetry (CANON Standard 5) argues the guardian should be able to *jump the queue* — guardian turns get priority, mirroring how the rest of the system already privileges guardian input ×2/×3. Recommended: FIFO with a guardian-priority lane.

### C.3 Identity threaded end-to-end (so replies can be addressed)

The turn's identity must survive the whole `text → frame → decision → response → delivery` chain so the gateway can route the answer home. Two implementation options:

- **(Recommended) Thread it through the frame.** Carry `turnId`/`userId`/`speaker` on the sensory frame → `CycleResponse` → `DeliveryPayload`. This is *the same plumbing already required by the flagged "text must carry speaker identity before entering encoders/episodic memory" need* (project memory: text-attribution). Doing it once solves both: addressed replies **and** correctly-attributed episodic memory. One change, two payoffs.
- **(Lighter, weaker) Correlation registry.** Keep a gateway-side `Map<turnId, socketId>` populated at intake and looked up at delivery. Less invasive, but leaves the cognitive loop identity-blind — so episodic memory still can't attribute the speaker. Use only as an interim.

Add `originator: { userId, socketId }` (or at minimum `turnId` correlatable to it) to `DeliveryPayload`.

### C.4 Targeted delivery + per-turn speaker context

- **Delivery:** route `DeliveryPayload` to the **originating socket** (lookup by `userId`/`socketId`), not `broadcast`. Keep `broadcast` only for genuinely global events (telemetry, thinking state) — and even those can be scoped.
- **Speaker context:** replace the racing global `activePersonId` with **per-turn speaker context** drawn from the `Turn` being processed. The OKG/person-model used during a cycle must be the speaker of *that* turn, fixed for the duration of the cycle, immune to other arrivals. (`setActivePerson` becomes "set for this turn," not "set globally and hope.")

---

## Part D — Queue UX (what each person sees)

Today everyone sees a global "thinking" indicator and every reply. The multi-interlocutor version needs per-person feedback:

- **Active speaker:** sees `thinking_indicator` and then their addressed reply.
- **Waiting speakers:** see "Sylphie is with someone right now — you're next / position N," not a thinking indicator for a turn that isn't theirs and not someone else's answer.
- **The guardian / an observer view (optional, deliberate):** may *choose* to see the full melded stream (everyone's turns and Sylphie's replies) — but as an explicit observer role, not the default every socket gets. This is how Jim watches "one coherent mind" handle the room.

The point: **mirroring to others becomes a deliberate, role-based choice, not an accident of `broadcast`.**

---

## Part E — Concrete change set

Minimal, ordered, each independently shippable:

1. **`DeliveryPayload`** (`packages/shared/src/types/communication.types.ts`): add `originator` (userId + socketId, or a correlatable turnId). *Type-first, as is the house style.*
2. **Intake queue** at the Communication boundary: `handleMessage` enqueues an `InboundTurn` instead of calling `updateText` directly; a drainer feeds the cognitive loop one turn at a time, gated on `tickInFlight`.
3. **Thread identity through the cycle** (frame → `CycleResponse` → `DeliveryPayload`). Shared with the text-attribution work — do them together.
4. **Per-turn speaker context**: `person-model.service.ts` exposes "context for this turn's speaker" rather than a single mutable `activePersonId`; the cycle binds it for the turn's duration.
5. **Targeted delivery** in `ConversationGateway`: replace `broadcast(delivery)` with a routed send to the originator's socket; keep an explicit observer/guardian mirror path.
6. **Queue UX**: position/now-serving messages for waiting clients; scope the thinking indicator to the active turn.

Nothing here adds a second mind, a second drive engine, or per-user state in the cognitive core. It adds **structured attention** (a queue) and **addressing** (threaded identity) around the single mind that already exists.

### E.1 Two interactions the queue must not break

- **Trigger phrases bypass the queue — deliberately.** `handleMessage` checks `handleTriggerPhrase(text, sessionId, userId)` (`conversation.gateway.ts:171`) *before* the normal pipeline; trigger responses (e.g. "Who am I?" → OKG lookup) never consume a cognitive cycle. Keep that: a trigger phrase is a reflex, not a thought, so it answers immediately even while another user's turn is in flight. Two requirements carry over anyway: the reply must be **addressed to the asker** (not broadcast), and the trigger handler must read the **asker's** person context rather than the global `activePersonId` (today it takes `userId` as a parameter, which is the right shape — verify it never falls through to the global).
- **Guardian feedback is queue-independent.** `handleGuardianFeedback` (`conversation.gateway.ts:219`) correlates by `turnId` against `pendingTurns` — it neither enters the turn queue nor needs to. Once `turnId` is threaded end-to-end (C.3), feedback correlation gets *more* reliable under concurrency, not less, because each pending turn is unambiguously tied to its speaker.

---

## Part F — Decisions (resolved)

These four forks are decided. Reasoning recorded so the calls can be revisited if a decision turns out wrong.

### F.1 Ordering → **FIFO with a guardian-priority lane**

The guardian is structurally privileged everywhere else in the architecture (feedback ×2/×3, rule approval, override authority). The attention queue should mirror that: guardian turns go to the **front** of the queue. Two-graph normal users are served in arrival order.

**Critical constraint:** priority preempts the *next selection*, never the *in-flight turn*. You do not yank attention out of a thought mid-cycle — that would corrupt the running cognitive cycle and produce incoherent output. The current turn always completes; the guardian's turn is simply chosen next. (This also keeps the `tickInFlight` guard's invariant intact.)

### F.2 Observer visibility → **own-thread only, with an explicit guardian/observer role**

Normal users see **only their own thread** — their turns and Sylphie's replies to them. They never see other users' messages or answers. This is the privacy default and it matches the OKG per-person isolation philosophy.

A distinct **observer role** (the guardian, or a dashboard "presence" view) may subscribe to the full melded stream — everyone's turns and every reply — so Jim can watch one coherent mind handle the room. This is a deliberate, role-gated subscription, **not** a property every socket inherits. Concretely: the full stream is a separate channel an observer opts into, not the default broadcast.

### F.3 Drive state → **single shared affect across all interlocutors (embraced)**

One being, one mood. A tense exchange with User A genuinely colors how Sylphie feels when she turns to User B — exactly as a person's would. This is not really a fork; it falls out of there being one drive engine process and one `:CoBeing`. Per-conversation affect would be N personalities and would contradict the entire premise. **Decision: keep it, and treat the cross-interlocutor mood bleed as a feature, not a leak.**

One consequence to monitor, not to design away: a single hostile interlocutor can push Sylphie's affect toward a pathological attractor (depressive/anxious) that then colors everyone. The mitigations already exist in the architecture — guardian override, behavioral contingencies, and the attractor-state detectors in decision-making. **Action item:** ensure the attractor monitors treat "one abusive interlocutor degrading global affect" as an alertable pattern, and that the guardian-priority lane (F.1) is the intended circuit-breaker (guardian can step in and reinforce/correct).

### F.4 Cross-talk in memory → **the three-graph boundary is the privacy contract**

- Facts **about** a person (target = speaker) live in **that person's OKG** and are **not** used when answering anyone else. If User A says "I'm afraid of dogs," that's an OKG-A fact; Sylphie does not surface it to User B.
- **World-facts** a person teaches her (target = world) enter the shared **WKG** and **are** fair game for everyone. If User A teaches her "the Eiffel Tower is in Paris," she can of course use that with User B.

This already falls out of the three-graph design and the existing fast-fact-extraction routing (`target=speaker` → OKG, world-facts → WKG). The decision is to **treat that routing as the load-bearing social-privacy boundary** and hold the line on it: the discipline that matters is *what gets written where* at extraction time. Audit the extraction path to confirm nothing speaker-personal leaks into the WKG.

---

## Summary

Today: one mind, one global input slot (races), one global "active person" (thrashes), one outbound broadcast (everyone sees everything), and an answer that doesn't know who asked it. The fix is **not** to split Sylphie per user — that would betray the single-being premise. It is to give the one mind a **queue** (meld all questions, attend one at a time) and **threaded identity** (so each answer goes home to the person who asked, attributed to them in memory). The serial-attention primitive already exists (`tickInFlight`); the speaker-identity plumbing is already on the roadmap (text-attribution). This work sits at the intersection of both — and turns "a shared chat room" into "a being who is present with many people."
