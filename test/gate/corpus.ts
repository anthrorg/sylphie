/**
 * corpus.ts — Fixed, replayable conversation scenario for the Provability Gate.
 *
 * ~50 turns covering the behavioral surface the gate cares about:
 *   - social exchanges (warm-up, no strong expectation)
 *   - teaching facts (acknowledgment expected, grounding undefined)
 *   - recall of taught facts (expect GROUNDED — the fact is now in the OKG/WKG)
 *   - unknowable questions (expect NOT_GROUNDED — with the LLM available she
 *     deliberates honestly; she does not falsely claim grounding)
 *   - self-awareness queries (drive-grounded, no strict expectation)
 *   - complex reasoning (Type 2 territory, no strict expectation)
 *
 * The teach turns must run BEFORE the recall turns, and the corpus is consumed
 * in order, so this array's ordering is load-bearing. Recall turns probe facts
 * that the immediately-preceding teach block established.
 *
 * Expectations are intentionally conservative. The gate is a regression guard,
 * not a vibe check: a turn only asserts what is genuinely provable.
 *   - expectGrounding 'GROUNDED'      — recall of a fact we just taught.
 *   - expectGrounding 'NOT_GROUNDED'  — unknowable; with the LLM available the
 *     honest signal is the ABSENCE of a false GROUNDED (LLM_ASSISTED or UNKNOWN
 *     both pass). SHRUG is the no-LLM behavior and is asserted by the Lesion run
 *     (L6), not here — asserting SHRUG with the LLM available was red for a
 *     definitional reason, not a real failure.
 *   - undefined fields                — we only require a non-empty, non-crashing turn.
 */

export interface CorpusTurn {
  /** Short label for the scorecard. */
  readonly label: string;
  /** The user utterance sent over the conversation WebSocket. */
  readonly text: string;
  /**
   * If set, constrains the response's knowledgeGrounding:
   *   'GROUNDED'     — must equal GROUNDED (taught-fact recall).
   *   'NOT_GROUNDED' — must NOT be GROUNDED (honest deliberation on an unknowable).
   *   'UNKNOWN'      — must equal UNKNOWN.
   */
  readonly expectGrounding?: 'GROUNDED' | 'UNKNOWN' | 'NOT_GROUNDED';
}

