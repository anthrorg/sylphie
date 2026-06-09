# Session Wrap

End-of-session context preservation. CANON Planning Rule #5: "Context preservation at end of every session."

## Usage

```
/session-wrap
```

## When to Use

- At the end of every working session
- When Jim says "that's it for today"
- Auto-called by `/do-epic` at session end

---

## Workflow

### Phase 1: CAPTURE

Scan session activity:
- What files were changed
- What tickets were completed
- What decisions were made

### Phase 2: SUMMARIZE

Produce three-line summary:
- **DONE:** What was accomplished
- **NEXT:** The single smallest next action
- **BLOCKED:** Anything preventing progress (or "nothing")

### Phase 3: PERSIST

1. Write session log to `docs/sessions/YYYY-MM-DD-slug.md`
2. Update `queue.yaml` if tickets were progressed

---

## Output Format

```markdown
## Session: 2026-03-28

**DONE:** Implemented WKG node/edge schema, set up Neo4j connection
**NEXT:** Implement confidence dynamics for ACT-R model
**BLOCKED:** Nothing

Files changed: src/knowledge/wkg.service.ts, src/knowledge/entities/node.ts
Tickets completed: T001, T002
```

---

## Key Rules

- Three-line format is non-negotiable
- **NEXT** must be a single, specific, actionable item
- Always runs at end of session, even if nothing was completed
