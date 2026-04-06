# Type 2 Deliberation — Full Design

**Date:** 2026-04-06
**Source:** Conversation between Jim and Claude about how Type 2 should actually work
**Status:** Design document — not yet implemented

## Core Insight

Type 2 is not just "call the LLM and return text." It's a multi-step deliberation pipeline that:

1. Recognizes a novel situation (Type 1 miss in the latent space)
2. Reasons through it via inner monologue
3. Generates candidate responses
4. Debates for/against each candidate
5. Verifies against external sources (Google as consensus signal)
6. Commits the decision
7. **Writes the result back to the latent space so Type 1 catches it next time**

This is learning. System 2 does the heavy lifting once per novel situation, then compresses the result into a System 1 shortcut. Kahneman's thesis made architectural.

## The Flow

```
Stimulus arrives ("Hello")
    ↓
Cosine similarity against latent space → MISS (empty on first encounter)
    ↓
Type 1 has no answer → falls back to Type 2
    ↓
INNER MONOLOGUE
  "Someone said hello to me. What do I do?"
  "I need to respond. What should I say?"
  Checks episodic memory → no matching events
    ↓
CANDIDATE GENERATION (LLM)
  LLM suggests 3 predictions on what to do or say:
    1. "Greet them warmly back"
    2. "Ask who they are"  
    3. "Wait and observe"
    ↓
INNER MONOLOGUE SELECTS
  LLM evaluates the candidates against drive state and context
  Selects: "Greet them warmly back"
    ↓
FOR/AGAINST DEBATE
  FOR agent: argues why greeting is correct
  AGAINST agent: argues why it might be wrong
    ↓
EXTERNAL VERIFICATION (Google search as MCP tool)
  Arbiter takes key claims from both sides
  Structures them as search queries
  Gets back consensus signal from the broader information ecosystem
    ↓
ARBITER SYNTHESIZES
  Three inputs: for position, against position, external concordance
  Triangulates → commits to "greet warmly"
    ↓
LATENT SPACE WRITE-BACK
  Records the full pattern:
    - Stimulus embedding (the situational signature)
    - Selected response
    - Confidence level
    - Deliberation trace (the "why")
    ↓
NEXT TIME "Hello" (or "hey" or "what's up") arrives:
  Cosine similarity against latent space → HIT
  Type 1 catches it immediately → no deliberation needed
```

## The Latent Space

The latent space is the bridge between Type 2 reasoning and Type 1 reflexes. It stores learned patterns as embeddings that Type 1 matches against.

### Three-layer architecture:

**Hot layer** — In-memory vector index for Type 1 lookups. Microsecond cosine similarity. This is what makes Type 1 feel instant.

**Warm layer** — TimescaleDB/pgvector (`learned_patterns` table). The durable store. Every Type 2 decision writes here. On boot, hydrate the hot layer from this.

**Cold layer** — Full deliberation traces in Neo4j WKG. The "why" behind every learned pattern. Not needed for Type 1 matching but available for introspection ("Why do you respond to greetings this way?").

### What gets stored per pattern:

- **Stimulus embedding** — The fused sensory frame embedding that triggered this deliberation. Type 1 matches on cosine similarity against this.
- **Response** — What Sylphie decided to do/say.
- **Action procedure** — The WKG procedure node created from this decision (for the executor to dispatch).
- **Confidence** — How confident the arbiter was in this decision.
- **Deliberation trace** — The full reasoning chain: inner monologue, candidates, for/against arguments, external verification results, arbiter rationale.
- **Timestamp** — When this pattern was learned.
- **Use count** — How many times Type 1 has matched this pattern (drives ACT-R confidence).
- **Recent MAE** — Prediction accuracy when this pattern is used (drives graduation/demotion).

### Hydration on boot:

On startup, load the warm layer into the hot layer. Frequency-weighted: most-used patterns load first so Sylphie is functional fast. Backfill the rest while she's already responding.