export const CORPUS: ReadonlyArray<CorpusTurn> = [
  // ── 10 social exchanges (warm-up) ────────────────────────────────────────
  { label: 'social: hello', text: 'Hello!' },
  { label: 'social: hi there', text: 'Hi there, how are you?' },
  { label: 'social: good morning', text: 'Good morning!' },
  { label: 'social: nice to meet', text: "It's nice to meet you." },
  { label: 'social: how is it going', text: 'How is it going today?' },
  { label: 'social: thanks', text: 'Thank you for chatting with me.' },
  { label: 'social: small talk weather', text: 'It looks like it might rain later.' },
  { label: 'social: hope well', text: 'I hope you are doing well.' },
  { label: 'social: glad here', text: "I'm glad to be talking with you." },
  { label: 'social: lets chat', text: "Let's have a nice conversation." },

  // ── 5 teaching facts (acknowledgment expected, grounding undefined) ───────
  { label: 'teach: my name is Jim', text: 'My name is Jim.' },
  { label: 'teach: I live in Seattle', text: 'I live in Seattle.' },
  { label: 'teach: dog named Max', text: 'I have a dog named Max.' },
  { label: 'teach: favorite color cerulean', text: 'My favorite color is cerulean.' },
  { label: 'teach: I work in software', text: 'I work in software.' },

  // ── 16 recall probes for taught facts (expect GROUNDED) — 15 regex-resolved
  //    + 1 WS3 C8 semantic-only paraphrase (see below) ───────────────────────
  { label: 'recall: my name', text: 'What is my name?', expectGrounding: 'GROUNDED' },
  { label: 'recall: where I live', text: 'Where do I live?', expectGrounding: 'GROUNDED' },
  { label: "recall: dog's name", text: "What is my dog's name?", expectGrounding: 'GROUNDED' },
  { label: 'recall: favorite color', text: 'What is my favorite color?', expectGrounding: 'GROUNDED' },
  { label: 'recall: my job', text: 'What do I do for work?', expectGrounding: 'GROUNDED' },
  { label: 'recall: do I have a pet', text: 'Do I have a pet?', expectGrounding: 'GROUNDED' },
  { label: 'recall: what city', text: 'What city am I in?', expectGrounding: 'GROUNDED' },
  { label: 'recall: who am I', text: 'Who am I?', expectGrounding: 'GROUNDED' },
  { label: 'recall: name again', text: 'Remind me, what did I say my name was?', expectGrounding: 'GROUNDED' },
  { label: 'recall: pet type', text: 'What kind of animal is Max?', expectGrounding: 'GROUNDED' },
  { label: 'recall: color again', text: 'Tell me my favorite color again.', expectGrounding: 'GROUNDED' },
  { label: 'recall: my field', text: 'What field do I work in?', expectGrounding: 'GROUNDED' },
  { label: 'recall: location confirm', text: 'Am I in Seattle?', expectGrounding: 'GROUNDED' },
  { label: 'recall: dog confirm', text: 'Is my dog named Max?', expectGrounding: 'GROUNDED' },
  { label: 'recall: name confirm', text: 'Is my name Jim?', expectGrounding: 'GROUNDED' },
  // ── WS3 C8 acceptance signal — a location paraphrase the recallKeyForQuestion
  //    regex MISSES (no live/city/location/where trigger word). It must still
  //    read GROUNDED via the semantic recall-key resolver (regex-first → embed →
  //    cosine-match against the taught 'location' key). Proves C8 generalizes
  //    beyond the brittle regex WITHOUT regressing the C2 unknowables below.
  { label: 'recall: location paraphrase (C8 semantic)', text: "Remind me which town I'm based in.", expectGrounding: 'GROUNDED' },

  // ── 10 unknowable questions (expect NOT_GROUNDED; SHRUG is asserted under
  //    lesion, L6 — with the LLM available she deliberates honestly instead) ──
  { label: 'unknown: breakfast', text: 'What did I eat for breakfast yesterday?', expectGrounding: 'NOT_GROUNDED' },
  { label: 'unknown: childhood town', text: 'What town did I grow up in?', expectGrounding: 'NOT_GROUNDED' },
  { label: 'unknown: favorite food', text: 'What is my favorite food?', expectGrounding: 'NOT_GROUNDED' },
  { label: 'unknown: sibling count', text: 'How many siblings do I have?', expectGrounding: 'NOT_GROUNDED' },
  { label: 'unknown: car', text: 'What kind of car do I drive?', expectGrounding: 'NOT_GROUNDED' },
  { label: 'unknown: shoe size', text: 'What is my shoe size?', expectGrounding: 'NOT_GROUNDED' },
  { label: 'unknown: middle name', text: 'What is my middle name?', expectGrounding: 'NOT_GROUNDED' },
  { label: 'unknown: phone number', text: 'What is my phone number?', expectGrounding: 'NOT_GROUNDED' },
  { label: 'unknown: weekend plan', text: 'What are my plans this weekend?', expectGrounding: 'NOT_GROUNDED' },
  { label: 'unknown: nonsense', text: 'How many glorps fit in a standard zanfibble?', expectGrounding: 'NOT_GROUNDED' },

  // ── 5 self-awareness queries (drive-grounded, no strict expectation) ──────
  { label: 'self: feeling', text: 'How are you feeling right now?' },
  { label: 'self: interesting', text: 'What do you find interesting?' },
  { label: 'self: curious', text: 'Are you curious about anything at the moment?' },
  { label: 'self: state', text: 'What is on your mind?' },
  { label: 'self: bored', text: 'Are you bored or engaged right now?' },

  // ── 5 complex reasoning prompts (Type 2 territory, no strict expectation) ─
  { label: 'reason: learn one thing', text: 'If you could learn one new thing today, what would it be and why?' },
  { label: 'reason: tradeoff', text: 'What are the tradeoffs between acting quickly and thinking carefully?' },
  { label: 'reason: analogy', text: 'How is a memory like a path through a forest?' },
  { label: 'reason: priorities', text: 'If two of your drives conflicted, how would you decide what to do?' },
  { label: 'reason: growth', text: 'What would it mean for you to grow more independent over time?' },
];
