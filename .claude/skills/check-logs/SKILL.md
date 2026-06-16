---
name: check-logs
description: Scan logs/sylphie.log for errors, warnings, crashes, and exceptions and report findings concisely with timestamps. Read-only — never starts, stops, or restarts the app. Use when asked to check logs or see what's failing at runtime.
---

# Check Logs

Scan `logs/sylphie.log` for errors, warnings, crashes, and issues. Report what's found.

## Usage

```
/check-logs
/check-logs "STT"
/check-logs "last 5 minutes"
```

## Workflow

1. Read the tail of `logs/sylphie.log` (last 200 lines by default)
2. If an argument is provided, grep for that term
3. Scan for ERROR, WARN, crash indicators, uncaught exceptions
4. Report findings concisely: what failed, when, and the relevant log lines
5. If the log file doesn't exist, say so — don't start the app

## Key Rules

- **Read only** — never start, stop, or restart the app
- Check for: ERROR, WARN, "crash", "failed", "exception", "TypeError", "Cannot", "ECONNREFUSED"
- Show timestamps so Jim can correlate with what he was doing
- If no issues found, say "logs clean" with the time range covered
