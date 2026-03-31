# Epic 11: Decisions

## Jim's Rulings (2026-03-30)

### Decision 1: Webcam Video in Phase 1
**Ruling:** Yes — active perception input (option B). Webcam feeds Decision Making with WKG writes.
**Impact:** CANON amendment needed to clarify webcam as Phase 1 Video input. Chassis camera remains Phase 2.

### Decision 2: Skills Manager Scope
**Ruling:** External concept upload (option B) — for uploading new concepts once graph shape is understood.
**Impact:** CANON A.13 amendment needed. Concepts uploaded by guardian enter WKG with GUARDIAN provenance at 0.60 base confidence. This is not autonomous skill creation — it's guardian teaching via structured input.

### Decision 3: WebRTC
**Ruling:** Yes — for webcam feed integration.
**Impact:** Overrides Vox recommendation to skip. MediaModule with WebRTC signaling gateway will be built. MJPEG as fallback for simpler setups.

## Proposed CANON Amendments (Pending Jim's Final Approval)

### Amendment 1: Phase 1 Video Clarification
**Current text (§Phase 1):** "No physical body yet."
**Proposed addition:** "Webcam (non-chassis) video input is within Phase 1 scope as the implementation mechanism for the Video input listed in the Decision Making subsystem. Chassis camera integration is Phase 2 scope."

### Amendment 2: A.13 Skill Packages Activation
**Current text (§A.13):** "DEFERRED — Skill packages emerge from Planning procedures."
**Proposed replacement:** "ACTIVE (Phase 1) — Two pathways: (1) Skills emerge from Planning procedures (autonomous). (2) Guardian concept upload via Skills Manager (guardian-initiated). Uploaded concepts receive GUARDIAN provenance at 0.60 base confidence. Guardian upload does not bypass the Confidence Ceiling — concepts must still be retrieved-and-used to exceed 0.60."

## Agent Disagreements Resolved

### WebRTC: Vox recommended skip, Jim overruled
Vox argued no measured need for WebRTC in Phase 1 (STT via REST, camera via MJPEG). Jim chose to include it for webcam feed integration. The MediaModule is built with WebRTC signaling; MJPEG serves as fallback.

### Skills CRUD: Forge flagged CANON A.13 concern, resolved by Jim's ruling
Forge correctly identified that a "create skill" pathway contradicts CANON A.13 DEFERRED status. Jim's ruling to allow guardian concept upload resolves this — the pathway is guardian-controlled, not autonomous, which preserves the spirit of Standard 6 (No Self-Modification).

## Guardrails (From Canon Verification)

These must be enforced in ticket acceptance criteria:
1. Drive charts: full [-10.0, 1.0] range, no clipping
2. Inner monologue: verbatim TimescaleDB events only
3. FE Agent: labeled "Observatory Assistant," zero write access, separate Claude instance
4. Graph viz: all 4 provenance types visible with filter support
5. No drive write endpoints in this epic
6. Theater check failures visible to guardian on affected messages
