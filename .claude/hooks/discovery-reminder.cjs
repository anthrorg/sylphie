// Hook: discovery-discipline reminder (PreToolUse on Read / Glob / Grep).
//
// Two-part nudge, per CLAUDE.md's discovery protocol:
//   1. Codebase exploration STARTS in the `codebase-pkg` MCP server
//      (getModuleContext -> searchContent -> getFunctionDetail / getConstraints
//      / getDataFlow), not raw Read/Grep/Glob.
//   2. Once the MCP has pointed you at the file(s) you need, READ THEM IN FULL
//      before reasoning about or editing them — never act on a graph snippet or
//      a partial read.
//
// NON-BLOCKING: always exits 0; the tool runs regardless. The reminder is
// surfaced via PreToolUse `additionalContext`.
//
// THROTTLED: fires at most once per REMINDER_INTERVAL_SEC (default 600s = 10min)
// so it nudges at the start of a work burst instead of spamming every call.

const fs = require("fs");
const os = require("os");
const path = require("path");

const TOOLS = new Set(["Read", "Glob", "Grep"]);
const INTERVAL_MS =
  (Number(process.env.REMINDER_INTERVAL_SEC) || 600) * 1000;
const MARKER = path.join(os.tmpdir(), "sylphie-discovery-reminder.last");

const REMINDER = [
  "Discovery protocol reminder:",
  "• Structural exploration STARTS in the `codebase-pkg` MCP server",
  "  (getModuleContext → searchContent → getFunctionDetail / getConstraints /",
  "  getDataFlow) — prefer it over raw Read/Grep/Glob for \"where/how is X\".",
  "• Once you've LOCATED the file(s) you need, Read them IN FULL before",
  "  reasoning about or editing them. The graph and snippets only point the",
  "  way — never bet an edit on a getFunctionDetail snippet or a partial read.",
].join("\n");

let data = "";
process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", () => {
  // Fail open: any error => allow the tool, no reminder.
  try {
    const tool = JSON.parse(data || "{}").tool_name;
    if (!TOOLS.has(tool)) process.exit(0);

    // Throttle on a temp marker file (each hook run is its own process).
    try {
      const last = Number(fs.readFileSync(MARKER, "utf-8"));
      if (Number.isFinite(last) && Date.now() - last < INTERVAL_MS) {
        process.exit(0); // within window — stay quiet
      }
    } catch {
      /* no marker yet — first fire */
    }
    try {
      fs.writeFileSync(MARKER, String(Date.now()));
    } catch {
      /* best-effort; reminder still fires */
    }

    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: REMINDER,
        },
      })
    );
  } catch {
    /* fail open */
  }
  process.exit(0);
});
