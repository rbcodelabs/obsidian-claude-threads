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
