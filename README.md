<div align="center">

# Sylphie

### An attempt to build a mind that needs the model less every day.

*A cognitive architecture where the language model lives at the edges — and the thinking in the middle runs on structures you can actually inspect.*

[Website](https://author.sylphie.live) · [Discord](https://discord.gg/REPLACE_ME) · [Sylphie Labs](https://author.sylphie.live) · [Case Study](https://author.sylphie.live/cutting-edge-tech/sylphie)

</div>

---

## The bet

Most AI agents are a language model in a trench coat. Every decision, every step, every thought — routed back through the same opaque model, forever. It works, but you can't see inside it, it drifts over long runs, and it never gets cheaper.

Sylphie is built on the opposite bet: **keep the language model at the edges.** It parses what comes in and renders what goes out. Everything in between — motivation, memory, decision-making, learning — runs on deterministic, introspectable structures. The headline question isn't "how smart is the model," it's *how much of her thinking happens without calling it at all* — and whether that fraction can **grow** as she accumulates verified experience.

That's the whole thesis: **intelligence as shrinking dependence on the model, earned through experience, bounded by a floor she can't rewrite.**

## What makes her different

🧠 **Drives, not prompts.** Sylphie has a 12-dimensional drive substrate — curiosity, boredom, satisfaction, and more — that builds pressure on its own clock, independent of any user. She doesn't wait to be useful; she *wants*. The drives are the only reward signal in the system.

👁️ **The self is just another sense.** Every input — vision, audio, text, *and her own drive state* — flows through a single modality-fusion layer into one unified frame before anything decides. Interoception and exteroception, fused. As far as we know, nobody else builds it this way.

⚖️ **A floor she can't train away.** A hardcoded, deterministic decision-maker sits permanently underneath everything she learns. As a learned model graduates onto more of her decisions, the original floor never leaves — it shadows her, and reasserts if she ever reaches for something it would never do. Her *personality* becomes learned; her *ethics* stay built-in.

🔬 **Knowledge with a paper trail.** Every fact she holds carries provenance and a confidence that decays over time and climbs only when re-confirmed. She knows the difference between "I saw this," "I was told this," and "I read this somewhere" — and she's built to notice when she's becoming confidently wrong.

🩺 **A mind that watches itself.** Five self-pathology detectors run continuously — watching for over-reliance on the model, hallucinated knowledge, runaway planning, and depressive loops — and surface what they find.

## How she thinks

Each cycle runs a dual-process loop. A fast path (**Type 1**) fires when she's confident and has been reliably right — deterministic, no model call. A slow path (**Type 2**) deliberates: an inner monologue, competing candidate actions, an adversarial debate, an arbiter. When nothing qualifies, she does the honest thing and shrugs — *"I don't know"* is a first-class outcome, not a failure.

A decision graduates from slow to fast only after it clears a confidence bar **and** a low prediction-error bar across a rolling window. Get worse, and it's demoted back. She earns her own reflexes.

## Architecture at a glance

```
   Language model  ──  edge: parses input, renders output, handles the genuinely novel
        │
   Modality fusion ──  vision · audio · text · DRIVE STATE → one unified frame
        │
   Dual-process    ──  Type 1 (fast, deterministic) / Type 2 (deliberate) / Shrug
   cognition           graduates off the model as confidence is earned
        │
   Drive engine    ──  isolated process · 12 drives · the only reward signal
        │
   Knowledge       ──  four Neo4j graphs (world · self · others · codebase)
                       provenance-tracked, confidence-decaying
```

Under the hood: a NestJS core, an isolated Node drive engine over a validated WebSocket, a Python/TensorFlow cognition sidecar, a layered perception stack, four Neo4j knowledge graphs, a TimescaleDB event spine that records everything she does, and Postgres for drive state. ~16 services, orchestrated with Docker Compose.

## Honest status

Sylphie is in **active development**, and we'd rather tell you what's real than oversell it. A full-repo audit on **2026-07-02** (see [`docs/audits/repo-bug-audit-2026-07-02.md`](./docs/audits/repo-bug-audit-2026-07-02.md), [`sylphie-feature-inventory.md`](./sylphie-feature-inventory.md), and [`sylphie-stub-inventory.md`](./sylphie-stub-inventory.md)) found the core cognitive loop genuinely working but several subsystems either broken at a contract boundary or presenting theater — so this section is deliberately conservative.

**Real today:** the drive-dynamics core, the dual-process loop and graduation mechanism, the four knowledge graphs with provenance (candidate staging, guardian promotion, retrieval-aware decay), the modality-fusion layer, the event-sourced spine, and graceful degradation when the model is removed.

**Known broken or theater as of 2026-07-02 (being fixed):** the Python cognition sidecar's tensor path is dead at a flat-vs-nested request-shape mismatch (every `/cognition/cycle` 422s), so the learned model does not currently influence decisions at all; the drive-server WebSocket client has no working reconnect; RLS drive-isolation is not enforced at runtime; several destructive endpoints are unauthenticated; and a handful of graph-write and self-monitoring paths log success while doing nothing. These are enumerated, with file:line, in the audit docs above.

**In progress:** graduating the learned cognition model onto real decisions (blocked first on the sidecar contract fix). Some intervention endpoints and pruning paths remain honest stubs, labeled as such in the code.

If a claim here matters to you, clone it and check — the whole point of this architecture is that you *can*. We did, and wrote down what we found.

## Quick start

> Requires Docker and Node (Yarn workspaces). The stack runs as ~16 coordinated services.

```bash
git clone https://github.com/anthrorg/sylphie.git
cd sylphie
docker compose up        # brings up the graphs, drive engine, sidecars, and core
```

See [`sylphie-tech-spec.md`](./sylphie-tech-spec.md) for the full architecture and [`ROADMAP.md`](./ROADMAP.md) for where she's headed.

## From Sylphie Labs

Sylphie is one of three connected projects:

- **Sylphie** — *(this repo)* the cognitive architecture and proof-of-concept.
- **Tess** — an outer-loop agent that earns knowledge through a hypothesize → experiment → adversarial-test → validate cycle, with execution-backed oracles and Beta-distribution promotion gates. The verifier behind Sylphie's knowledge.
- **cog-worx** — the framework that takes the proven pieces of both and makes them reusable, so you don't have to build a mind from scratch.

Published packages: [`@sylphie-labs/memory-pkg`](https://www.npmjs.com/package/@sylphie-labs/memory-pkg) · [`@sylphie-labs/codebase-pkg`](https://www.npmjs.com/package/@sylphie-labs/codebase-pkg)

## Community

She's about to meet people for the first time. Come watch her grow, kick the tires, or argue about the architecture:

💬 **[Join the Discord](https://discord.gg/REPLACE_ME)** · 🌐 **[author.sylphie.live](https://author.sylphie.live)**

---

<div align="center">

*Built differently, on purpose.*

**Sylphie Labs**

</div>
