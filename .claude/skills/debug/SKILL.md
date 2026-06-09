# Debug

Spawn the Hopper agent for systematic root-cause analysis of a bug or unexpected behavior.

## Usage

```
/debug "Neo4j connection failing on startup"
/debug "Drive values not updating after action"
/debug "LLM response not reflecting drive state"
```

## When to Use

- When something is broken and needs investigation
- When behavior is unexpected
- When an error is recurring

---

## Workflow

1. Spawn **hopper** agent with the error description
2. Hopper follows systematic debugging methodology:
   - Reproduce → Read error → Hypothesize → Verify → Fix root cause
3. If debugging takes >5 minutes, Hopper adds to `docs/architecture/error-playbook.md`
4. Return fix with explanation

---

## Key Rules

- Read before fixing -- always understand the code first
- Minimal changes -- fix the bug, nothing else
- Fixes must still respect CANON and architecture boundaries
