# PR Guidelines — obsidian-claude-threads

## Commands

| Task | Command |
|---|---|
| Type-check | `npx tsc --noEmit` |
| Unit tests | `pnpm test` |
| Screenshots (desktop) | `pnpm test:screenshots` |
| Update screenshots | `pnpm test:screenshots:update` |
| Build | `pnpm build` |

## Coverage Requirements

- All existing tests must pass — do not skip or delete tests
- New unit tests for any new utility functions added
- Screenshot tests cover desktop views only; mobile changes verified manually on device
- **Pure-function tests are not sufficient coverage for a behavior change in stateful,
  callback-driven code** (`ThreadManager`, `ClaudeSession`, anything wired through
  `SessionCallbacks`). If a fix extracts pure helpers (e.g. a regex matcher, a
  counter/cap check) out of a callback handler, testing only the helpers in
  isolation does NOT verify the fix — it verifies arithmetic. There must also be
  an integration test that drives the actual callback (e.g. a mocked
  `ClaudeSession.run()` invoking `onError`/`onDone`/`onPlanReady`) and asserts on
  real `ThreadManager` state/events: status transitions, emitted events, and any
  side effects (queued-message draining, resumed session id, retry counts).
  This bit us once already: a fix's "8 new tests" were all pure-function tests
  and never exercised the `onError` wiring they were meant to protect — see
  `test/integration/transport-error-recovery.test.ts` for the corrected shape,
  which also caught a real bug (a misleading prompt preamble) that the
  pure-function tests could never have found.

## Visual Verification

Whenever any UI file is touched, verify at these viewports before opening a PR:

- **Desktop:** 1280x800 (Playwright screenshots cover this automatically)
- **Mobile:** 390x844 (iPhone 14 portrait) — manual verification on device or Obsidian mobile simulator
- **Mobile SE:** 375x667 (iPhone SE) — verify no overflow on narrow screen when touching mobile CSS

For each viewport, confirm:
- [ ] Layout is not broken (no overflow, no collapsed sections)
- [ ] Interactive elements are reachable and usable (44px minimum tap targets)
- [ ] No visual regressions from the diff

## Docs Location

User-facing docs live in `docs/` and `README.md`. Update any doc page related to changed features.

## Screenshot Tooling

Run `pnpm test:screenshots:update` after any desktop UI change to regenerate committed screenshots. Do NOT update screenshots for mobile-only CSS changes (the Playwright tests run against the desktop view).

## Project-Specific Gates

- `npx tsc --noEmit` must be clean (strict mode, no errors)
- All Vitest unit tests must pass: `pnpm test`
- Playwright screenshot tests must not regress: `pnpm test:screenshots`
- For mobile-only changes: screenshot tests still run to confirm desktop is unaffected
- Build must succeed: `pnpm build`
- Never run `git stash` in this repo — it's one stack shared across every worktree
  and can collide with an unrelated stash left by a different worktree/session.
  Blocked by a `.claude/settings.json` PreToolUse hook; use a scratch
  `git worktree add /tmp/scratch <ref>` for any temporary/comparison checkout.
  See "Never Use `git stash` in a Worktree" in `process/development.md`.

## Final PR Checklist

Present this as a completed checklist before opening any PR. Every item is mandatory — do not open a PR until all are checked:

- [ ] `npx tsc --noEmit` — no errors
- [ ] `pnpm test` — all passing, new tests written for new logic
- [ ] `pnpm test:screenshots` — no regressions
- [ ] `pnpm build` — clean build
- [ ] **README.md / docs/ updated** — any new user-facing behavior or UI change is documented; if you touched a feature, re-read the relevant README section and update it
- [ ] Screenshots regenerated (`pnpm test:screenshots:update`) if desktop UI changed
- [ ] PR title and description explain the *why*, not just the *what*
