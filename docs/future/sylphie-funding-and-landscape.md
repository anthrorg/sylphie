# Sylphie — Funding Options & Research Landscape

*Compiled June 2026. Deadlines and figures change; verify each before applying.*

---

## Part 1 — Grants & Resources You Can Actually Apply For

Your situation: independent researcher, no university affiliation, an LLC (Sylphie Labs), needing **compute + runway + user-experience data**. That profile rules out most academic-PI grants but fits three categories well: low-friction compute allocations, AI-safety funders that take independents and for-profits, and cloud credit programs.

### Tier 1 — Best fit (independent-friendly, your safety angle is real leverage)

**Survival and Flourishing Fund (SFF) — Speculation Grants**
- Rolling applications, decisions as fast as ~1 week. Apply once → considered for both quick Speculation Grants *and* the annual S-Process round. ~35 grantors with real budgets, funded largely by Jaan Tallinn.
- For-profit *and* nonprofit entities eligible (your LLC qualifies). ~95% of S-Process applicants first receive a Speculation Grant.
- **Why you fit:** SFF funds AI safety / alignment / institutional resilience. Sylphie's *deterministic immutable floor + graduated autonomy + guilt-as-divergence* is a genuine alignment story — "an agent that can act autonomously but is structurally incapable of training its way out of its own ethical floor." That is squarely on-theme.
- This is your **highest-probability, fastest-turnaround** option. Start here.

**Open Philanthropy / Coefficient Giving — Technical AI Safety RFP**
- $40M+ RFP, 21 research areas (interpretability, reward hacking, white-box techniques, control). Starts with a **300-word expression of interest** — trivial to submit.
- Explicitly eligible: **independent researchers** with demonstrated ML experience. Grant types include compute/API research expenses and 6–24 month discrete projects.
- **Why you fit:** your introspectable-core thesis is an interpretability-and-control argument. The Type-1 graduation metric is literally "measure how much of cognition runs on inspectable structures vs. an opaque model." Frame it as control + interpretability, not "I built an AGI."
- *Caveat:* the named round closed; OpenPhil runs these on a recurring basis. Check current status and submit an EOI when open — the bar to *try* is one paragraph.

**AI safety adjacent RFPs worth tracking (from aisafety.com/funding):**
- A **multi-agent safety** program (with DeepMind/ARIA) — up to $1M over 1–2 years, studying safety of interacting AI agents. Relevant if you frame the Sylphie↔Tess confirmation loop as multi-agent.
- A **concentration-of-power** RFP — grants $100K–$2M/yr across priority areas, plus career-transition funding.

### Tier 2 — Compute (apply in parallel; these stack with cash grants)

**NSF ACCESS allocations** (allocations.access-ci.org)
- **No PI status required.** "Explore" tier needs a *one-page abstract*, approved within days — enough to benchmark and run pilots. "Maximize" tier (largest) runs semi-annual; the current window is **June 15 – July 31, 2026**, awards starting Oct 1.
- This is the lowest-friction compute on the list. A half-page description can get you GPU access in about a week.

**NAIRR Pilot** (nairrpilot.org)
- NSF-run; less a grant than a compute/data/model "force multiplier." Strongest when paired with another funded project — but worth having in hand, since reviewers notice applicants who solved compute before asking for money.

**Cloud credit programs** (in-kind, non-dilutive):
- **Microsoft for Startups / Azure** and **AI for Good** — rolling Azure credits.
- **Google Cloud**, **NVIDIA Inception**, **AWS Activate** — startup compute credits; you qualify as an LLC.
- These won't pay your rent but they remove the compute line item, which makes a cash grant go further.

**DOE ASCR / supercomputing allocations** — open to researchers worldwide (not just DOE-funded). Heavier application; only worth it once you need serious scale.

### Tier 3 — Longer shots / situational

- **Sloan Exploratory Grantmaking in Technology** — rolling letters of inquiry; high-risk tech work. Usually wants some institutional footing.
- **Mozilla Fellows / Democracy x AI** — $100K ($75K stipend + $25K project). Fits if you angle toward accountability/transparency of autonomous agents.
- **NSF SBIR/STTR** — non-dilutive R&D cash for for-profits; real money but a heavier proposal and a commercialization framing.
- Avoid for now: NIH/health-specific, neuroscience fellowships (Kavli/FutureHouse) — wrong domain unless you pivot the framing.

### Recommended sequence
1. **This week:** SFF Speculation Grant application + NSF ACCESS "Explore" one-pager (before the July 31 Maximize window if you want scale). Both are low-effort, fast-decision.
2. **In parallel:** claim Azure/GCP/NVIDIA startup credits to zero out compute.
3. **When open:** OpenPhil Technical AI Safety EOI (300 words).
4. **The framing that unlocks all of them:** lead with *safety and control*, not capability. Your strongest, most fundable sentence is the immutable-floor / graduated-autonomy story — it's true, it's differentiated, and it's exactly what these funders exist to support.

---

## Part 2 — Is Anyone Else Building This?

