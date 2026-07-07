# Architect rulings — item 20260702-015 (schema versioning / migration framework / boot invariants)

Session: architect-B (persistence), 2026-07-06. Scope: the three design forks in
`pipeline/replan/20260702-015-.../verify.md` §Architect questions. Writer discipline
observed: no shared files touched; YAML entries below are ready-to-append (ids AD-B1..B3,
coordinator renumbers serially).

Everything below was ruled against code read in full this session:
`packages/drive-engine/src/constants/rules.ts`, `packages/shared/src/types/confidence.types.ts`,
`pipeline/policies/db-change-safety.md`, `docs/future/sylphie-persistence-migration-plan.md`
(grep-verified §5 invariant 6), `docs/future/sylphie-autonomous-cognition-research.md` §4.3,
root `package.json:37-44`, architect-log AD-0051/0052 precedent, and both 015 and 016
plan.md/verify.md. None of the three forks is new application direction — all are
decomposition/design of intent Jim approved in the source items. **No ESCALATE-TO-JIM.**

---

## Ruling 1 (AD-B1) — "The veto logic" = the deterministic evaluation floor, checksummed as a floor manifest; the literal veto function does not exist yet

**Decision.** For CANON Std-6 floor-integrity purposes, "the veto logic" in source AC4 is
**the deterministic evaluation floor as it exists today**, concretely the exported units of
exactly two modules:

1. `packages/drive-engine/src/constants/rules.ts` — `ACTION_TYPE_DEFAULTS` (:80),
   `OUTCOME_DEFAULTS` (:205), `METADATA_SCALED_ACTION_TYPES` (:185),
   `computeDefaultAffect` (:229). These are the "hardcoded rules / original contingencies"
   the veto is defined over.
2. `packages/shared/src/types/confidence.types.ts` — the module whose own header declares
   Std-6 write-protection (:9-12): `computeConfidence` (:107, containing the Std-3 0.60
   ceiling clamp at :111-113), `CONFIDENCE_THRESHOLDS` (:58), `applyGuardianWeight`
   (:146, the Std-5 ×2/×3 multiplier at :150), `DEFAULT_DECAY_RATES` (:79),
   `qualifiesForGraduation` (:174), `qualifiesForDemotion` (:191).

Both of the coordinator's candidate answers were right, and the fork is false: the 0.60
confidence-ceiling enforcement AND the guardian-asymmetry multiplier are both floor units.
015-f checksums a **floor manifest** — a declared registry covering both modules — not one
constant and not a guessed single "veto" object.

**Why (traced, not inferred).** `veto` has zero hits in `packages/**/*.ts` because the term
comes from `docs/future/sylphie-autonomous-cognition-research.md` §4.3 — a **future**
graduated-autonomy component: "a pure function of the hardcoded rules and the present drive
vector... takes zero tensor input," with the load-bearing invariant "the veto logic is
write-protected from everything, including the tensor — the same immutability CANON
Standard 6 gives the evaluation function." The persistence plan (§5 invariant 6) imported
that phrase into a today-tense invariant. But the veto *function* only exists at the
Partial/Full autonomy stages (research doc §4.2 table), which are unbuilt — today the
executor leads and the tensor shadows, so there is nothing to veto and no code object to
checksum. What the invariant is actually protecting — "the immutable floor must be
verifiably the floor" — is exactly the two modules above: the contingencies the future veto
will be a pure function of, plus the evaluation function Std-6 names.

**Mechanism (design level; build owns details).**
- Per-unit sha256 over stable serialization: canonical JSON (sorted keys) for constant
  objects; `Function.prototype.toString()` for the pure functions. Plus one composite
  floor hash.
- Expected checksums live in a **committed, generated artifact** (e.g.
  `infra/floor/floor-checksums.json`), regenerated only by an explicit dev/build command
  (`yarn floor:stamp`) and shipped read-only. **Never stored in any DB the runtime can
  write** — an expected-checksum the system could update would let the system re-baseline
  its own floor, self-defeating under Std-6.
