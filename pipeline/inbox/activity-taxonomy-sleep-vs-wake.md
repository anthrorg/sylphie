# Directive: Autonomous-activity taxonomy — sleep-class maintenance vs wake-class interruptible work

From Jim, 2026-07-02. A planning CONSTRAINT on pipeline items **20260702-011**
(consolidation loop — idle replay and insight synthesis) and **20260702-018** (theory
loop — curiosity-driven acquisition), both currently in planning. This should shape their
plans, not clone them.

## The ruling

Sylphie's autonomous activities divide into two classes, and the two planned idle loops
land on opposite sides:

1. **Sleep-class (maintenance window):** things a human brain does while asleep —
   consolidation, episodic replay, insight synthesis, EWC anchoring, pressure-driven
   maintenance cycles. These run during maintenance/off time. Item **011 belongs here**.

2. **Wake-class (interruptible):** things an awake human does as focused work — active
   research (item **018**'s `research` action), future self-directed activities. These
   run in her normal awake-idle time, must NOT run inside sleep-class maintenance
   windows, and — **for now** — are always interruptible: a user arriving or speaking
   preempts them unconditionally. Item 018's existing "no interaction is active" gate is
   correct and stays; this directive adds the other edge: "and not during maintenance."

Verbatim from Jim: "Make sure some actions like active research isn't done when inactive
during maintenance. Only stuff that would generally happen while a human sleeps happens
during maintenance. The rest is stuff we can interrupt her for, for now."

## What this means for the two feature plans

- Each autonomous action/cycle gets an explicit activity class (sleep-class vs
  wake-class) — a small enum/tag on the action or trigger, not a new subsystem.
- The trigger conditions become: sleep-class ⇒ requires maintenance window; wake-class ⇒
  requires awake-idle (no interaction active AND not in a maintenance window).
- "For now" is load-bearing: unconditional interruptibility of wake-class work is the
  current policy, deliberately simple. A future feature (drive-arbitrated engagement:
  ActivityContext, acknowledge-and-defer as an action, mounting social-pressure
  obligation — see docs/future/sylphie-engagement-arbitration.md) will replace the
  unconditional preemption with arbitration. Nothing in 011/018 should hard-code
  assumptions that make that future gate-swap invasive — keep the interrupt decision in
  one place.

## Acceptance criteria (sketch)

- Given a maintenance window is active, when Curiosity pressure crosses the research
  threshold, then no `research` action is selected (wake-class blocked during
  maintenance); consolidation (sleep-class) proceeds.
- Given awake-idle (no interaction, no maintenance window), the `research` action is
  eligible per item 018's own criteria.
- Given a user turn arrives mid-research, the research action is preempted/abandoned
  cleanly (current policy: user always wins) and the turn is handled normally.

## Non-goals

- The full engagement-arbitration mechanism (deferral, "hold on", ActivityContext) —
  future feature, documented separately.
- The embodied digital environment ("goes to the study to research") — massive future
  feature, captured in docs/future/.
- Any change to drive computation or maintenance-cycle internals.

## DB impact

None expected (trigger-condition logic + an activity-class tag).