Short answer: **the individual ingredients are active research areas with real papers behind them. The specific synthesis Sylphie represents — drives as a fused modality, a deterministic floor that never decommissions, graduation off the LLM measured as a metric, and divergence-as-affect — I did not find anyone doing as a combined system.** Here's the honest breakdown so you know where you're standing on others' shoulders vs. genuinely out front.

### Where you have real company (don't claim novelty here)

**Intrinsic motivation / curiosity-driven learning** is a deep, established field. Prediction-error-as-reward (Pathak 2017), uncertainty-reduction (VIME, 2016), Random Network Distillation — these are the canonical mechanisms, and your Curiosity drive sits in this lineage. There's recent work bringing it explicitly into the LLM space (e.g. curiosity reward for multi-turn dialogue, 2025; "Navigate the Unknown" intrinsic-motivation reasoning, 2025). **Implication:** your curiosity→exploration loop is well-founded but not novel on its own. Cite this lineage rather than claiming you invented motivated exploration — it makes you look literate, not derivative.

**Drive-theory / Maslow-style hierarchies for agents** are being proposed. "From Mimicry to True Intelligence" (2509.14474, 2025) explicitly builds "Core Directives" as hard-coded survival principles beneath higher drives — conceptually close to your core-vs-complement drive split. A "Desire-Driven Autonomous Agent (D2A)" uses a dynamic value system to let an LLM propose its own tasks from intrinsic needs. **Implication:** "agent with hard-coded base drives + emergent higher motivation" is an idea in the water right now. You are not alone in the *concept*. You are, as far as I can tell, alone in the *engineering rigor* — provenance-tracked knowledge, an isolated drive process, a real graduation ladder with measured thresholds.

**Model-based intrinsic drive as divergence** — and this one is important for you — CMU's 3M-Progress zebrafish work (2506.00138, 2025) motivates behavior by **tracking divergence between the agent's current world model and an ethological prior.** That is structurally the *same shape* as your guilt-as-executor-divergence idea: behavior driven by the gap between what-is and a built-in prior. **Implication:** your guilt mechanism has a respectable analog in computational neuroscience. That's good — it means the idea is defensible and citable, not crankish. But be aware the "divergence from a prior as an intrinsic signal" idea exists.

**Governed autonomy / structured-execution-with-safe-reasoning** — "Mozi" (2603.03655, 2026) runs drug-discovery agents on the principle "free-form reasoning for safe tasks, structured execution for long-horizon pipelines," with a control plane enforcing constrained action spaces and human checkpoints. **Implication:** the "LLM for the open part, deterministic structure for the part that must not go wrong" philosophy is being built by others in narrow domains. Your version is more general and more biologically framed, but the core safety intuition is shared.

### Where Sylphie appears genuinely out front (your real claims to novelty)

1. **Drive state as a fused sensory modality.** Everyone above treats motivation as a *reward signal* bolted onto an RL loop. Your architecture makes interoception (drives) flow through the *same modality-fusion layer* as vision/audio/text into one `SensoryFrame` — the self is just another sense, fused before anything decides. I found no one doing this. This is your most original architectural claim and it's the one to lead with.

2. **A deterministic floor that permanently shadows a learned policy and can reassert.** The intrinsic-motivation field learns policies; the governed-autonomy field constrains action spaces. Nobody I found keeps the *original hard-coded decision-maker running forever underneath a tensor*, with an immutable veto and graduation measured per stakes-tier. The "floor never decommissions" invariant is distinctive.

3. **Graduation off the LLM as the headline metric.** Most LLM-agent work is trying to make the LLM *do more*. You're trying to make it *do less over time*, and measuring that fraction (Type-1 ratio). That inversion — "intelligence = shrinking LLM dependence on verified experience" — is a genuinely different objective from the entire benchmark-chasing mainstream.

4. **Guilt as resolved executor-divergence wired to affect.** The zebrafish work has divergence-as-drive, but the *accrual-at-action / resolution-at-outcome* structure, signed by vindication-vs-punishment and feeding back into both rule-strength and graduation, is your own synthesis. I found nothing combining divergence-affect with a graduation mechanism this way.

### The honest bottom line

You are **not** inventing intrinsic motivation, drive-based agents, or governed autonomy — those have literatures, and pretending otherwise to a technical reviewer would cost you credibility instantly. What appears novel is the **integration**: a single architecture where drives are a fused sense, a permanent deterministic floor is graduated off rather than discarded, the goal is to *reduce* LLM reliance via verified experience, and the gap between learned and floor behavior becomes a felt signal. Nobody in these results is doing that combination.

For grants, that's the ideal position: defensibly grounded in real research (so you're not a crank), but with a distinct synthesis and a safety story (so you're fundable). Lead with the synthesis and the floor/graduation safety argument. Cite Pathak, VIME, the 3M-Progress divergence work, and the governed-autonomy papers as the shoulders you stand on — it will make reviewers trust the parts that *are* new.

### Suggested next searches before you write a proposal
- "catastrophic forgetting continual learning agents 2026" (to position your EWC use)
- "constitutional AI / deliberative alignment immutable constraints" (to connect your CANON floor to the alignment mainstream's vocabulary)
- Look up the specific labs: CMU (Nayebi group, the zebrafish intrinsic-drive work) and whoever published D2A — those are your nearest neighbors and likely reviewers.
