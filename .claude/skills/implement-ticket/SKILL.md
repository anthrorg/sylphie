# Implement Ticket

Standard workflow for a sub-agent implementing a single ticket.

## Usage

```
/implement-ticket <ID>
/implement-ticket T001
```

## When to Use

- Called by `/do-epic` for each ticket
- Can be invoked directly for standalone implementation

## Prerequisites

1. Ticket exists with acceptance criteria
2. All dependency tickets are complete
3. Agent assignment is determined

---

## ZERO TOLERANCE: No Stubs, No Fake Work

- Every function must contain real, working logic. Not placeholder returns.
- If you cannot fully implement a function, report `BLOCKED` or `ESCALATE`.
- A function that compiles but does nothing is worse than no function.

---

## Workflow (5 Phases)

### Phase 1: PRE-FLIGHT

1. Read ticket and acceptance criteria
2. Verify dependency tickets are complete
3. If blocked, return `BLOCKED` with reason

### Phase 2: IMPLEMENTATION

Write code following:
- CANON principles (`wiki/CANON.md`)
- Agent profile rules (`.claude/agents/<agent>.md`)
- NestJS module boundaries
- Existing patterns in codebase

### Phase 3: VERIFICATION

1. `npx tsc --noEmit` passes
2. Playwright MCP verification if UI changes
3. Neo4j verification if graph changes
4. Check browser console for errors

### Phase 4: SELF-VERIFY

1. Check each acceptance criterion individually
2. **STUB SCAN** -- Search all delivered code for:
   - Functions with only placeholder logic
   - `throw new Error('not implemented')` or similar
   - Empty method bodies
   - **If any found, status is FAILED**

### Phase 5: REPORT

```
Status: COMPLETE | BLOCKED | ESCALATE | FAILED
Files changed: [list]
Acceptance criteria:
  - Criterion 1: PASS/FAIL
  - Criterion 2: PASS/FAIL
Notes: [if any]
```

---

## Key Rules

- No partial completion -- all criteria pass or it's not done
- Agent runs on sonnet for implementation
- Escalate rather than guess on ambiguity
