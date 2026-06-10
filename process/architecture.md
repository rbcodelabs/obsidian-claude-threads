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

---

## Thread Type (`src/types.ts`)

Key fields worth knowing:

| Field | Notes |
|---|---|
| `prUrl?: string` | URL of the most recent GitHub PR opened in this session. Surfaced in `obsidian_list_threads` and `obsidian_get_current_thread` — use it to match threads to PRs without reading message history. |
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

## DispatchInput Component

`DispatchInput` only renders the bottom footer row (attach button, mic button) when either `showCwdChip` or `appendFooterActions` is passed. If you want the footer layout without other chips (e.g. in AgentDashboard), pass `appendFooterActions: () => {}` as an empty callback — this sets `needsFooter = true` internally.

---

## Screenshot Harness

The harness (`test/harness/`) renders the plugin against fixture data without a live Obsidian or Claude process. Fixtures live in `test/harness/fixtures.ts`.

New UI states need:
1. A fixture entry that seeds the relevant data/state
2. A new test case in `test/screenshots/ui.spec.ts` with the right setup (hover, `page.evaluate`, etc.)

Flows that require a live session (PTT recording, background task completion, permission modals from real tool calls) cannot be tested in the harness and are intentional skips.
