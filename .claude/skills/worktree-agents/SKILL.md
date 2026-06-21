---
name: worktree-agents
description: Autonomous ticket loop — pick the next todo ticket from contract.yaml, build it in an isolated git worktree, self-review as a senior engineer, write tests, open a PR, repeat up to N times. Orchestrator is the sole contract writer; sub-agents never touch contract.yaml.
---

# Worktree Agents

Runs an orchestrated loop against `planning/contract.yaml`. For each cycle: picks the next `todo` ticket by priority, marks it `in_progress`, spins a build agent in an isolated git worktree, and marks it `pr_open` once the PR is opened. Only the orchestrator writes to the contract.

## Usage

```
/worktree-agents           # process up to 5 tickets
/worktree-agents 3         # process up to 3 tickets
```

Pass a number as the first argument to override the default limit of 5.

## What each build agent does

1. **Creates a git worktree** at `../sylphie-worktrees/<ticket-id>/` on branch `agent/<ticket-id>-<slug>`
2. **Explores deeply** — codebase-pkg MCP first (getModuleContext → searchContent → getFunctionDetail → getConstraints), then reads every relevant file in full
3. **Implements** — simplest thing that satisfies every acceptance criterion; writes only inside the worktree
4. **Senior self-review** — re-reads every changed file as a PR reviewer; fixes correctness, readability, and subtle bugs; adds comments only where the WHY is non-obvious
5. **Writes tests** — matching the subsystem's existing test patterns; all tests must pass
6. **Commits and pushes** — with a scoped conventional-commit message
7. **Opens a PR** to `main` — body includes the acceptance-criteria checklist and a summary of what changed.

The build agent stops after opening the PR.

## Orchestrator guarantees

- **Sequential assignment** — next ticket is not picked until the current build agent finishes
- **No ticket overlap** — a ticket is marked `in_progress` before the build agent starts, so no two agents can claim the same ticket
- **Sole contract writer** — build agents never touch `planning/contract.yaml`; all status transitions (`todo → in_progress → pr_open`) are performed by the orchestrator

## Status transitions

```
todo  →  in_progress  (when assigned to a build agent)
in_progress  →  pr_open  (when PR is opened; pr_url and branch fields added)
```

---

## Execution

When this skill is invoked, call the Workflow tool with:

```
scriptPath: C:/Users/Jim/OneDrive/desktop/Code/sylphie/.claude/workflows/worktree-agents.js
```

If the user passed a number argument (e.g. `/worktree-agents 3`), pass it as:

```
args: { count: <number> }
```

The workflow runs in the foreground. Watch the progress tree — each cycle shows Pick & Assign → Build → Close phases.
