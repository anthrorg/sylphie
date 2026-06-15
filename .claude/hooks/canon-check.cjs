// Hook: CANON compliance check before session completion.
// Runs on Stop — spawns claude (Sonnet) to verify all code changes
// comply with Sylphie's CANON principles. Blocks completion if violations found.

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const gitOpts = { encoding: "utf-8", timeout: 10000, maxBuffer: 1024 * 1024, cwd: projectDir };

let data = "";
process.stdin.on("data", (chunk) => (data += chunk));
process.stdin.on("end", () => {
  try {
    // Collect changed TypeScript files under ANY src/ directory. This is a
    // monorepo (packages/*/src, apps/*/src) with NO root-level src/, so the old
    // 'src/**/*.ts' pathspec — anchored at a nonexistent root src/ — matched
    // ZERO files and the gate silently passed (exit 0) on every change. Match
    // all changed *.ts/*.tsx, then keep those that live under a src/ dir.
    let srcFiles = [];
    try {
      const names = execSync(
        "git diff HEAD --name-only -- '*.ts' '*.tsx'",
        gitOpts
      ).trim();
      srcFiles = names
        ? names
            .split("\n")
            .filter((f) => f.includes("/src/") || f.startsWith("src/"))
        : [];
    } catch {
      process.exit(0);
    }

    if (srcFiles.length === 0) {
      process.exit(0);
    }

    let diff = "";
    try {
      diff = execSync(
        `git diff HEAD -- ${srcFiles.map((f) => `"${f}"`).join(" ")}`,
        gitOpts
      ).trim();
    } catch {
      process.exit(0);
    }

    if (!diff) {
      process.exit(0);
    }

    // Also check untracked new .ts/.tsx files in src/
    let newFiles = "";
    try {
      const untrackedList = execSync(
        "git ls-files --others --exclude-standard -- '*.ts' '*.tsx'",
        { ...gitOpts, timeout: 5000 }
      ).trim();

      if (untrackedList) {
        const tsFiles = untrackedList
          .split("\n")
          .filter(
            (f) =>
              (f.endsWith(".ts") || f.endsWith(".tsx")) &&
              (f.includes("/src/") || f.startsWith("src/"))
          );
        for (const f of tsFiles) {
          try {
            const content = execSync(`cat "${f}"`, {
              ...gitOpts,
              timeout: 5000,
            });
            newFiles += `\n--- NEW FILE: ${f} ---\n${content}\n`;
          } catch {
            // skip unreadable files
          }
        }
      }
    } catch {
      // skip
    }

    const fullDiff = diff + newFiles;

    const maxChars = 50000;
    const truncatedDiff =
      fullDiff.length > maxChars
        ? fullDiff.slice(0, maxChars) + "\n\n[TRUNCATED — diff too large]"
        : fullDiff;

    // CANON source of truth is sylphie-tech-spec.md (§9 "The Six Immutable
    // Standards", §3.2 "Drive Isolation"). wiki/CANON.md never existed, so the
    // old Read found nothing and the gate silently passed. Fail loud if the
    // real source is missing rather than green-light an unchecked diff.
    const canonPath = path.join(projectDir, "sylphie-tech-spec.md");
    if (!fs.existsSync(canonPath)) {
      process.stderr.write(
        "CANON CHECK: cannot run — CANON source not found at " +
          canonPath +
          ". The Six Immutable Standards gate has no source to check against; " +
          "failing loud (Standard 6 must not silently pass).\n"
      );
      process.exit(2);
    }

    const prompt = `You are the CANON compliance checker for the Sylphie project.

Read sylphie-tech-spec.md using the Read tool — specifically section "9. Constraint Canon (The Six Immutable Standards)" and section "3.2 Drive Isolation (CANON Standard 6)". Then review the code diff below for violations.

CHECK FOR THESE SPECIFIC VIOLATIONS:

1. DRIVE ISOLATION BREACH: Any code that directly writes to drive values, modifies the evaluation function, or bypasses the isolated drive process. The drive computation process is the sole authority on drive pressure values.

2. THEATER VIOLATION: Any code that produces emotional expressions without checking actual drive state. Output must correlate with real drive values.

3. SELF-MODIFICATION OF EVALUATION: Any code that modifies confidence update rules, prediction error computation, or drive relief assignment. These are write-protected (Immutable Standard 6).

4. NON-CONTINGENT REINFORCEMENT / MISSING ACTION ID: Any code that provides reinforcement or emits an outcome that does not trace to a specific actionId (Immutable Standard 2: Action ID Required).

5. CONFIDENCE CEILING BYPASS: Any code that sets knowledge confidence above 0.60 without a successful retrieval-and-use event (Immutable Standard 3).

6. SUBSYSTEM BOUNDARY VIOLATIONS: Any code where subsystems directly access each other's internals instead of communicating through TimescaleDB events or WKG.

7. PROVENANCE MISSING: Any code that creates nodes or edges without a provenance_type (Immutable Standard 4: Provenance Required). Valid categories: SENSOR, GUARDIAN, INFERENCE, GUARDIAN_APPROVED_INFERENCE, TAUGHT_PROCEDURE.

8. KG CONTAMINATION: Any code that creates edges between Self KG and Other KG, or between either and the WKG. These are isolated stores.

RESPOND WITH EXACTLY ONE OF:

If NO violations found:
CANON_CHECK: PASS

If violations found:
CANON_CHECK: FAIL
- [file:line] Description of violation and which CANON section it violates

Nothing else. No preamble, no explanation beyond the violation list.

CODE DIFF TO CHECK:
${truncatedDiff}`;

    let result = "";
    try {
      result = execSync(
        `claude -p --model sonnet --allowedTools "Read,Grep,Glob" --no-session-persistence`,
        {
          input: prompt,
          encoding: "utf-8",
          timeout: 120000,
          maxBuffer: 1024 * 512,
          stdio: ["pipe", "pipe", "pipe"],
          cwd: projectDir,
        }
      ).trim();
    } catch (e) {
      process.stderr.write(
        "CANON CHECK: Could not run compliance check (claude CLI error). Proceeding with warning.\n"
      );
      if (e.stderr) process.stderr.write(e.stderr.toString());
      process.exit(0);
    }

    if (result.includes("CANON_CHECK: FAIL")) {
      process.stderr.write(
        "CANON COMPLIANCE VIOLATION DETECTED\n\n" +
          result +
          "\n\nFix the violations above before completing. The CANON is the single source of truth.\n"
      );
      process.exit(2);
    }

    if (result.includes("CANON_CHECK: PASS")) {
      process.exit(0);
    }

    process.stderr.write(
      "CANON CHECK: Unexpected response from compliance checker (no PASS/FAIL verdict). " +
        "Failing loud rather than silently passing:\n" +
        result.slice(0, 500) +
        "\n"
    );
    process.exit(2);
  } catch (e) {
    process.stderr.write("CANON CHECK: Hook error — " + e.message + "\n");
    process.exit(0);
  }
});
