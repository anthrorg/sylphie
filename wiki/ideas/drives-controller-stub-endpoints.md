# Idea: Implement DrivesController Stub Endpoints

**Created:** 2026-04-09
**Status:** proposed

## Summary

The `DrivesController` in `apps/sylphie/src/controllers/drives.controller.ts` has three POST endpoints (`/drives/override`, `/drives/drift`, `/drives/reset`) that accept request bodies but return empty `{}` without performing any action. These should be wired to the Drive Engine to actually set overrides, apply drift rates, and reset overrides.

## Motivation

The frontend DrivesPanel and useDriveOverrides hook appear to call these endpoints expecting them to modify drive state for development/debugging purposes. Currently, all three are no-ops — the request is accepted but silently dropped. This means the drive override controls in the UI do nothing, which is misleading during development and testing. The `driveReader` (IDriveStateReader) is already injected but unused for the POST routes.

## Subsystems Affected

- **apps/sylphie** — `DrivesController` needs to forward override/drift/reset commands to the Drive Engine via IPC.
- **drive-engine** — May need IPC message types for OVERRIDE_SET, DRIFT_SET, OVERRIDE_RESET if they don't exist.
- **frontend** — `useDriveOverrides` hook is likely already sending requests; once wired, the UI controls will work.

## Open Questions

- Does CANON permit external drive overrides, or should these be dev-mode only?
- Should overrides go through IPC to the child process, or should DrivesController use a different write path?
- Are there safety constraints on what override values are acceptable (e.g., clamping ranges)?
