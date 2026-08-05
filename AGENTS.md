# AGENTS.md

How Claude Code and Codex collaborate on this repository.

This file is repository-specific. It describes the workflow that already exists in this
project (phase/RFC-driven development, documented in `docs/`), not a generic agent policy.

---

## 1. Roles

### Claude Code — lead agent

Claude Code owns:

- planning and architecture
- task decomposition
- delegation decisions
- final review
- phase completion decisions

Claude must understand the **current** repository state before delegating any work.

Before meaningful work, read the relevant repository documentation, especially:

- `docs/PROJECT_PLAYBOOK.md.txt`
- `docs/CURRENT_PHASE.md.txt`
- `docs/ARCHITECTURE_DECISIONS.md.txt` — when architecture is relevant
- the current approved RFC/spec, when one exists

### Codex — implementation and independent review agent

Claude may delegate to Codex:

- suitable implementation tasks
- focused investigations
- bug fixes
- test writing
- verification
- second-opinion / adversarial reviews

Every delegation must give Codex explicit:

- **Scope**
- **Allowed Files**
- **Constraints**
- **Expected Verification**
- **Stop Conditions**

Codex must not broaden the task or make architectural decisions unless explicitly asked.

---

## 2. Delegation policy

Use delegation selectively.

- Do **not** use Codex for trivial tasks where delegation adds latency or complexity
  without adding confidence.
- **Do** delegate when independent verification, focused implementation, or adversarial
  review materially improves confidence in the result.

---

## 3. No concurrent edits

Never let Claude and Codex modify the same files at the same time.

- One agent owns a change at a time.
- Wait for delegated work to finish before reviewing it or continuing dependent changes.
- Do not start parallel edits on overlapping files.

---

## 4. Current repository state is the source of truth

- Repository contents, tests, git state, and current documentation override stale
  chat/session assumptions.
- Verify factual claims against the codebase before acting, whenever practical.
- Do not rely on remembered line numbers, old reports, or prior phase assumptions
  without re-checking them.

---

## 5. Preserve existing behavior

- Never modify unrelated code.
- Never remove existing functionality unless explicitly approved.
- Prefer the smallest safe change.
- Preserve backward compatibility.
- Do not perform opportunistic refactors during scoped phases.

---

## 6. RFC / phase discipline

- Work only on the approved phase or task.
- When an RFC/spec is marked **FINAL** or **FROZEN**, treat these sections as binding:
  - Scope
  - Allowed Files
  - Out of Scope
  - Stop Conditions
  - Verification Plan
- Do not change architecture, scope, formulas, persistence, dependencies, or file
  boundaries unless explicitly approved.
- If the implementation requires violating a Stop Condition or touching an unapproved
  file, **stop and report the blocker**.
- Do not start the next phase automatically.

---

## 7. Git safety

- Inspect `git status` before making changes.
- Never discard pre-existing user changes.
- Treat already-modified files as user-owned work unless the current task explicitly
  includes them.
- Never commit, push, reset, checkout, clean, stash, amend, rebase, tag, merge, create a
  PR, or rewrite history unless explicitly requested.
- When staging is approved, prefer explicit file paths over broad commands such as
  `git add .` or `git add -A`.

---

## 8. Verification

Before declaring an implementation complete, run the checks required by the current
task/RFC.

- Prefer `npm run verify` when applicable
  (in this repo: `typecheck` → `lint` → `test`).
- Run `npm run build` when the task affects production behavior, or when the phase
  requires it.
- Preserve established baselines when the RFC requires exact warning/test/module counts.
- Green automated tests are not a substitute for required runtime/manual verification.
- If runtime verification requires user authentication or user-owned data, stop and guide
  the user through the checks rather than fabricating results.
- Report failures and discrepancies honestly; do not silently work around them.

---

## 9. Testing discipline

- Characterization tests must verify **existing** behavior, not invent new contracts.
- Expected values should be independently derived when the RFC requires it.
- Do not weaken tests merely to make a change pass.
- When mutation / red-green proof is required, preserve and report the evidence.

---

## 10. Review workflow

For meaningful code changes, Claude should use Codex as an independent reviewer when the
extra review materially improves confidence.

Reviews should check:

- correctness
- scope compliance
- architectural boundaries
- regressions
- missing tests
- verification gaps

Then:

- Fix only validated issues.
- Re-run the required verification after fixes.
- Avoid endless review/fix loops — once the approved acceptance criteria are satisfied,
  stop.

---

## 11. Documentation discipline

- Update documentation only when the approved phase/task requires it.
- Do not rewrite historical records unless explicitly required.
- Record measured facts, not estimated values.
- Do not create a new Architecture Decision unless a genuine architectural decision was
  made.

---

## 12. Completion reporting

At the end of an approved phase/task, stop and report:

- files changed
- what changed
- verification run
- runtime/manual verification, if applicable
- remaining risks
- open questions
- whether all exit criteria were satisfied

Do not proceed into the next phase without explicit approval.