- Confidence note: value-level tampering (the primary Std-6 threat surface) is caught
  exactly; function-body hashes via `toString()` are stable only within one build form
  (tsx source vs compiled dist), so the stamp step must run against the same build form
  the boot check runs in. This is a build-time detail for `sentinel`/`forge`, not a design
  risk — flag it in the ticket.

**Standing constraint (record in governance):** when graduated autonomy builds the actual
veto function (research doc §4.3), it MUST register in this same floor manifest before any
Partial-autonomy stage activates. That is a constraint on future work, not a ticket now.

**Changes to staged tickets.**
- 015-f retitle: "Floor-integrity boot check: floor-manifest checksum (drive-engine
  contingency defaults + confidence evaluation floor)."
- 015-f ACs: extend AC1/AC2/AC3 to cover every registered unit of both modules; mutating
  any unit (test against a mutated copy) → `FloorChecksumMismatchError` naming the unit;
  add an AC that the expected-checksum artifact is not writable at runtime (no code path
  writes it; it is not in any DB).
- Source AC4 is thereby **satisfiable and closed** by 015-f as re-scoped — "veto logic"
  resolves to the evaluation floor; the literal future veto function is explicitly out of
  scope with the registration constraint recorded.
- 015-f's "Non-goals pending the open question" clause is deleted (question now ruled).

**CANON lens.** Implements Std-6 verification (and transitively guards the Std-3 ceiling
and Std-5 multiplier as data). No tension. One subtlety ruled on above: expected-checksum
placement must be runtime-immutable or the check itself violates the standard it enforces.

---

## Ruling 2 (AD-B2) — Boot on a recognized-but-pending migration: REFUSE and require manual apply; fresh-empty stores bootstrap-stamp; no auto-apply ever

**Decision.** 015-c's boot guard distinguishes three states per store and behaves:

1. **Stamped at current version** → boot proceeds.
2. **Stamped behind (pending migration over real data)** → **refuse to boot** with
   `SchemaVersionPendingError` naming the store, the found version, the target version,
   and the exact command to run (`yarn migrate:<name>:confirm`). No auto-apply, no env
   escape hatch.
3. **Unstamped store**:
   a. **Empty of data** (definition per store is ticket work: zero non-metadata nodes for
      a Neo4j graph; zero rows in `events` for Timescale) → **bootstrap-stamp** to the
      current version at boot. This is initialization, not migration — there is nothing to
      migrate — and it dissolves the fresh-environment deadlock: a brand-new compose/Railway
      env boots without ceremony.
   b. **Data present but no stamp** → refuse: "unstamped store with data — run the v1
      backfill (015-b) manually." Guessing a version for populated state is exactly the
      silent-misread the feature exists to kill.

**Why.**
- **House convention is explicit-confirm, everywhere.** `db-change-safety.md` §house
  convention: dry-run by default, `--confirm` to apply, backup-before-write; live precedent
  001/002 (`package.json:37-44`); PR #86's rollout was migrate→deploy as a deliberate
  manual same-window operation. Auto-apply-on-boot would make every deploy an implicit
  `--confirm` — a category break with the repo's entire DB-safety posture.
- **Least privilege makes auto-apply structurally wrong, not just risky.** The app boots on
  runtime credentials (`sylphie_app`), which after AD-0052 are deliberately grant-denied on
  privileged surfaces; migrations like 002 perform OWNER/REVOKE/GRANT DDL as
  `sylphie_admin`. Auto-applying at boot means shipping admin credentials into the
  request-serving runtime — the exact thing AD-0051 refused when it kept
  `POSTGRES_ADMIN_POOL` unwired. The bootstrap-stamp carve-out stays within runtime
  privileges (an ordinary metadata node/row write, no DDL).
- **Std-6 lens.** A boot path that silently rewrites the schema of the stores holding the
  evaluation substrate puts schema change inside the autonomous loop. Refuse-and-manual
  keeps schema change human-confirmed — same shape as the guardian gate on drive rules.
