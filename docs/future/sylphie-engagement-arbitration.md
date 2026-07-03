# Future feature: Drive-arbitrated engagement + the embodied digital environment

Captured 2026-07-02 from a design conversation with Jim. NOT planned work — this is the
someday-shape, recorded so the near-term tickets don't paint over it. Near-term policy
(Jim-ruled same day): wake-class autonomous work is **unconditionally interruptible** by a
user; see the activity-taxonomy directive in the pipeline.

## Part 1 — Engagement as an arbitration outcome (the "hold on, one sec" mechanism)

Jim's framing: Sylphie shouldn't be a chatbot whose attention is owned by whoever speaks.
If she's mid-task and her social pressure is low, she should be able to acknowledge a
person and finish what she's doing — not because a "hold on" is scripted, but because
deferral is an action she can select when it makes sense.

Design shape settled in conversation (assessment level, not yet designed):

- **Engagement is an arbitration outcome, not a pipeline reflex.** A person arriving or
  speaking enters the normal cognitive cycle and competes with the current activity.
  Candidates: ENGAGE_NOW (full attention shift) / ACKNOWLEDGE_AND_DEFER (cheap orienting
  response + commitment to return) / CONTINUE (silent, only for passive presence — a
  direct address always produces at least the acknowledgment).
- **ActivityContext is the missing piece:** a first-class representation of "what am I
  engaged in, which drive motivates it, how near completion, what does interrupting cost."
  Without it there is nothing on the other side of the scale from social pressure.
- **Deferral creates a mounting obligation.** "Hold on" must not relieve social pressure —
  it opens a pending obligation whose pressure ramps while someone waits (being addressed
  again spikes it; guardian asymmetry ×2/×3 applies), while the current activity's pull
  decays as it completes. The curves crossing is the un-scripted moment she turns around.
  Skinner risk to design against: if deferral itself relieves pressure, it becomes learned
  avoidance. The `[unanswered]` message tagging in ConversationHistoryService is the
  natural substrate for the pending obligation.
- **Theater Prohibition is the honesty guarantee:** she may only say "just finishing
  something up" if a real activity exists in the ActivityContext; a defer-intent emission
  with no genuine in-flight activity is theater and gets extinguished.
- **CANON/drive isolation:** decision-making reads the published DriveSnapshot; events
  (person-arrived, engagement-deferred, obligation-fulfilled) are PUSHED to the drive
  engine. Never a pull path.
- Existing machinery it composes with: TurnFloorGate (TK-99), emissionIntent enum
  (add defer/acknowledge intents beside DELIBERATE_GREET), per-cycle drive snapshots,
  social-comment-quality contingency. `initiateConnectionGreet`'s executor bypass
  (communication.service.ts) becomes just another arbitration with a strong prior when
  idle.
- Prerequisite: she needs real work to be busy with — the consolidation loop (sleep-class)
  and theory/research loop (wake-class) land first.

## Part 2 — The embodied digital environment ("goes to the study")

Jim, verbatim intent: "We can give her a live digital environment where, when she
researches a topic she is unfamiliar with, she has to go to the study and sit at the
computer and do her research there. This is a massive new feature though."

The idea: autonomous activities gain physical/spatial embodiment in a digital home —
activities happen at places, take observable time, and are visible (you can *see* she's
at the desk researching, which also makes "she's busy" legible to the user without a
status readout). This turns the ActivityContext from an internal struct into an
observable scene, and makes interruption/deferral physically intuitive.

Explicitly out of scope for now. When picked up, it presupposes Part 1 (engagement
arbitration) and the wake-class activity loops; it is primarily a frontend/world-model
feature layered over them.
