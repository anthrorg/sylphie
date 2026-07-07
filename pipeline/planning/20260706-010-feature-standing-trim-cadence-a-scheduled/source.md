# Feature: Standing trim cadence — a scheduled occam prosecution cog

From Jim, 2026-07-02 ("one guy whose whole job is just to trim"). The `occam` agent
exists (`.claude/agents/occam.md`, Opus, prosecutorial charter with mandatory
pipeline/contract future-work cross-check) and its first docket is at
`docs/audits/trim/2026-07-02-layer3-spreading-activation.md`. What's missing is the
cadence: without a schedule, trim reverts to one-shot audits that go stale (the June 21
structural audits were stale within two weeks).

## What to build

A new pipeline cog (scheduled task, overnight slot alongside execute/cleanup/review):

- **One subsystem per tick**, rotating through the ~12 subsystems (state kept in a small
  rotation file or pipeline config) — so every part of Sylphie stands trial roughly
  monthly.
- The tick spawns `occam` on that scope; the docket lands in `docs/audits/trim/`.
- **Docket → pipeline item:** charges that survive occam's own acquittal filter are
  ingested as a pipeline item (type: trim) so they flow through the normal
  planning → architect-ruling → Jim-approval gates. REFER-TO-JUDGE charges route to
  `architect` explicitly. Never auto-delete anything — kills become plan nodes like all
  code changes.
- Respect existing pipeline invariants: max_items_per_tick, contract_write=staged,
  never write contract.yaml while dirty, 17:00–22:00 left free.

## The teeth (acceptance criteria sketch)

- Cog runs on schedule, prosecutes the next subsystem in rotation, writes a docket, and
  files at most one pipeline item per tick.
- DEAD-twice and THEATER mechanical rules produce docket entries without discretion;
  standing keep-rulings (architect log / contract decisions) are honored per the charter
  precedence rule.
- Success metric (check after ~1 month live): approved kills have actually MERGED —
  measured in the contract changelog, not in dockets filed. A trim institution that
  produces reports and no deletions has failed its own acceptance criterion.

## Non-goals

- No changes to occam's charter (separately maintained).
- No auto-merge, no auto-delete, no contract writes beyond the staged/approval flow.
- Not a general audit scheduler — this cog runs occam only.

## DB impact

None (scheduler + file moves).
