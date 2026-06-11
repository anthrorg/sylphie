# Drive-Engine requisite-variety gap: no appraisal of hostile interlocutor text

**Status:** open · **Found:** 2026-06-11 (mythos, T8 live smoke) · **Owner:** drive + ashby · **Severity:** MEDIUM — T8 monitor is wired-and-evaluating but currently silent

The WS4 T8 mood-bleed monitor watches Anxiety/Sadness/Guilt for per-speaker negative-affect attribution. Live smoke (12 hostile messages from a non-guardian socket): the drive engine responded (totalPressure 1.873→2.0 saturation) but `dominantDrive` stayed "integrity" — **Anxiety/Guilt never moved**. Root cause in `packages/drive-engine/src/constants/rules.ts`: drive rules key on action-types/outcomes (ConversationalResponse, guardian_confirmation/correction); the only Guilt/negative-Anxiety paths are explicit guardian-feedback signals (:194-205). Hostile non-guardian text yields a generic ConversationalResponse — which grants Anxiety *relief*.

This is exactly ashby's predicted risk (T8 spec §6 risk-2, Ashby's Law): the regulator cannot register disturbances it has no variety for. The monitor is honestly blind, verified non-broken (zero exceptions, brackets opening/closing, MB0 zero false positives on benign corpus).

**Fix shape:** an interlocutor-sentiment → negative-affect appraisal rule in the drive engine (hostile/abusive text raises Anxiety + Guilt-adjacent pressure). Drive-rule design = `drive`/`skinner` domain with `ashby` on stability; CANON drive isolation applies (rule lives in the drive process). After it lands, re-run the T8 live smoke — the monitor should fire WARNING→CRITICAL per spec — and recalibrate T8's grouped constants against the real magnitudes.

Related: [[ws4-kickoff]], T8 spec `wiki/ws4-t8-mood-bleed-monitor-spec.md` §5.2/§6.
