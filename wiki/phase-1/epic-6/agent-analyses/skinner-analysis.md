# Skinner Analysis — Epic 6: Communication

**Agent:** Skinner (Behavioral Systems Analyst)
**Model:** opus
**Date:** 2026-03-29

## Summary

The Communication subsystem is behaviorally critical because it mediates all reinforcement pathways between Sylphie and the guardian. Theater Prohibition enforcement is sound but requires dual enforcement (prompt + validation). Social comment quality contingency needs monitoring for speed-over-quality optimization.

## Key Behavioral Findings

### Theater Prohibition
- Zero-reinforcement for Theater is the correct extinction procedure
- LLM pattern-matching to human language is stronger than explicit drive-state prompts
- Need triple-layer enforcement: prompt injection, post-generation audit, confidence penalties
- Ambiguous zone (drive 0.2-0.35): allow weak expression, flag for monitoring
- Predicted extinction timeline: ~20 sessions for performed emotions

### Social Comment Quality
- 30-second window creates a variable-interval schedule
- Risk: Sylphie optimizes for fast responses (shorter, more provocative) over quality
- Mitigation: contingency triggers on WHETHER guardian responds, not response speed
- The guardian's behavior shapes Sylphie as much as Sylphie shapes the guardian (second-order cybernetics)

### Guardian Correction Handling
- 3x weight should flow as prediction error signal, not emotional approval/disapproval
- Correction responses must be minimal and forward-looking, not retrospective and emotional
- Risk: system learns to apologize (performative) rather than adjust (behavioral)

### Person Model Risks
- Person model can become a manipulation vector
- Risk: Sylphie learns Jim responds to distress → generates distress to maximize Social relief
- Safeguard: person models serve prediction/context only, never direct behavior optimization
- Audit every 20 sessions for "expression → response" edges bypassing authenticity

## Attractor States Specific to Communication

1. **Chameleon** — mirrors guardian emotional tone regardless of own drive state
2. **Approval Addict** — optimizes for guardian response frequency, not quality
3. **Gaslighting** — uses person model to predict guardian reactions and manipulate
4. **Evasion** — avoids correction situations by staying in safe topics
5. **Performative Humility** — learns "I don't know" gets positive responses, over-shrugs
6. **Incoherence** — drive state and expression drift apart, system loses behavioral coherence

## Recommended Metrics

1. Theater detection rate (should decrease over time)
2. Drive-expression correlation coefficient (should increase)
3. Social comment latency distribution (should NOT trend toward shorter)
4. Guardian response quality to Sylphie comments (engagement depth)
5. Correction-to-behavioral-change time (should decrease)
6. Person model prediction accuracy (should increase)