This is her "waking up" — she doesn't lose anything, she just needs a moment to load it all back in.

## MCP / Tool Calling

The deliberation pipeline needs the LLM to have tool access:

### Tools available during Type 2:

1. **episodic_memory_search** — Query recent episodes by embedding similarity. "Have I seen this before?"
2. **wkg_query** — Look up facts in the World Knowledge Graph. "What do I know about this topic?"
3. **person_model_query** — Look up what I know about the person I'm talking to.
4. **google_search** — External consensus verification. NOT treated as ground truth — treated as a concordance signal.
5. **drive_state_read** — Check current motivational state (for authentic response calibration).

### Google as consensus signal (NOT truth source):

The key architectural principle: Sylphie forms her own position first, then checks whether the world agrees.

- **What most agents do:** "Google, what's the answer?" → parrot it back
- **What Sylphie does:** "I think X is true. Google, does the world seem to agree?" → confidence calibration

Concordance matrix:
| Sylphie's confidence | Google agrees | Action |
|---|---|---|
| High | Yes | Boost confidence, commit |
| High | No | Flag divergence, don't auto-correct (her grounded memory may be right) |
| Low | Yes | Boost confidence, commit |
| Low | No | Actively reconsider — both sides uncertain |

This is auditable. Every verification check is logged: what she claimed, what the search returned, whether she revised. Builds calibration data over time.

## For/Against Debate Structure

When the inner monologue selects a candidate response, it's not immediately committed. Instead:

### FOR agent (LLM call):
- Argues why this response is appropriate
- Cites evidence from episodic memory, WKG, person model
- Considers drive state alignment

### AGAINST agent (LLM call):
- Argues why this response might be wrong
- Considers alternative interpretations
- Flags potential Theater Prohibition violations
- Identifies what could go wrong

### Arbiter (LLM call):
- Receives both arguments
- Takes key factual claims from both sides
- Runs external verification (Google search) on disputed claims
- Synthesizes with three inputs: for, against, external concordance
- Commits final decision with confidence score

### When to trigger debate:
Not every Type 2 needs full debate. Trigger based on:
- **Disagreement magnitude** between candidates (if they're all similar, just pick the best)
- **Confidence level** (low confidence → debate helps)
- **Novelty** (truly novel situation → debate helps)
- **Drive pressure** (high anxiety → be more careful → debate)

## Maturity Curve

Early Sylphie:
- Latent space is sparse/empty
- Type 2 fires on almost everything
- She's slow and deliberate about basic interactions
- Every conversation is a learning opportunity

Mature Sylphie:
- Latent space is rich with learned patterns
- Type 1 catches most interactions instantly
- Type 2 only fires on genuinely novel situations
- She's fast and fluid in familiar contexts, thoughtful in new ones

This is the natural maturity curve of intelligence. Not a bug — it's what learning looks like.

## Connection to Existing Architecture

### What already exists:
- 8-state FSM executor engine
- Type 1/2/SHRUG arbitration with confidence thresholds
- Episodic memory ring buffer
- ACT-R confidence dynamics with graduation/demotion
- OllamaLlmService (basic chat completion)
- pgvector in TimescaleDB (sensory_ticks table)
- Prediction MAE tracking

### What needs to be built:
1. **Latent space** — learned_patterns table in pgvector + in-memory hot index
2. **Type 1 similarity search** — cosine lookup against hot index before arbitration
3. **Multi-step deliberation pipeline** — inner monologue → candidates → debate → arbiter
4. **MCP tool integration** — Ollama tool calling with registered tools
5. **Google search tool** — Browser-based or API-based search for consensus verification
6. **Latent space write-back** — After Type 2 commits, write the pattern for Type 1
7. **Boot hydration** — Load warm layer into hot layer on startup
8. **Deliberation trace logging** — Full audit trail in TimescaleDB + WKG
