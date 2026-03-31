# Enforce Canon

Run a CANON compliance check against a proposal, plan, or code change.

## Usage

```
/enforce-canon                    # Check current changes
/enforce-canon epic:1             # Check Epic 1 plan
/enforce-canon "proposal text"    # Check a specific proposal
```

## When to Use

- Before any architectural change
- When reviewing an epic plan
- When a proposal feels like it might drift from CANON principles

---

## Workflow

1. Read `wiki/CANON.md` in full
2. Identify the subject under review (diff, epic plan, or proposal)
3. Spawn the **canon** agent to run the full enforcement checklist
4. Return structured verdict: COMPLIANT, NON-COMPLIANT, or COMPLIANT WITH CONCERNS

---

## Key Rules

- Canon agent always reads the CANON fresh -- never works from memory
- Every violation cites the specific CANON section
- Non-compliant results block work until resolved or Jim overrides