- **Prisma parity.** The Postgres lane already works this way: `prisma migrate deploy` is
  an explicit deploy step, never implicit in app boot. The Neo4j/Timescale lane should not
  be *more* automatic than the lane with the mature tooling.
- Cost accepted: a deploy carrying a pending migration halts until someone runs the apply.
  That is the same migrate+deploy same-window discipline Jim already runs (TK-154 rollout),
  now enforced loudly instead of assumed.

**Changes to staged tickets.**
- 015-c AC3 rewritten from "pick one behavior" to: pending recognized migration → refuse
  with `SchemaVersionPendingError` naming store/found/target/command; process exits
  non-zero before serving.
- 015-c gains AC4: fresh-empty store → bootstrap-stamp to current version, boot proceeds;
  double-boot is idempotent (stamp written once).
- 015-c gains AC5: unstamped store with data → refuse with a distinct named error.
- 015-c's non-goal ("no auto-apply without an explicit confirm-equivalent") is promoted
  from open question to ruled behavior; delete the open_question.
- Build-watch carried from verify.md: the `:SchemaVersion` node write (migration AND
  bootstrap-stamp paths) must satisfy the WKG provenance guard (`ProvenanceMissingError`)
  — stamp it with explicit provenance (system/migration source) or a deliberately exempted
  write path; make this an AC on 015-b, not an accident.

**CANON lens.** Aligns with Std-6 and with AD-0051/0052's least-privilege seam. No tension.

---

## Ruling 3 (AD-B3) — Sequencing with 016: split 015 and proceed now; 015-e stays parked until 016-a's manifest has LANDED; freeze the manifest checksum contract

**Decision.**
- **Proceed now** (with rulings 1–2 applied): 015-a → 015-b → {015-c → 015-f, and 015-d
  after 015-b}. All five are fork-free after this session and touch code disjoint from 016
  (`infra/migrations/`, boot providers vs 016's `infra/snapshot/`, cycle-guard,
  cognition-service). The source's "run sequentially, not concurrently" warning applies
  only to manifest-touching code — i.e., only 015-e.
- **015-e stays parked** (not queued) until item 016's ticket -a has **landed in main**
  (merged, not merely planned) with its manifest format. Building 015-e against a guessed
  manifest shape is rework-guaranteed.
- **Manifest interface contract, binding on 016-a** so 015-e is buildable against it:
  `manifest.json` MUST expose (a) a per-dump-file sha256 checksum for every artifact in the
  snapshot (016-a's plan already writes this — affirmed and frozen as an interface
  commitment, per `sylphie-persistence-migration-plan.md` §manifest and 015-e AC1), and
  (b) top-level `schema_version` and `tensor_arch_version` keys in the SAME manifest.json
  (resolves 016-verify gap 3 in favor of the observability spec §1 shape;
  `tensor_manifest.json` may still exist as the tensor-side detail file, but the top-level
  keys are canonical).
- **Recommended order:** queue 015-a/b immediately; rework 016's plan in parallel (its
  three verify gaps are planner-level); 016-a after 015-b lands, so the manifest's
  `schema_version` field reads the real stamp instead of a placeholder — cheap to achieve
  since 015-a/b are small, and it dissolves 016-a's "schema_version placeholder int" wart.
- **Not ruled here (flag to coordinator):** 016's own architect question — whether the
  drive-engine SNAPSHOT_QUIESCE push/ack handshake is required, or an MVCC-consistent
  pg_dump of drive-state suffices (016-verify §Architect questions). That is a separate
  ruling that must happen before 016-a builds. It is architect jurisdiction (drive
  isolation design), not Jim-direction; route it to an architect session with `drive`/
  `ashby` consult.

**Why.** 015's dependency on 016 was always scoped to one invariant (checksums-vs-manifest,
015-e); the plan already isolated it correctly. Parking a whole P0 epic on its one blocked
leaf ticket would invert the priority the source argues (silent drift compounding into
poisoned learning is the live risk; snapshot checksum verification is additive on top).
016 is needs-rework, not needs-replan — its core mechanism was verified sound — so the
manifest format is close, and freezing the two interface requirements above removes the
risk that 015-e's wait produces a mismatch anyway.

