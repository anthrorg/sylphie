# Verbose log file grows unbounded

## What's broken
`logs/verbose.log` (written when `VERBOSE=1`) is never rotated or truncated. On a
long-running session it grows into the hundreds of MB, eventually slowing startup
(the log context reader scans the whole file) and filling the disk on the dev box.

## Expected
The verbose log should be size-bounded — roll over to a new file once it passes a
threshold (say 50 MB) and keep only the last few rotated segments, so disk use and
read time stay flat over a long session.

## Notes
- Only affects the verbose/debug log path, not the normal structured logs.
- No DB involved. Should be a small, self-contained change.
- Repro: run with VERBOSE=1 for a few hours, watch `logs/verbose.log` size climb.
