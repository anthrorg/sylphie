# Sync PKG

Refresh the Codebase PKG: re-seed the graph from source, classify domains, and infer connections. Runs three steps sequentially.

## Usage

```
/sync-pkg
```

## When to Use

- After code changes that affect function signatures, module structure, or call patterns
- When the PKG graph needs to be brought up to date with the codebase
- Before running analyses that depend on an accurate PKG

## Prerequisites

1. Codebase PKG Neo4j container running on `bolt://localhost:7691`

---

## Workflow

### Step 1: Seed the graph

Run in the terminal:

```bash
yarn sync-pkg
```

Wait for it to complete successfully before proceeding. If it fails, report the error and stop.

### Step 2: Classify domains

Run the `/classify-pkg-domains` skill.

Wait for it to complete before proceeding.

### Step 3: Infer connections

Run the `/infer-pkg-connections` skill.

---

## Key Rules

- Steps must run sequentially -- each depends on the previous one
- If any step fails, stop and report the error -- do not continue to the next step
- Do not pass extra flags to the sub-skills unless Jim specifies them
