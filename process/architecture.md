# Architecture Notes

## Key Files

| File | Purpose |
|---|---|
| `src/main.ts` | Plugin entry point, MCP server wiring, thread serialization for MCP tools |
| `src/SettingsTab.ts` | Settings panel (tabbed: General / Claude / Tools / Vault / Features / Remote) + key/secret modals |
| `src/ThreadManager.ts` | Thread lifecycle, events, persistence coordination |
| `src/ThreadsView.ts` | Main conversation panel UI |
| `src/AgentDashboard.ts` | Agent dashboard sidebar panel |
| `src/KanbanView.ts` | Kanban board view |
| `src/ObsidianTools.ts` | All MCP tool definitions and TypeScript interfaces |
| `src/VaultPersistence.ts` | Vault note save/load/archive |
| `src/types.ts` | Shared TypeScript types (`Thread`, `ThreadStatus`, etc.) |
| `src/DispatchInput.ts` | Reusable dispatch textarea component used across all panels |
| `src/slashCommands.ts` | Single source of truth for built-in slash commands, model aliases, and dispatch directive parsing |
| `src/Scheduler.ts` | Built-in scheduler for cron items and `/loop` recurrences, persisted in `settings.scheduledItems` |
| `src/statusLine.ts` | Pure parser for `statusLineCommand` output (JSON tags or legacy plaintext → `StatusTag[]`) + `derivePrUrl`/`resolveTagIcon`. No Obsidian/Node deps |
| `src/StatusLineService.ts` | Desktop-only service that polls `statusLineCommand` per thread cwd (coalesced, capped, cached, idle-paused) and writes `statusTags` + derived `prUrl`. See `docs/adr/0001-structured-status-line-tags.md` |

---

## Thread Type (`src/types.ts`)

Key fields worth knowing:

| Field | Notes |
|---|---|
| `prUrl?: string` | URL of the thread's GitHub PR. **Derived** by `StatusLineService` from `statusTags` (a `kind:'pr'` tag or `/pull/N` url) — no longer scanned from assistant prose. **Sticky**: only overwritten when a poll finds a PR, never cleared on absence, so the release archive-on-merge flow still matches after merge. Surfaced in `obsidian_list_threads` / `obsidian_get_current_thread`. |
| `statusTags?: StatusTag[]` | Context-footer pills for this thread, set by `StatusLineService` from the `statusLineCommand` output (JSON tags or legacy plaintext, see `src/statusLine.ts`). **Ephemeral** — stripped before persisting to data.json, re-derived each poll; `undefined` on mobile / no script. |
| `titleUserSet?: boolean` | When `true`, the auto-titler will not overwrite the thread's title. Set to `true` only when the user explicitly renames the thread (not on blur/escape with no change). |
| `noteFile?: string` | Vault-relative path of the saved vault note. Used by `VaultPersistence` to detect and delete stale files when the title changes. |
| `cwd?: string` | Working directory for the Claude process. Auto-repaired to the nearest valid ancestor if the original worktree path no longer exists. |
| `model?: string` | Per-thread model alias set via `/model` (fable, opus, sonnet, haiku). Falls back to the `defaultModel` setting, then the CLI default. |
| `goal?: string` | Persistent goal set via `/goal`. Injected into the appended system prompt every turn until cleared with `/goal clear`. |
| `rawLogPath?: string` | Vault-relative path to the thread's raw JSONL conversation log (`<vaultFolder>/logs/<thread_id>.jsonl`), written by `RawLogWriter` when the `saveRawLogs` setting is on. Keyed by the stable thread UUID so it never orphans on rename. Read back via the `obsidian_get_thread_log` MCP tool. |

---

## MCP Tool Serialization

`ThreadSnapshot` in `src/ObsidianTools.ts` defines the JSON shape returned by `obsidian_list_threads` and `obsidian_get_current_thread`.

When adding a field to `Thread`:
1. Add it to `ThreadSnapshot` in `ObsidianTools.ts`
2. Add it to both serializers in `main.ts`: `getThreadDetail` and `getAllThreads`
3. Update the tool description strings in `ObsidianTools.ts` to mention the new field

---

## Dispatch Command Directives

The dashboard/kanban dispatch boxes intercept leading `/model`, `/goal`, and `/loop` commands before creating a thread. The flow:

1. `parseDispatchDirective(text)` in `slashCommands.ts` returns a discriminated union (`kind: 'model' | 'goal' | 'loop'`, or `null` for plain prompts). A set `error` field means "recognized command, bad args" — the views show a Notice, restore the draft via `DispatchInput.setValue`, and create nothing.
2. Both views map the directive to `dispatchNewThread(text, images, titleHint, opts)` where `opts` is `{ model?, goal?, loop? }`.
3. `dispatchNewThread` applies the option **before** the first `sendMessage`: `setThreadModel` / `setThreadGoal` / `scheduler.createItem({ targetThreadId })`. For loops, the dispatch itself is iteration 1 — the scheduler's first fire is `now + interval`.

Invariants to preserve:
- `DISPATCH_BUILTIN_COMMANDS` is an allowlist — only commands the dispatch flow actually intercepts may be advertised (enforced by `test/unit/slash-commands.test.ts`). Thread-scoped commands (`/compact`, `/clear`, `/cost`) and management variants (`/goal clear`, `/loop stop`) must not appear there.
- The goal kickoff message comes from `goalKickoffMessage()` — shared by ThreadsView and the dispatch path so the two never drift.
- `MODEL_ALIASES` is the only alias map; ThreadsView and dispatch both import it.

---

## DispatchInput Component

`DispatchInput` only renders the bottom footer row (attach button, mic button) when either `showCwdChip` or `appendFooterActions` is passed. If you want the footer layout without other chips (e.g. in AgentDashboard), pass `appendFooterActions: () => {}` as an empty callback — this sets `needsFooter = true` internally.

---

## Screenshot Harness

The harness (`test/harness/`) renders the plugin against fixture data without a live Obsidian or Claude process. Fixtures live in `test/harness/fixtures.ts`.

New UI states need:
1. A fixture entry that seeds the relevant data/state
2. A new test case in `test/screenshots/ui.spec.ts` with the right setup (hover, `page.evaluate`, etc.)

Flows that require a live session (PTT recording, background task completion, permission modals from real tool calls) cannot be tested in the harness and are intentional skips.
