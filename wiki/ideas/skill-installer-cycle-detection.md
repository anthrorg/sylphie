# Idea: Add Cycle Detection to Skill Installer Dependency Resolution

**Created:** 2026-04-13
**Status:** proposed

## Summary

The `SkillInstaller` in `packages/perception-service/cobeing/layer3_knowledge/skill_installer.py` (line 275) has a TODO for cycle detection when multiple packages are being installed. Without it, circular dependencies between skill packages could cause infinite loops or stack overflows during installation.

## Motivation

Skill packages can depend on other packages. If package A depends on B and B depends on A (directly or transitively), the installer will recurse indefinitely. As Sylphie learns more skills and the package graph grows, the probability of accidental cycles increases. A simple visited-set check during dependency resolution would prevent this.

## Subsystems Affected

- **perception-service** — `skill_installer.py` dependency resolution needs a visited set or topological sort.

## Open Questions

- Should cycle detection produce a hard error (abort installation) or a warning (skip the circular dependency)?
- Is topological sorting needed (install in dependency order), or is the current approach sufficient with just cycle detection added?
- Are there any existing test cases for multi-package installation that should be extended?
