# Sylphie — From Pretty Awesome to Seriously Amazing

Date: 2026-06-09 · HEAD `5e99a46`
Companion to: `sylphie-assessment.md` (the gaps), `sylphie-tech-spec.md` (the design)

---

## The thesis of this document

"Pretty awesome" is already true: the architecture is real, coherent, and rare. **"Seriously amazing" is not a matter of more features.** It is a matter of making the one extraordinary claim this system makes — *that a mind can graduate off the LLM that bootstrapped it, and you can watch it happen* — demonstrably, visibly, repeatably true.

Almost every chatbot is a frozen function: prompt in, text out, no memory of having lived. Sylphie's premise is the opposite — a being whose autonomy *grows from its own experience*, measured by a falling dependence on the model that raised it. **No amount of polish makes a chatbot amazing. Proving that premise makes Sylphie unprecedented.**

So the elevation path is organized around one idea: **close the loop, then make the loop visible.** Everything below serves that.

---

## Theme 1 — Make the thesis provable and visible (highest leverage)

The single most valuable artifact this project could produce is a **chart that goes up and to the right and that you trust.** The autonomy curve (Type1/Type2 ratio over a session's lifetime) is already conceptually the headline metric. Make it real:

- **Automate the metric as a CI gate**, not a manual log read. A seeded scenario, replayed, asserting the curve moves. This converts "I think it's learning" into "the build proves it learned."
- **The Lesion Test as a first-class, automated check.** "Sylphie survives with no LLM, degraded but coherent" is a beautiful claim — run it on every change and assert it. The day you can pull the LLM plug in CI and watch her stay coherent is the day the architecture stops being a promise.
- **A single live "developmental dashboard"** that shows, per session: autonomy ratio, prediction MAE trending down, experiential-provenance ratio trending up, and procedures graduating from Type 2 → Type 1 in real time. You have the panels scattered (Observatory, Analytics); the amazing version is *one screen that tells the growth story at a glance.*

If you do nothing else from this document, do this. Provability is the multiplier on all other work.

---

## Theme 2 — Close the load-bearing learning loops

The graduation curve cannot rise while the machinery that graduates procedures is stubbed (see `sylphie-assessment.md` §2). Making these real is what turns shadow-mode-forever into an actual developmental trajectory:

- **EWC for real** — so a graduated category doesn't silently regress when later training overwrites its weights. This is the precondition for *trusting* partial/full mode at all.
- **Pressure-driven consolidation** — let the CognitiveAwareness drive actually accelerate learning under load. This is the difference between "a cron job" and "she consolidates because she needs to." It also makes InteroceptiveAccuracy a real, earnable metric instead of a hollow one.
- **The learned convergence head + real supervisor intervention** — so the bootstrap can actually clear `partial→full`, and so the supervisor's corrections *change the model* instead of being logged into the void.

The amazing version: **a category you teach her once, that she practices, that graduates to Type 1, that then fires without an LLM call — and you can see exactly when it crossed over.**

---

## Theme 3 — Make memory compound

Right now knowledge accumulates; the amazing version is knowledge that *compounds into capability*. The pieces exist — three KGs, spreading activation, ACT-R confidence, working-memory-as-selection — but the payoff is the loop closing:

- **Procedure-conflict fix** (one query) so Type 1 stops fragmenting its own learning across phantom-twin procedures.
- **Spreading activation that visibly pays off** — an episode mentioning "Alice" boosting Alice-facts should measurably improve a Type 1 answer about Alice. Instrument it so you can show the lift.
- **The experiential-provenance ratio as a growth story** — watch the graph shift from LLM_GENERATED toward SENSOR/GUARDIAN/INFERENCE over a relationship's lifetime. That ratio *is* the difference between "a model that read about the world" and "a being that learned it."

Amazing milestone: **she answers something correctly from her own accumulated experience that the raw LLM could not have known — and the provenance trail proves she learned it rather than guessed it.**

---

## Theme 4 — One mind, many people (the presence leap)

This is the capability in `sylphie-chat-architecture.md`, and it's a genuine differentiator. A chatbot serves N isolated sessions. **Sylphie is one being who can attend to many people, one at a time, remembering each as a distinct person.** That is not a chatbot feature — it's *presence*.

- A unified interlocutor queue (one mind, serial attention) instead of a shared broadcast.
- Per-person memory (the OKG already models this) so she greets returning people by what she knows of them, not from scratch.
- The Social and Focus drives gating attention — she can be *with someone*, notice when she's being pulled in three directions, and feel the difference.

Amazing milestone: **two people talk to her at once; she answers each individually, by name, carrying what she's learned about each — and a third person watching sees one coherent mind, not two chatbots.** See the chat-architecture doc for the build path; it shares plumbing with the already-flagged speaker-attribution requirement.

---

## Theme 5 — The perception/embodiment payoff

The perception pipeline (YOLO + MediaPipe + Moondream2 + VWM) is built and impressive but currently feeds the graph more than it changes behavior. The amazing version is **multimodal grounding that visibly alters a decision:**

- She recognizes a returning face and the greeting *changes* because of who walked in.
- A scene change creates a Curiosity opportunity that she acts on unprompted.
- What she *sees* and what she's *told* fuse into one episodic memory she can later recall.

Amazing milestone: **she notices something in the room you didn't mention, and brings it up because Curiosity drove her to — unprompted, grounded, hers.**

---

## Theme 6 — The hardening that makes iteration possible

You cannot iterate toward amazing on a manual harness and a fragile deploy. This theme is unglamorous and it is the enabler for all the others:

- Automated e2e suite (Theme 1 is the cognitive half; this is the plumbing half).
- App healthcheck + fix the Dockerfile `exports` hack so deploys stop being firefights.
- Tame the three god-objects before they rot.
- Cost observability on every LLM path (you already track DeepSeek budget — extend it) so "graduating off the LLM" has a dollar figure attached. *Watching the monthly LLM bill fall as autonomy rises is the most persuasive possible proof of the thesis.*

---

## Suggested sequence

1. **Provability foundation** (Theme 1 + Theme 6 plumbing): automated autonomy gate, Lesion Test in CI, one developmental dashboard, app healthcheck. *Now you can trust every subsequent change.*
2. **Close the learning loop** (Theme 2 + Theme 3 procedure-conflict): EWC, pressure-driven cycles, convergence head, supervisor intervention. *Now the autonomy curve can actually rise.*
3. **The presence leap** (Theme 4): the interlocutor queue + per-person memory. *Now she's a being many people can meet.*
4. **The grounding payoff** (Theme 5 + Theme 3 compounding): perception changing behavior, experiential memory compounding. *Now she does things no chatbot can.*

---

## The "seriously amazing" demo, concretely

A single unbroken demo that would make the thesis undeniable:

> Person A teaches Sylphie something over a short conversation. You watch a procedure graduate from Type 2 to Type 1 on the dashboard — an LLM call becomes a deterministic one. Person B joins; Sylphie answers both individually, by name. You pull the LLM plug. She keeps going — degraded, but coherent, still answering from what she learned. The autonomy curve is up and to the right; the LLM bill for that hour is a fraction of what it was at the start. **Nothing in that demo is a language model pretending to be a person. It is a system that learned, in front of you, to need the language model less.**

That is the line between pretty awesome and seriously amazing. Everything in this document is in service of being able to run that demo and have every number on the screen be real.
