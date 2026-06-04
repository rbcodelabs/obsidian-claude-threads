# Claude Code — obsidian-claude-threads

An Obsidian plugin that runs multi-threaded Claude Code sessions inside the vault, with an MCP server so agents can coordinate across threads.

## Process Docs

Full step-by-step guides live in `process/` (also available as an Obsidian vault bridge):

| Guide | Contents |
|---|---|
| [`process/development.md`](process/development.md) | Worktree workflow, quality gate, unit tests, screenshot tests |
| [`process/release.md`](process/release.md) | Full release checklist — merge PRs, bump version, tag, auto-publish, PR comments, thread cleanup |
| [`process/architecture.md`](process/architecture.md) | Key files, Thread type fields, MCP serialization pattern, DispatchInput footer convention |

## Quick Reference

**Before any code change:** create a worktree — never edit the main checkout directly.

**Before every push:** `npx tsc --noEmit && npm test && npm run test:screenshots`

**After every release:** post "Shipped in vX.Y.Z" on each merged PR; archive threads whose `prUrl` matches a shipped PR via `obsidian_archive_thread`.

**Plugin type:** Obsidian desktop + mobile. Build with `npm run build`. Artifacts in `dist/`. Released via GitHub Actions on tag push — do not manually upload artifacts.
