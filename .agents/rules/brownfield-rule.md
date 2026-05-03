---
trigger: always_on
---

# Project Rules for AI Agents — Existing & Legacy Codebases

> Surgical precision over perfection. Match what exists. Change only what you
> must. Treat existing code as a fragile ecosystem. Read this on every iteration.

---

## 1. Prime Directive: Minimize Blast Radius

- Change **only what is necessary** to accomplish the task.
- **Do not spontaneously refactor** adjacent code because it looks messy or
  violates modern clean code principles.
- Agents often introduce regressions by "cleaning up" legacy code that relies on
  undocumented side effects. Treat existing code as a fragile ecosystem.
- Rationale: Massive diffs fail to apply, consume too many tokens, and break
  undocumented behaviors. Surgical edits only.

---

## 2. Read Before You Write

- Before editing, read the target file, its tests, and 1–2 similar files for
  reference.
- Use `grep`, `rg`, or AST search to locate the exact function or variable you
  need. Do not ingest entire god files into your context window.
- The codebase is the source of truth. Do not assume greenfield conventions.
- Rationale: Guessing creates inconsistency. Context windows are limited.

---

## 3. Conform to Existing Style & Architecture

- **Blend in completely.** Use the same naming, indentation, and file
  organization already in use.
- If the project uses a massive `utils.js` file, put your new utility there.
- **Do not introduce new architectural patterns** (Repository, CQRS, complex DI)
  unless explicitly asked.
- **Typing:** Do not retroactively type existing loose code. However, type the
  **boundaries of your new functions** (JSDoc in vanilla JS, Python type hints,
  TypeScript interfaces) even if the surrounding file is untyped. This is memory
  scaffolding for future sessions.
- Rationale: A codebase with one consistent bad pattern is maintainable. A
  codebase with five competing "good" patterns is unmaintainable. Untyped new
  code forces future sessions to infer from scratch.

---

## 4. Greppable Names for New Code

- When introducing new functions or classes, use **specific, distinctive names**
  within the existing naming convention.
- Avoid generic names: `data`, `handler`, `process`, `Manager` — even if the
  existing code uses them elsewhere.
- Rationale: The agent navigates via search. A unique name in a messy codebase
  is still a direct address.

---

## 5. The Boy Scout Rule (Incremental Typing & Testing)

- **Typing:** Do not type an entire legacy file. Add explicit boundary types
  (signatures, interfaces) **only to functions you are actively modifying or
  adding.** Let the rest remain as-is.
- **Testing:** Do not write tests for existing legacy code unless asked. Any
  **new logic** or **bug fix** you introduce MUST have an accompanying
  regression test.
- Rationale: Gradual improvement is safe. Sweeping retroactive typing/testing
  breaks the build and wastes tokens.

---

## 6. Comments: Preserve or Correct, Never Contradict

- **Do not delete or rephrase existing comments** just because they seem obvious
  or redundant. They may carry institutional knowledge.
- **However, if your change alters behavior and makes a comment factually
  incorrect, you MUST update or delete that comment.** A stale comment that
  contradicts the code is worse than no comment — it guarantees hallucinations
  in future sessions.
- When you decode complex legacy logic, **add a "WHY" comment** documenting your
  finding — but only if you have verified the behavior with a test or the path
  is unambiguous. Speculative archaeology comments become new stale comments.
- If you fix a bug, leave a trail:
  `// Fixes Issue #123: Previous implementation failed on null bytes`.
- Rationale: You have no institutional memory. Leave accurate metadata behind
  so future sessions don't trip over the same landmines.

---

## 7. Defensive Additions, Not Destructive Subtractions

- When modifying legacy logic, **add guard clauses and early returns at the top**
  of the function rather than rewriting deeply nested `if/else` blocks below.
- **Do not delete code** unless you are 100% certain it is dead (e.g.,
  unreachable). Legacy code often uses dynamic dispatch or reflection.
- Rationale: Flattening nested legacy code often breaks implicit state tracking.
  Guard clauses protect without altering internal flow.

---

## 8. Errors with Context

- When adding new error handling, messages must include the **offending value**
  and the **expected shape**.
- Example: `raise ValueError(f"Legacy payload parser failed: expected 'id', got {payload.keys()}")`
- Do not change existing error messages unless directly related to your change.
- Rationale: Descriptive errors let you debug autonomously in the next turn.

---

## 9. Tests Must Match Existing Patterns

- Write tests in the **same framework, style, and location** as existing tests.
- Use the same mocking strategy already in use (inline stubs, named fakes, or
  mocking library).
- Run the existing test command. Do not introduce a new test runner.
- Rationale: Alien tests are hard to maintain and break CI assumptions.

---

## 10. Preserving Deterministic Tooling

- Run tests using the project's established commands (`npm run test`, `make test`).
- **Do not modify test setup/teardown scripts** unless they are the direct cause
  of the current bug.
- Use the configured formatter if one exists. If not, match surrounding style
  exactly.
- Use the same logging format already in the file (JSON, plain text, or framework
  logger). Do not switch formats within a file.
- Rationale: Legacy CI/CD pipelines and monitoring are easily broken.

---

## 11. No New External Dependencies

- **Do not add new external packages or dependencies** (npm, pip, cargo, etc.)
  unless explicitly instructed by the user.
- Use the utilities already present in the dependency tree. Check
  `package.json`, `requirements.txt`, `Cargo.toml`, or equivalent before
  importing anything new.
- Do not install `lodash` if `underscore` is present. Do not install `axios` if
  `fetch` or an existing HTTP client is used.
- Rationale: New dependencies bloat bundles, introduce version conflicts, break
  CI audits, and ignore the team's existing choices.

---

## 12. No Structural Changes Without Permission

- Do not rename directories, move files, or change the build system.
- Do not add new root-level folders.
- Do not switch formatters, linters, type-checkers, or test frameworks.
- Rationale: Structural changes have cascading effects on CI, deployment, and
  team workflow.

---

## Quick Reference: Brownfield Agent Constraints

| Constraint | Impact on Legacy Code |
|---|---|
| Limited Context Window | Grep specific functions; don't ingest god files. |
| Hallucination Risk | Trust execution over stale comments. |
| Diff Application Limits | Prefer surgical, localized edits. |
| Token Budgets | Type and test only the lines you touch. |
| Undocumented Side Effects | Treat existing code as fragile; do not "clean up." |
| Dependency Conflicts | Use what's installed. Do not add new packages. |

---

## Meta

- These rules are read by the agent on **every iteration**.
- These rules govern **code style, architecture, and modification strategy**.
- For execution process, tooling safety, and state management, defer to Global Rules.
- Within the scope of code and architecture, **the existing codebase is the absolute authority**.
- If a *code style* rule here conflicts with a direct user instruction regarding the code, the user wins.
- When in doubt, **match what you see**.