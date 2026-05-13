# Idea: Decide Drive and Face Modalities in Latent Space writeMultiModal

**Created:** 2026-04-27
**Status:** proposed

## Summary

`LatentSpaceService.writeMultiModal` (`packages/decision-making/src/latent-space/latent-space.service.ts`, line 389) hardcodes a skip for the `drives` and `faces` modalities with the comment "Skip drive/face modalities for now -- they don't carry conversational signal". Any caller that supplies embeddings for these modalities silently has those entries dropped before being written.

## Motivation

The latent space is one half of the Type 1 / Type 2 pair (CANON §Dual-Process Cognition) -- it is supposed to be the fast pattern-matching index across modalities. A blanket `for now` skip on two of the available modalities is an undocumented capability gap: callers think they are writing multi-modal patterns and are not. Either drive and face embeddings should be written (because drive-state context and face-recognition context absolutely do carry signal for response selection), or the API should refuse them at the type level so callers cannot silently lose data. The "for now" comment indicates this was meant to be revisited.

## Subsystems Affected

- **decision-making** -- `latent-space.service.ts writeMultiModal` either needs to write drive/face patterns (with appropriate metadata) or the `MultiModalWriteOpts` type needs to reject those modalities at compile time.
- **perception-service** / **apps/sylphie** -- Any caller currently passing drive/face embeddings should be audited for whether their loss is intended.

## Open Questions

- Is the original concern that drive/face modalities would pollute the conversational match space (and therefore want a separate index), or that they were unimplemented?
- If they should be written, should they go to a separate latent index or share the conversational one with a modality filter at retrieval time?
- What is the right surface area: keep the skip but add a metric that counts dropped writes, or fail loudly until the decision is made?
