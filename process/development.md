# Development Workflow

## Worktree Workflow (Required)

Never edit files in the main checkout. Always work in a git worktree:

```bash
# 1. Create worktree on a new branch
git -C ~/projects/obsidian-claude-threads worktree add .claude/worktrees/<branch> -b <branch>

# 2. Make changes inside the worktree
# 3. Push branch, open PR — leave worktree in place until the PR merges
```

Branch naming conventions:
- `feat/<short-description>` — new features
- `fix/<short-description>` — bug fixes
- `chore/<description>` — version bumps, tooling, docs
- `docs/<description>` — documentation only

---

## Never Use `git stash` in a Worktree

`git stash` is a **single stack shared by every worktree of a repo** — it is not
per-worktree, even though it feels like it should be. This repo routinely has
10+ worktrees checked out at once (one per active thread/branch). Running
`git stash` in worktree A can `pop`/collide with an unrelated in-progress
stash left by worktree B's session, corrupting A's working tree with a merge
conflict on files A never touched.

This has actually happened (see the transport-error-recovery PR #283 follow-up
work): a session ran `git stash` to A/B-test a change against a prior commit,
which silently applied a stranger's leftover `stash@{0}` from a different
feature branch and produced a conflict on `package-lock.json`.

**A `.claude/settings.json` PreToolUse hook now blocks `git stash*` outright**
in this repo — it fails fast with a pointer to the correct alternative, so this
should be structurally prevented rather than relying on remembering not to.

**For any temporary/comparison checkout** (diffing behavior against a prior
commit, checking whether a bug pre-dates your change, etc.), use a scratch
worktree instead — it's fully isolated and cheap to throw away:

```bash
git worktree add /tmp/scratch-check <commit-or-branch>
# ...do the comparison...
git worktree remove /tmp/scratch-check --force
```

---

## Quality Gate (Before Every Push)

Run all three checks before pushing. The PostToolUse hook will remind you if you forget.

```bash
cd <worktree-path>
npx tsc --noEmit          # type-check (esbuild strips types silently — TSC catches the real errors)
npm test                  # unit tests via vitest
npm run test:screenshots  # Playwright screenshot tests (2 intentional skips are normal)
```

Pass criteria: zero type errors, all unit tests green, screenshot count unchanged (or new tests added for new UI).

---

## Test Vaults

For live integration testing, spin up an isolated Obsidian vault with the current plugin build:

```bash
npm run vault           # build + create test vault (first time)
npm run vault:update    # rebuild + re-copy dist into existing vault
npm run vault:open      # build + create + open in Obsidian
```

Each worktree branch gets its own vault at `~/.claude/test-vaults/ct-<branch-name>/`.
Vaults are pre-seeded with `Testing Notes.md` and `Branch Changes.md`.
Multiple test vaults can be open in separate Obsidian windows simultaneously.

**First open:** Obsidian will prompt to enable community plugins once per vault. Click "Turn off Restricted Mode."

**Iteration workflow:**
1. Make code changes in the worktree
2. Run `npm run vault:update` to rebuild and re-copy
3. In Obsidian, run **Reload app without saving** (Cmd+R) to pick up the new build

---

## Dev Builds in the Live Vault

Sometimes a feature needs to be tested in the user's real vault (`~/Documents/Personal/.obsidian/plugins/claude-threads/`) rather than a test vault.

**Rule: commit the work and push a branch (draft PR is fine) BEFORE copying a dev build into the live vault.** The installed plugin is overwritten by the next BRAT release update — an uncommitted dev build is the only copy of the work, and it silently evaporates.

This is not hypothetical: the footer model switcher was built, deployed to the live vault for testing, and never committed. The v0.15.2 release overwrote it, and it had to be rescued from a stale worktree's uncommitted diff (#217).

Checklist when deploying a dev build:
1. `git add` + `git commit` in the worktree
2. `git push -u origin <branch>` (open a draft PR if review isn't ready)
3. Then copy `dist/` into the live vault for testing

---

## Reloading the Plugin Safely

Reloading the plugin while agent threads are running kills them immediately.  Use the **"Reload plugin (safe)"** command (command palette) instead of toggling the plugin in Settings:

- **No active threads** → reloads immediately (same as toggling off/on)
- **Active threads present** → shows a modal listing the running threads with three options:
  - **Cancel** — dismiss, do nothing
  - **Interrupt & Reload** — sends interrupt to all threads and waits up to 30 s for clean shutdown before reloading
  - **Force Reload** — reloads immediately, killing all threads (same as the old behavior)

For unguarded reloads triggered by manifest edits (hot-reload) or toggling in Settings, `onunload()` provides a best-effort 10-second graceful shutdown: it interrupts all sessions and waits for them to drain before proceeding.

---

## Unit Tests

```bash
npm test
```

Located in `test/unit/`. Use vitest. Mock Obsidian APIs are in `test/mocks/`.

When adding a new MCP tool or modifying serialization logic, add a corresponding test file in `test/unit/`.

---

## Screenshot Tests

```bash
npm run test:screenshots          # verify snapshots unchanged
npm run test:screenshots:update   # regenerate snapshots (run before a release)
```

Located in `test/screenshots/`. Uses Playwright against a headless harness in `test/harness/`.
Snapshots are committed to `test/screenshots/snapshots/` and copied to `docs/*.png` on update.

The harness renders the plugin against mock data in `test/harness/fixtures.ts` — it cannot test flows that require a live Claude session (PTT, background tasks, etc.). Those are noted as intentional skips in the spec.

New UI states need both a fixture entry and a new test case in `test/screenshots/ui.spec.ts`.

### Harness entry points

Each top-level view that doesn't fit the main conversation harness gets its own
bundle + HTML page. To add one: create `test/harness/<name>-index.ts` (mount the
view against fixtures, expose it on `window`), a `<name>.html` (copy an existing
page, point `<script>` at `dist/<name>-bundle.js`, size `#app` for the view), and
add a `build()` block in `test/harness/esbuild.mjs`. Current pages:

| Page | Bundle | View |
|---|---|---|
| `index.html` | `bundle.js` | `ThreadsView` (conversation) |
| `skills.html` | `skills-bundle.js` | `SkillsManagerView` |
| `settings.html` | `settings-bundle.js` | settings tabs |
| `kanban.html` | `kanban-bundle.js` | `KanbanView` (status board + folder swimlanes) |

Running/awaiting state isn't stored on `Thread` — it lives in the
`ThreadManager`'s private `sessions` / `pendingPermissions` maps. The kanban
harness seeds those directly (see `kanban-index.ts`) to populate the Working and
Awaiting columns deterministically.
