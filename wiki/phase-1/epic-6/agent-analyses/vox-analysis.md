# Vox Analysis — Epic 6: Communication

**Agent:** Vox (Communication Engineer)
**Model:** sonnet
**Date:** 2026-03-29

## Summary

All 8 components are feasible with dependencies E2, E3, E4 available. No experimental APIs, no architectural unknowns.

## Key Recommendations

1. **Theater Prohibition**: Multi-layer enforcement — prompt injection + post-generation validation + zero reinforcement. Simple correlation check (emotional valence vs drive valence) with threshold 0.4.

2. **Drive State Injection**: All 12 drives in natural language narrative. Only describe drives notably high (>0.6) or low (<0.2). Example: "You feel curious (0.72) and slightly anxious (0.55). You are not particularly satisfied (0.15) — do not express satisfaction."

3. **Person Model Isolation**: Per-person Grafeo instances in Map<string, GrafeoGraph>. Public API returns sanitized PersonModel, not raw graph. No shared nodes/edges with WKG.

4. **Latency Strategy**: Sentence-level TTS streaming. Pre-computed acknowledgment cache. Target < 2s for text, < 3s for voice.

5. **Event Emission**: All communication events to TimescaleDB. Tag has_learnable=true for: entity-containing inputs, corrections, teaching moments. Tag false for: routine acknowledgments.

## Proposed Ticket Breakdown

12 tickets (see tickets.yml for final 13-ticket version incorporating all agent feedback).

## v1 Code Assessment

- Input parser: structure only (clean-room for LLM-mediated)
- Person model: concept reuse (adapt PersonNode/Snapshot for Grafeo)
- Voice: pattern reuse (OpenAI API patterns)
- WebSocket: pattern reuse (NestJS gateway)
- Theater validator: entirely new
- LLM service: API patterns only
