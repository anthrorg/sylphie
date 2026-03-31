# Do Epic

Execute a planned epic's tickets with agent delegation, verification, and quality review.

## Usage

```
/do-epic <N>
/do-epic 1          # Execute Epic 1
/do-epic 1 --resume # Resume from where we left off
```

## When to Use

- After an epic has been planned via `/plan-epic` and approved by Jim
- To resume an in-progress epic

## Prerequisites

1. Epic has been planned via `/plan-epic`
2. `docs/epics/<N>/tickets.yml` exists
3. Jim has approved the plan

---

## Workflow

### Phase 1: LOAD & VERIFY

1. Read `docs/epics/<N>/tickets.yml`, build dependency graph
2. Check `docs/epics/<N>/queue.yaml` for prior progress (resume support)
3. Verify dependencies for first batch of tickets

### Phase 2: TASK QUEUE

1. Order tickets by dependency chain
2. Create/update `queue.yaml` for progress tracking
3. Identify parallelizable tickets (max 3 concurrent)

### Phase 3: FOR EACH TICKET

```
┌─ SELECT AGENT → Pick assigned agent, set model tier
├─ WARN AGENT   → Deliver ZERO TOLERANCE warning
├─ PRE-FLIGHT   → Agent verifies dependencies, criteria achievable
├─ DELEGATE     → Agent implements via /implement-ticket
├─ VERIFY       → Type-check, Playwright verification
├─ SELF-VERIFY  → Agent checks each acceptance criterion
├─ STUB SCAN    → Check for stubs/hollow code
├─ PEER REVIEW  → If multi-domain, affected agent reviews
└─ MARK DONE    → Only after all verification passes
```

### Phase 4: EPIC COMPLETE

1. Final integration check
2. Run `/session-wrap`
3. Report to Jim

---

## Progress Tracking (queue.yaml)

```yaml
epic: 1
started: 2026-03-28T00:00:00Z
tickets:
  - id: T001
    status: complete
    agent: atlas
    completed_at: 2026-03-28T01:00:00Z
  - id: T002
    status: in_progress
    agent: vox
  - id: T003
    status: pending
    blocked_by: [T001]
```

---

## ZERO TOLERANCE: No Stubs, No Fake Work

Every function must contain real, working logic. No `throw new Error('not implemented')`, no placeholder returns. If you cannot fully implement something, report `BLOCKED` or `ESCALATE`. Never deliver hollow code that looks complete but does nothing.

---

## Key Rules

- Queue is persistent and resumable
- No ticket marked done until acceptance criteria verified
- Max 3 retries per ticket, then ask Jim
- Every session ends with `/session-wrap`
- Agents run on sonnet for implementation
