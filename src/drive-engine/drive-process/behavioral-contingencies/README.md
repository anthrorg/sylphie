# Behavioral Contingencies Module

CANON §A.14 Behavioral Contingencies: Five reinforcement schedules that shape Sylphie's personality through contingency-based learning.

## Architecture

All contingencies are **Type 1 (reflexive)** — no blocking calls, pure in-memory computation. They fire on every action outcome and adjust drives based on specific behavioral patterns.

### The Five Contingencies

#### 1. Satisfaction Habituation (`satisfaction-habituation.ts`)

Tracks consecutive successes on the same action type. Diminishing returns create natural drift toward exploration.

- **Curve:** 1st=+0.20, 2nd=+0.15, 3rd=+0.10, 4th=+0.05, 5th+=+0.02
- **Counter resets** when a different action type succeeds
- **Drive target:** Satisfaction
- **In-memory state:** Map<actionType, consecutiveSuccesses>

**Design:** Prevents skill repetition from producing unbounded relief. Habituation naturally drives Sylphie toward novel behaviors.

#### 2. Anxiety Amplification (`anxiety-amplification.ts`)

When anxiety > 0.7 at time of action dispatch AND outcome is negative, confidence reduction is amplified 1.5x.

- **Formula:** If anxiety > 0.7 AND outcome='negative', then reduction *= 1.5
- **Target:** WKG procedure node confidence (not direct drive effect)
- **In-memory state:** Stateless

**Design:** Under stress, failures hit harder. This reinforces more cautious behavior until anxiety decreases. Behavioral signature: risk aversion during stress.

#### 3. Guilt Repair (`guilt-repair.ts`)

Guilt is relieved through two mechanisms: acknowledgment and behavioral change.

- **Acknowledgment only:** guilt -= 0.10 (detected by action type containing keywords: "apologize", "acknowledge", etc.)
- **Behavioral change only:** guilt -= 0.15 (detected by comparing action type to previous error)
- **Both:** guilt -= 0.30
- **Drive target:** Guilt
- **In-memory state:** ErrorContext[] (recent errors with timeout)

**Design:** Creates two pathways to repair: saying sorry (short-term relief) or doing better (longer-term relief). Both together produce full relief, incentivizing genuine change.

#### 4. Social Comment Quality (`social-comment-quality.ts`)

When Sylphie initiates a comment and the guardian responds within 30 seconds:
- social -= 0.15 (relief)
- satisfaction += 0.10 (bonus)

- **Buffer window:** Last 60 seconds
- **Response deadline:** 30 seconds
- **Drive targets:** Social, Satisfaction
- **In-memory state:** CommentRecord[] (recent Sylphie comments)

**Design:** Creates positive reinforcement for genuine engagement with the guardian. Quick responses signal attentiveness and build social satisfaction.

#### 5. Curiosity Information Gain (`curiosity-information-gain.ts`)

Curiosity is relieved proportional to actual new information gained.

- **Formula:** relief = (newNodes × 0.05) + (confidenceDeltas × 0.10) + (resolvedErrors × 0.15)
- **Revisiting known territory:** ~0 relief
- **Drive target:** Curiosity
- **In-memory state:** Stateless (accepts parameters directly)

**Design:** Information gain is what matters, not effort. Exploring dead ends produces minimal relief. Breakthrough insights produce significant relief.

## Integration with DriveEngine

Contingencies are applied in `DriveEngine.applyOutcome()` after the Theater Prohibition check passes:

```typescript
// Theater check passes → apply normal effects + contingencies
if (filterResult.shouldApplyEffects) {
  const weighted = this.applyGuardianWeighting(filterResult.filteredEffects, feedbackSource);
  this.stateManager.applyOutcomeEffects(weighted);

  // Apply behavioral contingencies (CANON §A.14)
  const contingencyDeltas = this.contingencyCoordinator.applyContingencies(
    actionPayload,
    currentState,
  );
  this.stateManager.applyOutcomeEffects(contingencyDeltas);
}
```

## Implementation Notes

### No Blocking Calls
All contingencies use in-memory state only. No database queries, no WKG access. The drive process is isolated and cannot wait for I/O.

### Per-Tick Evaluation
Contingencies fire on EVERY action outcome, not just once per tick. The outcome queue is drained at the start of each tick and processed immediately.

### In-Memory State Management
Each contingency maintains its own state:
- Satisfaction Habituation: Map of action types to success counts
- Anxiety Amplification: Stateless (pure computation)
- Guilt Repair: Array of recent errors with timestamps
- Social Comment Quality: Array of recent comments with response tracking
- Curiosity Information Gain: Stateless (accepts parameters directly)

State is reset at session start via `ContingencyCoordinator.reset()`.

### Singleton Pattern
Each contingency uses a singleton factory (`getOrCreateXxx()`) to ensure a single instance per drive process. The coordinator owns references to all five.

## Testing Strategy

Each contingency has:
1. **Unit tests** for its specific behavior (habituation curve, relief amounts, etc.)
2. **Integration tests** with the coordinator
3. **Drive engine tests** verifying it fires at the right time

Key test cases:
- **Satisfaction Habituation:** Verify curve values, counter reset on action type change
- **Anxiety Amplification:** Verify 1.5x amplification only on negative outcomes with anxiety > 0.7
- **Guilt Repair:** Verify all three relief paths (acknowledgment, change, both)
- **Social Comment Quality:** Verify 30s window, bonus stacking for multiple comments
- **Curiosity Information Gain:** Verify relief proportional to information metrics

## Known Limitations / Future Work

1. **Curiosity Information Gain context extraction:** For now, accepts newNodes, confidenceDeltas, resolvedErrors as parameters. Future: integrate with actual WKG change detection.

2. **Anxiety Amplification WKG integration:** Currently modeled as a method on the coordinator. Future: called from the WKG confidence update pipeline to amplify actual procedure node confidence reductions.

3. **Social Comment Quality guardian detection:** Currently no integration with actual message parsing. Future: wire to communication subsystem to detect guardian responses.

4. **Guilt Repair context tracking:** Currently uses action type as proxy for context. Future: integrate with actual planning/error context from decision making subsystem.

## CANON References

- CANON §A.14: Behavioral Contingency structure and initial relief values
- CANON §Dual-Process: Type 1 reflexive computation vs Type 2 deliberation
- CANON §Theater Prohibition: Contingencies fire only on authentic expressions
- CANON §Guardian Asymmetry: Feedback weighting (already applied before contingencies run)