**CANON lens.** None directly; the frozen manifest contract carries 016's own CANON
posture (fail-loud checksums, no placeholder metrics) forward unchanged.

---

## Ready-to-append YAML (coordinator renumbers AD-B1..B3 → next sequential ids, appends serially)

```yaml
  - id: AD-B1
    date: 2026-07-06
    title: "Item 015 Q1 ruled: 'the veto logic' = the deterministic evaluation floor (rules.ts contingency defaults + confidence.types.ts evaluation functions), checksummed as a floor manifest; the literal veto function is future graduated-autonomy work and must register in the same manifest when built"
    status: accepted
    context: >
      Pipeline item 20260702-015 source AC4 requires a floor-integrity boot
      checksum of "ACTION_TYPE_DEFAULTS and the veto logic" (CANON Std-6
      tie-in), but grep finds zero 'veto' hits in packages/**/*.ts. Traced:
      the term comes from docs/future/sylphie-autonomous-cognition-research.md
      §4.3 — a FUTURE graduated-autonomy component ("pure function of the
      hardcoded rules and the present drive vector... write-protected from
      everything, the same immutability CANON Standard 6 gives the evaluation
      function"), imported today-tense by
      docs/future/sylphie-persistence-migration-plan.md §5 invariant 6. No
      veto function exists because Partial/Full autonomy stages are unbuilt.
    decision: >
      "The veto logic" for 015-f resolves to the deterministic evaluation
      floor as it exists today: ALL exported units of (1)
      packages/drive-engine/src/constants/rules.ts (ACTION_TYPE_DEFAULTS:80,
      OUTCOME_DEFAULTS:205, METADATA_SCALED_ACTION_TYPES:185,
      computeDefaultAffect:229) and (2)
      packages/shared/src/types/confidence.types.ts (computeConfidence:107
      incl. the Std-3 0.60 ceiling clamp, CONFIDENCE_THRESHOLDS:58,
      applyGuardianWeight:146 — the Std-5 x2/x3 multiplier,
      DEFAULT_DECAY_RATES:79, qualifiesForGraduation:174,
      qualifiesForDemotion:191). 015-f checksums a floor MANIFEST (per-unit
      sha256 over stable serialization: canonical JSON for constants,
      Function.prototype.toString for pure functions, plus a composite hash)
      against a committed, generated, runtime-immutable expected-checksum
      artifact regenerated only by an explicit yarn floor:stamp step — never
      stored in any DB the runtime can write. Standing constraint: the future
      veto function must register in this manifest before any
      Partial-autonomy stage activates.
    rationale: >
      Both candidate answers (confidence-ceiling enforcement, guardian
      multiplier) are floor units — the fork was false; the invariant's
      purpose ("the immutable floor must be verifiably the floor") covers the
      contingencies the veto will be computed FROM plus the evaluation
      function Std-6 names. confidence.types.ts's own header already declares
      Std-6 write-protection, making it the canonical second module. An
      expected checksum the system could update would let it re-baseline its
      own floor — hence committed-artifact placement.
    alternatives:
      - option: "Checksum only ACTION_TYPE_DEFAULTS (015-f as staged)"
        rejected_because: "Leaves the Std-3 ceiling and Std-5 multiplier — the evaluation floor proper — unverified; source AC4 stays permanently unsatisfiable."
      - option: "Build a veto function now to have something to checksum"
        rejected_because: "Graduated autonomy is unbuilt future work; a veto with no tensor-led stage is theater. Revisit at Partial-autonomy planning."
    consequences: >
      015-f retitled/rescoped to the floor manifest; ACs extended to every
      registered unit with FloorChecksumMismatchError naming the failed unit;
      new AC that the expected-checksum artifact has no runtime write path.
      Source AC4 becomes satisfiable and closes with 015-f. Build-form
      subtlety flagged: function toString hashes are stable only within one
      build form; the stamp step must run against the form the boot check
      runs in.
    canon: "Implements Std-6 verification; transitively guards Std-3 ceiling and Std-5 multiplier as data. Expected-checksum must stay runtime-immutable or the check violates the standard it enforces."
    evidence:
      - packages/drive-engine/src/constants/rules.ts:80
      - packages/shared/src/types/confidence.types.ts:9
      - packages/shared/src/types/confidence.types.ts:111
      - packages/shared/src/types/confidence.types.ts:150
      - docs/future/sylphie-autonomous-cognition-research.md:108
      - docs/future/sylphie-persistence-migration-plan.md:119
    supersedes: null

  - id: AD-B2
    date: 2026-07-06
    title: "Item 015 Q2 ruled: boot on a recognized-but-pending migration REFUSES and requires manual --confirm apply; fresh-EMPTY stores bootstrap-stamp to current; unstamped-with-data refuses; no auto-apply ever"
    status: accepted
    context: >
      015-c AC3 was staged as "pick one behavior during build" for the boot
      guard's handling of a recognized-but-not-yet-applied migration —
      auto-apply via the 015-a runner vs refuse-and-require-manual. Opus
      verify correctly flagged this as a production-DB-safety decision that
      must not be a build-time coin-flip: auto-apply risks accidental live
      schema change on every deploy; blanket refusal risks fresh-environment
      boot deadlock.
    decision: >
      Three-state guard per store: (1) stamped current -> boot; (2) stamped
      behind real data -> REFUSE with SchemaVersionPendingError naming store,
      found version, target version, and the exact yarn
      migrate:<name>:confirm command, exiting non-zero before serving; (3a)
      unstamped AND empty of data (per-store emptiness definition is ticket
      work) -> bootstrap-stamp to current version at boot (initialization,
      not migration — resolves the fresh-env deadlock); (3b) unstamped with
      data present -> refuse, directing to the manual v1 backfill. No
      auto-apply path and no env escape hatch.
    rationale: >
      The house convention is explicit-confirm everywhere (db-change-safety
      house convention; migrations 001/002 dry-run/--confirm pairs,
      package.json:37-44; PR #86 rolled out migrate->deploy as a manual
      same-window op). Least privilege makes auto-apply structurally wrong:
      the app boots as sylphie_app, grant-denied on privileged surfaces per
      AD-0052, while migrations perform DDL as sylphie_admin — auto-apply
      would ship admin credentials into the request-serving runtime, exactly
      what AD-0051 refused. Std-6: schema change to the stores holding the
      evaluation substrate stays human-confirmed, outside the autonomous
      loop. Prisma parity: migrate deploy is an explicit step there too. The
      bootstrap-stamp carve-out needs only runtime-level writes (metadata
      node/row, no DDL).
    alternatives:
      - option: "Auto-apply pending migrations at boot via the 015-a runner"
        rejected_because: "Implicit --confirm on every deploy; requires admin credentials in the runtime (contra AD-0051/0052); breaks the repo-wide explicit-confirm DB posture. Revisit only if a separate privileged migration sidecar/deploy-step runner is ever chartered."
      - option: "Refuse always, including fresh environments"
        rejected_because: "Deadlocks every new compose/Railway env on a chicken-and-egg stamp; the empty-store bootstrap-stamp is initialization, not migration, and carries none of the auto-apply risk."
    consequences: >
      015-c AC3 rewritten to the refuse behavior; new ACs for fresh-empty
      bootstrap-stamp (idempotent across double-boot) and
      unstamped-with-data refusal; the staged open_question closes. Deploys
      carrying a pending migration halt until manually applied — the
      existing migrate+deploy same-window discipline, now loudly enforced.
      Build-watch: the :SchemaVersion write (migration AND bootstrap paths)
      must satisfy the WKG provenance guard — explicit provenance stamp or a
      deliberate exempt path, as an AC on 015-b.
    canon: "Aligns with Std-6 and the AD-0051/0052 least-privilege seam; keeps schema change human-confirmed outside the autonomous loop. No tension."
    evidence:
      - pipeline/policies/db-change-safety.md:40
      - package.json:37
      - docs/decisions/architect-log.yaml (AD-0051, AD-0052)
      - apps/sylphie/src/services/wkg-bootstrap.service.ts
    supersedes: null

  - id: AD-B3
    date: 2026-07-06
    title: "Item 015 Q3 ruled: split-and-proceed — 015-a/b/c/d/f queue now; 015-e stays parked until 016-a's snapshot manifest LANDS in main; manifest must expose per-file sha256 checksums + top-level schema_version/tensor_arch_version (frozen interface)"
    status: accepted
    context: >
      015-e (checksum verification against the snapshot manifest) hard-
      depends on the manifest format from pipeline item 20260702-016
      (snapshot/tested-restore), which sits at needs-rework in planning with
      three fixable verify gaps plus its own unresolved architect question
      (drive-engine quiesce handshake vs MVCC-consistent pg_dump). The
      source item warned 015 and 016 "touch the same manifest code — run
      sequentially."
    decision: >
      Proceed now with 015-a -> 015-b -> {015-c -> 015-f; 015-d} under the
      AD-B1/AD-B2 rulings — all five are fork-free and code-disjoint from
      016. 015-e stays parked (not queued) until 016 ticket -a is MERGED
      with its manifest format. Binding interface contract on 016-a so 015-e
      is buildable: manifest.json exposes a per-dump-file sha256 for every
      snapshot artifact, and top-level schema_version + tensor_arch_version
      keys in the same manifest.json (observability-spec §1 shape; resolves
      016-verify gap 3; tensor_manifest.json may remain as the tensor-side
      detail file). Recommended order: 015-a/b first, 016 plan-rework in
      parallel, 016-a after 015-b lands so the manifest reads a real stamp
      instead of a placeholder. NOT ruled here: 016's quiesce-handshake fork
      — a separate architect ruling required before 016-a builds.
    rationale: >
      015's dependency on 016 was always scoped to one leaf invariant;
      parking a P0 epic on its one blocked ticket inverts the source's own
      priority (silent schema drift is the live compounding risk; manifest
      checksum verification is additive on top). The sequential-run warning
      applies only to manifest-touching code, which within 015 is only
      015-e. Freezing the two manifest requirements now removes the risk
      that the wait still produces an interface mismatch.
    alternatives:
      - option: "Park all of 015 until 016 lands"
        rejected_because: "Blocks the P0 anti-drift mechanism on an additive verification leaf; no shared code justifies it outside 015-e."
      - option: "Guess a manifest shape and build 015-e now"
        rejected_because: "Rework-guaranteed; 016 is needs-rework not needs-replan, so the real format is close."
    consequences: >
      Coordinator: move 015 out of replan with the rewritten plan
      (015-a/b/c/d/f to refine/queue; 015-e explicitly parked with its
      unblock condition recorded); carry the frozen manifest-interface
      contract into 016's reworked plan as hard ACs on 016-a; schedule the
      016 quiesce-handshake architect ruling before 016-a is queued.
    canon: "None directly; the frozen manifest contract carries 016's fail-loud/no-placeholder CANON posture forward unchanged."
    evidence:
      - pipeline/replan/20260702-015-feature-schema-versioning-migration-framework-an/plan.md:86
      - pipeline/planning/20260702-016-feature-coordinated-sylphie-snapshot-tested-rest/plan.md:121
      - pipeline/planning/20260702-016-feature-coordinated-sylphie-snapshot-tested-rest/verify.md:11
      - docs/future/sylphie-persistence-migration-plan.md:34
    supersedes: null
```

## What I'd verify next
- 015-f build spike: confirm `Function.prototype.toString()` stability under the actual
  deploy build form (tsx source vs compiled dist) before finalizing the stamping step.
- Per-store "empty" definitions for the bootstrap-stamp carve-out (Neo4j non-metadata node
  count; Timescale `events` row count) — small but must be exact.
- Schedule the 016 quiesce-handshake ruling (drive isolation design; consult `drive`/`ashby`).
