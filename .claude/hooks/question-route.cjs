#!/usr/bin/env node
/**
 * UserPromptSubmit hook — question router.
 *
 * Fires on every user prompt. If the message looks like a question (contains a
 * "?"), it injects a lightweight nudge telling the Sonnet coordinator to run the
 * `rank` skill before answering. The skill — not this hook — decides whether the
 * question is cheap enough to answer directly or deep enough to escalate to the
 * `mythos` Opus reasoner. The nudge is advisory: the coordinator may skip ranking
 * for a trivial clarification it can already answer from the current context.
 *
 * Cheap and non-blocking: it only ever adds context, never blocks a prompt.
 */
let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  try {
    const { prompt = '' } = JSON.parse(data || '{}');
    if (prompt.includes('?')) {
      const msg =
        '[question-router] This message contains a question. Before answering, ' +
        'run the `rank` skill to classify it. Escalate architectural, ' +
        'cross-subsystem, cutting-edge, or otherwise expensive-to-get-wrong ' +
        'questions to the `mythos` agent (Opus); answer simple factual/locational ' +
        'questions yourself. Skip ranking only for a trivial clarification you can ' +
        'already answer from the current context.';
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: msg,
          },
        })
      );
    }
  } catch (_e) {
    // Never block a prompt on a parse error — fail open.
  }
  process.exit(0);
});
