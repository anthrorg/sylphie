# Research Idea

Pick up an idea from `wiki/ideas/` and research it. Evaluates plausibility, complexity, and implementation path. Produces a verdict document in `wiki/researchedIdeas/` and removes the idea from the queue.

## Usage

```
/research-idea                          # lists available ideas, asks which to research
/research-idea "emotional-memory"       # picks the idea matching that slug/keyword
```

## When to Use

- When there are ideas in `wiki/ideas/` waiting to be evaluated
- When Jim wants to vet an idea before committing to implementation

---

## Workflow

### Step 1: PICK AN IDEA

1. List all `.md` files in `wiki/ideas/`
2. If an argument was provided, find the idea whose filename or title best matches
3. If no argument was provided or multiple match, present the list and ask Jim which one to research
4. If `wiki/ideas/` is empty, tell Jim there are no ideas queued and suggest `/create-idea`
5. Read the selected idea file to get the full context

### Step 2: FRAME

1. Restate the idea in one clear sentence
2. Identify which Sylphie subsystems it touches (Decision Making, Learning, Drives, Communication, Planning, etc.)
3. Identify 2-4 key questions that determine feasibility

### Step 3: RESEARCH (parallel agents)

Launch 2-3 agents in parallel based on relevance:

**Always launch:**
- **General-purpose agent (web research)**: Search the web for prior art, papers, existing implementations, known pitfalls. Focus on whether this has been done before and what worked/failed.

**Pick 1-2 based on the idea's domain:**
- **Science advisor** (luria, piaget, skinner, ashby, scout): Theoretical grounding -- is this how it works in nature/theory? What does the literature say?
- **Technical agent** (forge, cortex, atlas, vox, sentinel, etc.): Implementation feasibility -- can we build this with our stack? What are the integration points? What would break?

Each agent should return a structured assessment:
```
Verdict: feasible | partially feasible | infeasible | needs more research
Confidence: high | medium | low
Key findings: [bullet points]
Risks: [bullet points]
```

### Step 4: SYNTHESIZE

Combine agent findings into a single assessment:

1. **Plausibility** -- Is this grounded in reality? Does prior art exist?
2. **Complexity** -- How hard is this to implement? (trivial / moderate / complex / massive)
3. **Fit** -- How well does this align with Sylphie's architecture?
4. **Risk** -- What could go wrong?
5. **Verdict** -- Should we do this? (yes / yes with caveats / not yet / no)
6. **Implementation sketch** -- If feasible, high-level steps to achieve it

### Step 5: WRITE OUTPUT

Create the research document at:

```
wiki/researchedIdeas/YYYY-MM-DD-slug.md
```

Use this template:

```markdown
# Research: <Idea Title>

**Date:** YYYY-MM-DD
**Status:** researched
**Verdict:** yes | yes-with-caveats | not-yet | no
**Source:** wiki/ideas/<original-file>.md

## Idea

<One paragraph restating the idea clearly>

## Key Questions

- <Question 1>
- <Question 2>
- ...

## Findings

### Prior Art
<What exists already? Links, papers, implementations>

### Theoretical Grounding
<Is this sound in theory? What does science/literature say?>

### Technical Feasibility
<Can we build this? What does our stack support? Integration points?>

## Assessment

| Dimension    | Rating                                 |
|-------------|----------------------------------------|
| Plausibility | high / medium / low                   |
| Complexity   | trivial / moderate / complex / massive |
| Fit          | strong / moderate / weak              |
| Risk         | low / medium / high                   |

## Verdict

<2-3 sentences: the bottom line>

## Implementation Path

<If feasible: numbered high-level steps to achieve this>
<If infeasible: what would need to change to make it feasible, if anything>

## Sources

- <Links, references, papers consulted>
```

### Step 6: CLEAN UP

Delete the original idea file from `wiki/ideas/` -- it has graduated to a researched idea.

### Step 7: REPORT

Tell Jim:
- The verdict (one line)
- Where the full document was saved
- Any immediate next steps if the verdict is positive

---

## Key Rules

- The research document is the deliverable -- it must be thorough enough that Jim can make a decision from it alone
- Always search the web for prior art -- don't just theorize
- Slug in the output filename should match the original idea file's slug
- If the idea file is too vague to research, ask Jim clarifying questions before proceeding
- Do NOT start implementation -- this skill is research only
