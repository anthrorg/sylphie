# Epic 6: Communication Subsystem — Cognitive Science Analysis

**Status:** Completed analysis package
**Audience:** Project leadership, Epic 6 architects, future developers
**Key outputs:** Developmental psychology framework + implementation guidance

---

## What Is This?

This analysis folder contains a comprehensive developmental psychology examination of how Sylphie's **Communication subsystem** matures over time. Rather than specifying implementation details, it maps developmental trajectories (from LLM-dependent to graph-grounded) to cognitive science principles (Piaget, Vygotsky, ACT-R).

The analysis answers:

1. **How does communication develop?** From LLM scaffolding → autonomous person-modeling → Type 1 reflexes
2. **What does person modeling look like?** Theory of mind progression from egocentrism to sophisticated mental state inference
3. **How do input parsing schemas graduate?** Through confirmation cycles shaped by Guardian feedback
4. **What are the risks?** False models, egocentrism lock-in, repair failure cascades, hallucination
5. **How do we measure it?** Type 1/Type 2 ratio, Guardian confirmation rate, prediction accuracy, person model quality

---

## The Two-Document Architecture

### Document 1: `epic-6-developmental-analysis.md`

**Purpose:** Cognitive science theory applied to Sylphie's communication development

**Contents:**
- Part 1: Communication as developmental trajectory (3 stages: LLM dominance → scaffolding → autonomy)
- Part 2: Person modeling as theory of mind (Piagetian perspective-taking progression)
- Part 3: Input parsing as schema development (LLM → Type 1 graduation)
- Part 4: Guardian scaffolding design (Zone of Proximal Development, productive feedback structures)
- Part 5: ZPD mapping (what's too easy, too hard, just right at each stage)
- Part 6: Assimilation vs. accommodation (when does the system restructure vs. extend its models?)
- Part 7: Developmental risks (5 pathologies: LLM addiction, hallucinated models, egocentrism lock-in, repair failure, contradiction tolerance)
- Part 8: Measurement framework (10 primary + secondary metrics)
- Part 9-10: Open questions and synthesis

**Read this if:** You need to understand the *why* — the developmental psychology principles that should guide Epic 6's design.

---

### Document 2: `epic-6-implementation-guidance.md`

**Purpose:** How to translate theory into code patterns, data structures, and architectural decisions

**Contents:**
- Part 1: Core architecture pattern (tiered communication: Type 2 LLM path + Type 1 Type 1 path)
- Part 2: Data structures (person model edges, parsing schemas, confidence dynamics)
- Part 3: Response generation pipeline (staged selection: Type 1 first, fall back to Type 2)
- Part 4: Person model development cycle (Guardian feedback processing, contradiction detection)
- Part 5: Input parsing schema graduation (confidence calculation, repair strategy learning)
- Part 6: Monitoring and instrumentation (health dashboard, early warning system)
- Part 7: Critical implementation constraints (provenance immutability, Theater gating, confidence ceiling checks)
- Part 8: Integration points with other subsystems (DM, Learning, Drive Engine, Planning)

**Read this if:** You're an architect or implementer and need to translate the developmental principles into Type definitions, interface patterns, and architectural boundaries.

---

## Key Insights Summary

### 1. The LLM Is Temporary Scaffolding

Sylphie is fluent from session 1. This is *not* development — it's scaffolding. Real development is:
- Type 1 / Type 2 ratio shifting from 5% to 70%
- Person models becoming Guardian-grounded, not LLM-generated
- Parsing confidence increasing; latency decreasing
- Prediction accuracy on Jim's responses rising above 0.80

### 2. Person Modeling Is Theory of Mind Development

Sylphie's models of Jim evolve through predictable stages:
- **Egocentric:** Jim is a template; his preferences are like Sylphie's
- **Perspective-recognizing:** Jim has distinct preferences, communication style, expertise
- **Theory of mind:** Jim's drive state, temporal patterns, conditional preferences are modeled; Sylphie predicts Jim's mental states

Guardian feedback shapes this progression. Schema-level feedback accelerates development; instance-level feedback is necessary but insufficient.

### 3. Confidence Dynamics Drive Autonomy

The ACT-R formula operationalizes the theory:
```
confidence = base + 0.12 * ln(count) - d * ln(hours + 1)
```

Type 1 graduation happens when:
- Confidence > 0.80
- AND prediction MAE < 0.10 over 10 uses
- AND provenance is Guardian or Inference (not pure LLM)

This creates natural evolutionary pressure: LLM-generated responses start at 0.35 confidence and can only exceed 0.60 with Guardian confirmation. This prevents hallucination lock-in.

### 4. Theater Prohibition Keeps Development Honest

Sylphie cannot perform emotions she doesn't have. If her Communication system generates sadness while her Sadness drive is 0.2, that response is rejected or rewritten.

This prevents: fake emotional scaffolding, egocentrism (projecting her own state onto Jim), and superstitious learning (learning to optimize expression rather than understanding).

### 5. Development Is Visible and Measurable

By tracking Type 1 ratio, person model Guardian-confirmation rate, prediction accuracy, repair success rate, and hallucination rate, you can see real development. If these metrics are flat after 30 sessions, the system isn't learning — it's delegating.

The Lesion Test (remove LLM, see what Sylphie can do alone) provides ground truth.

---

## How to Use This Analysis

### For Project Leadership

Read **Part 1** of the developmental analysis ("Communication as Developmental Trajectory"). This establishes what success looks like: a Sylphie that graduates from LLM scaffolding to autonomous communication over 50+ sessions.

### For Epic 6 Architects

1. Read the developmental analysis in full
2. Read the implementation guidance to understand how theory maps to code
3. Use the data structures and confidence dynamics formulas as the foundation for the Communication module interface design
4. Implement the monitoring framework early; measure constantly

### For Future Developers Maintaining Communication

If Communication development stalls (Type 1 ratio flat, person models hallucinating, repairs failing):

1. Check the red flags in the monitoring framework (Part 8 of analysis)
2. Review the attractor states (Part 7 of analysis) — which pathology are you in?
3. Consult the implementation guidance (Part 7: Critical Constraints) to verify you're enforcing provenance immutability, Theater gating, and confidence ceilings
4. Escalate to project leadership if the system is in an attractor state; it requires intervention

---

## Alignment with CANON

This analysis is grounded in the CANON and operationalizes key principles:

| CANON Principle | How Communication Implements It |
|-----------------|--------------------------------|
| "The LLM is her voice, not her mind" | Person models and graph-based responses increasingly replace LLM generation; LLM becomes Type 2 fallback |
| "Dual-process cognition" | Type 1 parsing/response retrieval vs. Type 2 LLM deliberation; graduated via confidence |
| "Experience shapes knowledge" | Guardian feedback drives person model confidence; each interaction refines the graph |
| "Prediction drives learning" | Parsing predictions (what does this input mean?) validated by Guardian response; response predictions (will Jim accept this?) tracked for MAE |
| "Provenance is sacred" | Every person model edge, parsing schema, and response carries provenance; enables Lesion Test |
| "Theater Prohibition" | Responses must correlate with actual drive state; gating enforced before execution |
| "Guardian Asymmetry" | Confirmations weight 2x, corrections weight 3x; Guardian feedback outweighs algorithmic signals |

---

## Next Steps for Implementation

1. **Architecture Review:** Implement the tiered communication pattern (Type 2 LLM → Type 1 Type 1 fallback) as specified in implementation-guidance.md
2. **Data Model:** Define person model edges, parsing schemas, confidence calculations in your WKG/Grafeo schema
3. **Monitoring:** Stand up the communication health dashboard early; track metrics from session 1
4. **Guardian Interface:** Design input that encourages schema-level feedback, not just instance-level corrections
5. **Lesion Testing:** Plan bi-weekly runs without LLM; measure what Sylphie can do alone

---

## References for Further Reading

### Cognitive Development
- Piaget, J. (1954). *The Construction of Reality in the Child*
- Vygotsky, L. S. (1978). *Mind in Society*
- Tomasello, M. (2003). *Constructing a Language* (usage-based language acquisition)

### Theory of Mind
- Baron-Cohen, S. (1995). *Mindblindness: An Essay on Autism and Theory of Mind*
- Gopnik, A., & Wellman, H. M. (1992). "Why the Child's Theory of Mind Really Is a Theory" (developmental perspective-taking)

### Learning & Feedback
- Hattie, J., & Timperley, H. (2007). "The Power of Feedback" (what makes feedback effective)
- Dweck, C. S. (2006). *Mindset* (growth vs. fixed mindset, productive struggle)

### Cognitive Modeling
- Anderson, J. R. (2007). *How Can the Human Mind Occur in the Physical Universe?* (ACT-R: confidence dynamics, skill compilation)

### Language Development
- Slobin, D. I. (Ed.). (1985). *The Crosslinguistic Study of Language Acquisition* (comparative language development)

---

**Created by:** Piaget, Cognitive Development Specialist
**Date:** March 29, 2026
**Status:** Ready for architect review and implementation planning

This analysis does not contain code. It provides the conceptual and theoretical foundation for Epic 6 implementation. Implementation teams should read both documents carefully before designing the Communication subsystem architecture.
