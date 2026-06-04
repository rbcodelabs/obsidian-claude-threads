# Claude Code — obsidian-claude-threads

## Worktree Workflow (Required)

Never edit files in the main checkout. Always work in a git worktree:

```bash
# 1. Create worktree on a new branch
git -C ~/projects/obsidian-claude-threads worktree add .claude/worktrees/<branch> -b <branch>

# 2. Make changes inside the worktree
# 3. Push branch, open PR, leave worktree in place (do NOT delete it before the PR merges)
```

Branch naming conventions:
- `feat/<short-description>` — new features
- `fix/<short-description>` — bug fixes
- `chore/<description>` — version bumps, tooling, docs
- `docs/<description>` — documentation only

---

## Quality Gate (Before Every Push)

Run all three checks before pushing. The PostToolUse hook will remind you if you forget.

```bash
cd <worktree-path>
npx tsc --noEmit          # type-check (esbuild strips types silently — TSC catches the real errors)
npm test                  # 461 unit tests via vitest
npm run test:screenshots  # 18 Playwright screenshot tests (2 intentional skips are normal)
```

Pass criteria: zero type errors, all unit tests green, screenshot count unchanged (or new tests added for new UI).

---

## Testing

### Unit tests
```bash
npm test
```
Located in `test/unit/`. Use vitest. Mock Obsidian APIs are in `test/mocks/`.

### Screenshot tests
```bash
npm run test:screenshots          # verify snapshots unchanged
npm run test:screenshots:update   # regenerate snapshots (run before a release)
```
Located in `test/screenshots/`. Uses Playwright against a headless harness in `test/harness/`.
Snapshots are committed to `test/screenshots/snapshots/` and copied to `docs/*.png` on update.

The harness renders the plugin against mock data — it cannot test flows that require a live Claude session (PTT, background tasks, etc.). Those are noted as intentional skips in the spec.

---

## Release Process

### 1. Merge all feature/fix PRs first

Use squash merges. Keep the queue ordered smallest → largest.

### 2. Create a release worktree

```bash
git -C ~/projects/obsidian-claude-threads pull origin main
git -C ~/projects/obsidian-claude-threads worktree add .claude/worktrees/chore/vX.Y.Z-release -b chore/vX.Y.Z-release
```

### 3. Bump versions (manifest.json, package.json only)

Edit both files to the new version. **Do not manually edit `versions.json`** — the release GitHub Action handles it automatically when the tag is pushed.

```bash
# manifest.json — update "version"
# package.json  — update "version"
```

Also update the README version badge: `![Version](https://img.shields.io/badge/version-X.Y.Z-blue)`

### 4. Regenerate screenshots

```bash
cd <release-worktree>
npm run test:screenshots:update
```

This rebuilds the harness, runs Playwright with `--update-snapshots`, and copies PNGs to `docs/`.

### 5. Run quality gate, commit, push, open PR

```bash
npx tsc --noEmit && npm test && npm run test:screenshots

git add manifest.json package.json README.md docs/ test/screenshots/snapshots/
git commit -m "chore: bump version to vX.Y.Z"
git push -u origin chore/vX.Y.Z-release
gh pr create ...
```

### 6. Merge PR, then tag

```bash
gh pr merge <number> --squash --delete-branch
git -C ~/projects/obsidian-claude-threads pull origin main

git -C ~/projects/obsidian-claude-threads tag "vX.Y.Z"
git -C ~/projects/obsidian-claude-threads push origin "vX.Y.Z"
```

### 7. Release auto-publishes via GitHub Actions

Pushing the tag triggers `.github/workflows/release.yml`, which:
- Verifies `manifest.json` version matches the tag (fails fast if not)
- Runs `npm run build`
- Prepends the new entry to `versions.json`
- Creates the GitHub release with `dist/main.js`, `dist/styles.css`, `manifest.json`, `versions.json`

You do **not** need to manually create the release or upload artifacts. Just verify it appeared:

```bash
gh release view "vX.Y.Z" --repo rbcodelabs/obsidian-claude-threads
```

### 8. Update release notes

The auto-generated notes just say "Auto-generated release assets." Edit them:

```bash
gh release edit "vX.Y.Z" --repo rbcodelabs/obsidian-claude-threads --notes "..."
```

### 9. Validate via BRAT

Do **not** copy build artifacts to the vault manually. Tell the user to update via BRAT:
> Settings → BRAT → Update all beta plugins

---

## PR Hygiene

After every release, post a "Shipped in" comment on each merged feature/fix PR:

```bash
gh pr comment <number> --repo rbcodelabs/obsidian-claude-threads \
  --body "Shipped in [vX.Y.Z](https://github.com/rbcodelabs/obsidian-claude-threads/releases/tag/vX.Y.Z)."
```

Skip version-bump PRs (`chore: bump version`) and release PRs (`release: vX.Y.Z`) — they are the release, not shipped by it.

---

## Thread Hygiene

After a PR ships, archive any Claude Threads session that was used to build it:

```typescript
// MCP tool — use after confirming the PR is in a published release
obsidian_archive_thread({ threadId: "<id>" })
```

To find which thread opened a given PR:
1. Call `obsidian_list_threads` — each thread now includes `prUrl` if a PR was opened during it
2. Match `prUrl` to the PR URL directly — no need to read message history
3. Archive the matched thread

When finishing a release session, tell the user to archive the current thread (a thread cannot archive itself).

---

## Architecture Notes

### Key files
| File | Purpose |
|---|---|
| `src/main.ts` | Plugin entry point, MCP server wiring, thread serialization |
| `src/ThreadManager.ts` | Thread lifecycle, events, persistence coordination |
| `src/ThreadsView.ts` | Main conversation panel UI |
| `src/AgentDashboard.ts` | Agent dashboard sidebar panel |
| `src/KanbanView.ts` | Kanban board view |
| `src/ObsidianTools.ts` | All MCP tool definitions and TypeScript interfaces |
| `src/VaultPersistence.ts` | Vault note save/load/archive |
| `src/types.ts` | Shared TypeScript types (`Thread`, `ThreadStatus`, etc.) |
| `src/DispatchInput.ts` | Reusable dispatch textarea component |

### Thread type (`src/types.ts`)
Key fields on `Thread`:
- `id`, `title`, `status`, `messages` — core identity and content
- `prUrl?: string` — URL of the most recent GitHub PR opened in this session; surfaced in MCP snapshots
- `titleUserSet?: boolean` — prevents auto-titler from overwriting a user-renamed thread
- `noteFile?: string` — vault-relative path of the saved note; used by VaultPersistence to detect stale files after title changes
- `cwd?: string` — working directory for the Claude process; auto-repaired to nearest valid ancestor if the worktree is deleted

### MCP tools (`src/ObsidianTools.ts`)
The `ThreadSnapshot` interface defines what `obsidian_list_threads` and `obsidian_get_current_thread` return. When adding fields to `Thread`, also add them to `ThreadSnapshot` and both serializers in `main.ts` (`getThreadDetail` and `getAllThreads`).

### DispatchInput component
`DispatchInput` only renders the bottom footer row (attach button, mic button) when either `showCwdChip` or `appendFooterActions` is passed. Always pass `appendFooterActions: () => {}` if you want the footer layout without other chips.

### Screenshot harness
The harness (`test/harness/`) renders the plugin against fixture data without a live Obsidian or Claude process. Fixtures are in `test/harness/fixtures.ts`. New UI states need both a fixture entry and a new test case in `test/screenshots/ui.spec.ts` to be captured.
