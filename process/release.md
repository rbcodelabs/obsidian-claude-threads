# Release Process

## Overview

1. Merge all feature/fix PRs into main
2. Create a release worktree, bump versions, regenerate screenshots
3. Push PR → merge → push tag
4. GitHub Actions auto-builds and publishes the release
5. Post "Shipped in" comments, archive completed threads

---

## Step 1 — Merge Feature PRs

Use squash merges. Order: smallest / most isolated first, largest / most risky last.

```bash
gh pr merge <number> --repo rbcodelabs/obsidian-claude-threads --squash --delete-branch
git -C ~/projects/obsidian-claude-threads pull origin main
```

---

## Step 2 — Create Release Worktree

```bash
git -C ~/projects/obsidian-claude-threads pull origin main
git -C ~/projects/obsidian-claude-threads worktree add .claude/worktrees/chore/vX.Y.Z-release -b chore/vX.Y.Z-release
```

---

## Step 3 — Bump Versions

Edit `manifest.json` and `package.json` — update `"version"` to the new value.

**Do not manually edit `versions.json`** — the release GitHub Action prepends the new entry automatically when the tag is pushed.

Also update the README version badge:
```
![Version](https://img.shields.io/badge/version-X.Y.Z-blue)
```

---

## Step 4 — Regenerate Screenshots

```bash
cd <release-worktree>
npm run test:screenshots:update
```

This rebuilds the harness, runs Playwright with `--update-snapshots`, and copies PNGs to `docs/`.

---

## Step 5 — Quality Gate, Commit, Push, PR

```bash
npx tsc --noEmit && npm test && npm run test:screenshots

git add manifest.json package.json README.md docs/ test/screenshots/snapshots/
git commit -m "chore: bump version to vX.Y.Z"
git push -u origin chore/vX.Y.Z-release

gh pr create --title "chore: bump version to vX.Y.Z" ...
```

---

## Step 6 — Merge PR, Then Tag

```bash
gh pr merge <number> --squash --delete-branch
git -C ~/projects/obsidian-claude-threads pull origin main

git -C ~/projects/obsidian-claude-threads tag "vX.Y.Z"
git -C ~/projects/obsidian-claude-threads push origin "vX.Y.Z"
```

---

## Step 7 — GitHub Actions Auto-Publishes

Pushing the tag triggers `.github/workflows/release.yml`, which:
- Verifies `manifest.json` version matches the tag (fails fast if not)
- Runs `npm run build`
- Prepends the new entry to `versions.json`
- Creates the GitHub release with `dist/main.js`, `dist/styles.css`, `manifest.json`, `versions.json`

Verify it appeared:
```bash
gh release view "vX.Y.Z" --repo rbcodelabs/obsidian-claude-threads
```

---

## Step 8 — Update Release Notes

The auto-generated notes just say "Auto-generated release assets." Replace them:

```bash
gh release edit "vX.Y.Z" --repo rbcodelabs/obsidian-claude-threads --notes "..."
```

---

## Step 9 — PR Hygiene

Post a "Shipped in" comment on every feature/fix PR included in the release:

```bash
gh pr comment <number> --repo rbcodelabs/obsidian-claude-threads \
  --body "Shipped in [vX.Y.Z](https://github.com/rbcodelabs/obsidian-claude-threads/releases/tag/vX.Y.Z)."
```

Skip version-bump PRs (`chore: bump version`) and release PRs (`release: vX.Y.Z`).

---

## Step 10 — Thread Hygiene

Archive any Claude Threads session used to build PRs included in this release.

To find which thread opened a given PR, call `obsidian_list_threads` — each thread includes `prUrl` if a PR was opened during it. Match `prUrl` to the PR URL and archive:

```typescript
obsidian_archive_thread({ threadId: "<id>" })
```

The current thread cannot archive itself — tell the user to archive it when the session is done.

---

## Step 11 — Validate via BRAT

Do **not** copy build artifacts to the vault manually. Tell the user:
> Settings → BRAT → Update all beta plugins
