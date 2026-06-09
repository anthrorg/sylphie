# Create Idea

Capture an idea for Sylphie and save it as a file in `wiki/ideas/` for later research.

## Usage

```
/create-idea "Emotional memory weighting based on drive intensity at encoding time"
/create-idea "Use WebRTC for real-time audio instead of file-based STT"
/create-idea   # prompts for the idea interactively
```

## When to Use

- When Jim has an idea he wants to capture for later evaluation
- When brainstorming potential features, changes, or experiments for Sylphie

---

## Workflow

### Step 1: GET THE IDEA

If no argument was provided, ask Jim:

> What's the idea?

Wait for the response before proceeding.

### Step 2: CLARIFY

Restate the idea in one clear sentence and identify:
- Which Sylphie subsystems it would touch
- What problem it solves or what it improves

Ask Jim if the framing is right. If he corrects it, update accordingly.

### Step 3: WRITE THE IDEA FILE

Create the file at:

```
wiki/ideas/slug.md
```

Where `slug` is a short, descriptive kebab-case name (e.g., `emotional-memory-weighting.md`).

Use this template:

```markdown
# Idea: <Title>

**Created:** YYYY-MM-DD
**Status:** proposed

## Summary

<1-2 sentences clearly describing the idea>

## Motivation

<Why this would be valuable. What problem does it solve?>

## Subsystems Affected

- <Subsystem 1>
- <Subsystem 2>

## Open Questions

- <Anything that needs to be answered during research>
```

### Step 4: CONFIRM

Tell Jim:
- The idea was saved
- The file path
- That it can be picked up later with `/research-idea`

---

## Key Rules

- Keep idea files short and clear -- they are prompts for future research, not research themselves
- Don't evaluate feasibility here -- that's `/research-idea`'s job
- One idea per file
- If a similar idea already exists in `wiki/ideas/`, tell Jim and ask whether to update it or create a new one
