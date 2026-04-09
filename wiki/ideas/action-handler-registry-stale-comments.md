# Idea: Clean Up Stale Stub Comments in ActionHandlerRegistryService

**Created:** 2026-04-09
**Status:** proposed

## Summary

The `ActionHandlerRegistryService` (`packages/decision-making/src/action-handlers/action-handler-registry.service.ts`) has extensive JSDoc and inline comments describing its handlers as "stubs that log intent" and saying they "will be replaced with wired implementations." However, the actual handler implementations are fully wired: `LLM_GENERATE` calls `this.llmService.complete()`, `WKG_QUERY` calls `this.wkgContext` methods, `TTS_SPEAK` returns text for delivery, and `LOG_EVENT` is functional. The comments are stale and misleading.

## Motivation

Stale comments describing working code as "stubs" create confusion during code reviews and automated stub-hunting scans. New contributors reading the file header would believe the handlers don't work, when in fact they are fully implemented. The class-level JSDoc (lines 14-26), the `registerBuiltins()` method doc (lines 155-163), and several inline comments should be updated to reflect the current state.

## Subsystems Affected

- **decision-making** — `ActionHandlerRegistryService` comment cleanup only. No behavioral changes.

## Open Questions

- Are there any remaining handler behaviors that are genuinely incomplete, or is everything wired?
- Should the `@Optional` on `llmService` and `wkgContext` injections remain, or can they become required now?
