# decisions — pending rulings for Jim

The reasoning stages (`review`, `replan`, `plan`, `refine`) drop anything that needs a
human ruling here, one file per issue, from `../templates/decision.template.md`.

Each entry is self-contained: context with file:line refs, the fork, options, a
recommendation, and the CANON lens — so a decision can be made without hunting through
the codebase. To resolve one, fill in its **Decision** block. The resolution is then
recorded to governance (`planning/contract.yaml` `decisions`, append-only) or
`docs/decisions/architect-log.yaml`, and the `replan` stage carries the item back into
`planning`.

- **Naming:** `<pipeline-item-id>-<slug>.md` — e.g. `20260702-002-ewc-consolidation-boundary.md`.
- **Status:** `OPEN` until decided; `DECIDED` once the block is filled and recorded.
- Decided entries can be archived alongside their pipeline item.
