// Hook: Reject chained/parallel tool calls.
// Runs on PreToolUse — allows only one tool call per batch.
// If multiple tool calls arrive within a short window, all but the first are rejected.

const fs = require("fs");
const path = require("path");
const os = require("os");

const LOCK_FILE = path.join(os.tmpdir(), "claude-tool-lock.json");
const BATCH_WINDOW_MS = 1500; // calls within this window are considered chained

let data = "";
process.stdin.on("data", (chunk) => (data += chunk));
process.stdin.on("end", () => {
  try {
    // Parse stdin to check the tool name — Agent calls are always allowed
    let input = {};
    try {
      input = JSON.parse(data);
    } catch {}

    const toolName = input.tool_name || "";
    if (toolName === "Agent" || toolName === "SendMessage") {
      process.exit(0); // Always allow agent spawning/messaging
    }

    const now = Date.now();
    let lock = null;

    try {
      const raw = fs.readFileSync(LOCK_FILE, "utf-8");
      lock = JSON.parse(raw);
    } catch {
      // No lock file or invalid — this is the first call
    }

    if (lock && now - lock.timestamp < BATCH_WINDOW_MS) {
      // Another tool call happened very recently — this is a chained/parallel call
      process.stderr.write(
        "BLOCKED: Chained tool calls are not allowed. Make one tool call per response, then wait for the result before making the next call."
      );
      process.exit(2); // Exit 2 = block the tool call
    }

    // First call in this batch — record timestamp and allow
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ timestamp: now }), "utf-8");
    process.exit(0);
  } catch (e) {
    // On error, allow the call rather than blocking work
    process.exit(0);
  }
});
