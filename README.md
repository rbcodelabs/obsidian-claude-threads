# Claude Threads

## Native agent workspace

Background Claude and Codex agents are first-class, durable participants. The conversation shows a nested **Agent Team** tree, and the Agent Dashboard exposes the same agents for navigation and search. Selecting one opens the exact activity and lifecycle information exposed by its native harness. Active runs that cannot be reconnected after reload are labeled unavailable rather than incorrectly shown as completed.

Direct child-agent messaging and single-agent interruption are capability-gated. They remain unavailable when the harness has no verified host-side control path; Claude Threads never silently routes those actions to the parent. See [the capability matrix and recovery behavior](docs/agent-workspace.md).

A native Obsidian and Geode sidebar plugin for running multiple Claude Code sessions in parallel — with streaming markdown responses, tab management, and deep vault integration.

![Claude Threads](https://img.shields.io/badge/Obsidian-Plugin-7C3AED) ![Version](https://img.shields.io/badge/version-0.26.3-blue) [![Roadmap](https://img.shields.io/badge/Roadmap-Compass-6366F1)](https://compass.rbcodelabs.com/portal/rbcodelabs/claude-threads/roadmap)

<p align="center">
  <img src="docs/screenshot-main.png" width="800" alt="Main view: conversation panel with tool calls and Agent Dashboard showing thread summaries" />
</p>

<p align="center">
  <img src="docs/screenshot-slash-commands.png" width="800" alt="Slash command autocomplete showing installed skills from ~/.claude/skills/" />
</p>

<p align="center">
  <img src="docs/screenshot-streaming.png" width="800" alt="Streaming response with live tool call visibility" />
</p>

<p align="center">
  <img src="docs/screenshot-permission.png" width="800" alt="Inline permission dialog — Deny / Allow / Always Allow before Claude writes a file" />
</p>

## What it does

Claude Threads embeds Claude Code directly in your host sidebar. Each tab is an independent Claude Code session with its own working directory and conversation history. You can run multiple sessions in parallel — one debugging a bug, another drafting docs, another answering questions about your vault.

**Key features:**

- **Multi-tab sessions** — open as many Claude threads as you need, switch between them instantly
- **Streaming responses** — tokens stream in with live markdown rendering (code blocks, tables, lists, etc.)
- **Persistent conversations** — sessions resume where you left off after restarting the host app
- **Auto-naming** — tabs rename themselves based on what you're working on (powered by the summarizer)
- **Thread summaries** — a header bar shows what each thread is about, auto-updated after each response
- **Agent dashboard** — monitor and dispatch to multiple threads from a single view; attach images or files to dispatched tasks via the paperclip button or drag-and-drop; resolve pending permission requests directly from dashboard rows without switching threads; toggle between list view and **kanban board** to visualize agent state by column (idle, running, waiting, done), or regroup the board into **folder swimlanes** or **project columns** — one lane/column per app/project — to see every conversation for a codebase together; the Kanban has its own floating dispatch panel so you can launch new tasks without leaving the board view
- **Compressed conversation view** — toggle "Compress view" from the ⋯ menu to collapse an agentic thread's history into one-line summaries per exchange. Consecutive assistant turns (a full agentic run between two user messages) are grouped into a single summary entry. Click the expand arrow on any entry to read the full response. Summaries are generated lazily in a serial background queue so the UI never spawns multiple Claude processes at once
- **Focus edited files** — one click closes all other tabs and opens only the files the active Claude or Codex agent touched in this thread, snapping your workspace to the work
- **Workspace tab syncing** — the host workspace tab title automatically reflects the active thread so you always know which session is which
- **Slash commands** — built-in context commands plus your full `~/.claude/skills/` library, browseable with `/`
- **Model switching** — set a persistent model per thread with `/model fable|opus|sonnet|haiku`, or a global default in settings
- **Claude or Bedrock** — authenticate with your Claude account or route every session through Amazon Bedrock (one dropdown in settings)
- **Goals and loops** — pin a persistent goal on a thread with `/goal`, or re-run a prompt on an interval with `/loop 10m <prompt>`
- **Task list card** — Claude Code's task checklist (TodoWrite / TaskCreate) renders live above the input box: completed tasks struck through, the in-progress one highlighted, with done/in-progress/open counts
- **Context compaction** — auto and manual compaction shown as persistent dividers in the conversation
- **Permission dialogs** — Claude asks before writing files or running commands; you approve or deny inline
- **@ file mentions** — type `@` in the input to search vault files by name; selecting one injects its full content into the prompt as context; type `@this` to reference the currently open file without searching
- **Push-to-talk voice input** — hold a configurable hotkey to dictate a message via speech-to-text (uses the Claude Code STT pipeline); transcript populates the input box ready to send or edit
- **Projects** — group threads by vault sub-folder with a shared context prompt injected into every message
- **Draft persistence** — input text and attachments auto-save when switching threads and survive plugin reloads
- **First-run onboarding** — on first install, a welcome guide walks you through setup and opens a three-panel workspace (conversation, Agent Dashboard, and an example thread) so the layout makes sense before you write a single message
- **Context recap banner** — when you return to a thread you haven't viewed in over a minute, a floating banner shows the thread summary and how long ago you were last active; auto-dismisses after 10 seconds
- **Keep computer awake** — prevents the Mac from sleeping while Claude is active; shows a ☕ indicator in the status bar (uses `caffeinate -i` on macOS, Web Lock API as fallback)
- **Plan Mode** — set permission mode to `plan` and Claude will propose a written plan before touching any files. An inline card lets you **Approve**, **Edit**, or **Reject** the plan before Claude proceeds
- **Thinking mode** — enable extended thinking for harder problems, with a configurable token budget for how long Claude reasons before responding
- **Effort level** — set `low`, `medium`, `high`, or the CLI default; controls how much work Claude invests per turn, useful for simple questions vs. deep research
- **MCP Elicitation** — when an MCP server needs OAuth or a form filled mid-session, a card appears inline in the conversation (URL auth or structured form fields) so you can respond without leaving Claude Threads
- **Tool call visibility** — see exactly which files the active Claude or Codex agent is reading/writing during each response; tool pills show elapsed time once complete, REPL calls get a dedicated icon and summary, and git operations render as structured pills; files the agent edited that you subsequently modified show a "Modified by user" badge; a tool call that's auto-denied without a prompt (in `auto` or `dontAsk` mode, or by a deny rule) shows a distinct "Auto-denied" annotation so the denial is visible instead of silently swallowed
- **Tool call grouping** — consecutive calls of the same kind (e.g. a run of file reads, or a string of edits) collapse into a single expandable group instead of a long scroll of individual pills, live as the turn runs (not just after it settles) — so a long agentic run never grows an unbounded wall of pills while Claude is still working; the in-progress group shows a "still running" pulse, the group you expand mid-turn stays expanded as more calls arrive, and a group containing a failed call auto-expands and stays flagged so errors are never hidden. Short off-kind interruptions (e.g. a single `TaskUpdate` between two runs of file reads) are folded back into their surrounding group instead of breaking it into extra short entries, and if the list is still long after that smoothing, it collapses one level further into a second "N tool calls, M steps" wrapper — which itself shows a live-updating "currently running" tool name and icon while the turn is in progress, and auto-expands through both levels if a call anywhere inside it fails. Works on both desktop and mobile (mobile gets the smoothing pass only — the second collapsible tier and live header are desktop-only).
- **Cancel and restore** — press Escape (or click Stop) while Claude or Codex is running to cancel; the sent message pops back into the input box ready to edit and re-send
- **Keyboard shortcuts** — navigate tabs without touching the mouse

## Prerequisites

- Obsidian v1.0.0+ or a compatible Geode desktop host
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
  - The plugin auto-detects `claude` at `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`, or `~/.local/bin/claude`
  - AWS Bedrock / SSO users: set `AWS_PROFILE` and `AWS_REGION` in the plugin's Extra Environment Variables setting
- Or [OpenAI Codex CLI](https://developers.openai.com/codex/cli/) installed and authenticated
  - Select **OpenAI Codex** in Settings → Agent → Agent harness. The plugin launches Codex's local app-server, so its threads retain Codex session history, streaming output, tool visibility, interruption, and approval prompts.

## Roadmap

Vote on upcoming features and see what's in progress at the [public roadmap](https://compass.rbcodelabs.com/portal/rbcodelabs/claude-threads/roadmap).

## Installation

### Via BRAT (recommended for early access)

1. Install the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat) from Obsidian's Community Plugins
2. Open BRAT settings → **Add Beta Plugin**
3. Enter: `rbcodelabs/obsidian-claude-threads`
4. Enable **Claude Threads** in Settings → Community Plugins

### Manual install

1. Download the latest release from [GitHub Releases](https://github.com/rbcodelabs/obsidian-claude-threads/releases)
2. Extract into your vault's plugin folder: `<vault>/.obsidian/plugins/claude-threads/`
3. Enable **Claude Threads** in Settings → Community Plugins

## Usage

Click the **message-square** icon in the left ribbon, or run **Open Claude Threads** from the command palette.

### Agent harnesses

New threads use the harness selected in **Settings → Agent → Agent harness**. A thread remembers the harness that created it, so changing the default never mixes Claude and Codex session IDs. Codex uses the `codex` executable on your PATH by default; set a custom path in the same settings panel when needed.

| Capability | Claude Code | OpenAI Codex |
|---|---:|---:|
| Persistent sessions, streaming, tools, images, interruption | ✓ | ✓ |
| Models, permission modes, approvals, and plan review | ✓ | ✓ |
| Built-in vault/workspace tools and external stdio/HTTP/SSE MCP servers | ✓ | ✓ |
| MCP form/URL elicitation | ✓ | ✓ |
| Context usage, compaction, and raw event logs | ✓ | ✓ |
| Skills and sub-agent/task activity | ✓ Claude-native | ✓ Codex-native |
| Monetary API cost attribution | ✓ | — protocol does not report cost |

Harness-native skills and sub-agents use their respective CLI's definitions and event protocol; they are presented through the same slash-command and task UI where the protocols expose equivalent data.

### Tabs

| Action | How |
|---|---|
| New thread | Click `+` in the tab bar |
| Close thread | Hover a tab → click `×` |
| Rename thread | Double-click the tab label |
| Switch to tab N | `Cmd+1` through `Cmd+9` |
| Next / previous tab | `Cmd+]` / `Cmd+[` |

Tabs are renamed automatically after the first exchange using the thread summarizer — no need to name them yourself.

### Sending messages

- **Enter** — send message
- **Shift+Enter** — newline
- **`/`** — opens slash command autocomplete
- **Escape** — cancel the running session; the sent message is restored to the input box so you can edit and re-send

**Collapsible input panels.** All three message-input panels (Threads view, Agent Dashboard sidebar, and Kanban dispatch) collapse to a minimal bar at rest — just the textarea and send button. Hover over the panel or click into the textarea to expand secondary controls (attach, mic, model picker, more menu, CWD chip) with a smooth animation. The panel border softens when collapsed so it reads as a quiet background element.

**Message queue.** If you send a message while Claude is already processing, it goes into a queue — displayed as stacked removable rows above the composer. Each row shows a preview of the queued message and an `×` button to discard it. Click any row to pull it back into the input box for editing (an inline confirm prompt prevents you from accidentally discarding your current draft). The queue drains automatically as Claude finishes each turn. Queued messages survive thread switches and plugin reloads.

<p align="center">
  <img src="docs/screenshot-queue-rows.png" width="800" alt="Message queue rows — stacked removable chips above the composer showing queued messages" />
</p>

**Activity indicator.** While Claude is processing, a typed status card appears above the input area showing what's happening:

- **Active work** — a pulsing spinner with a short label (e.g. "Compacting context…" during automatic compaction, "Retrying API call…" on transient errors). The card disappears as soon as the operation completes.
- **Rate limit** — if the API returns a rate limit response, a card shows in warning or error style depending on whether the request was allowed to proceed or rejected outright.
- **Model escalation tip** — when a turn is routed to the escalation model (e.g. Fable 5 when you send `/escalate`), a brief tooltip pops up from the model button rather than reshuffling the layout. It fades in, holds for a moment, then fades out automatically — no interaction needed and zero layout shift. For the rest of the escalated turn, the model button itself stays highlighted with an accent glow, and its tooltip reads "escalated to \<model\> for this turn", so you can confirm the escalation at any point until the turn completes.

<p align="center">
  <img src="docs/screenshot-status-rail.png" width="800" alt="Status rail — active-work card with spinner above the composer" />
</p>

### Slash commands

Type `/` in the input box to see built-in context commands and your installed Claude Code skills. Navigate with arrow keys, Tab, or Enter.

**Built-in commands** (handled by the plugin):

| Command | What it does |
|---|---|
| `/model fable\|opus\|sonnet\|haiku` | Set a persistent model for this thread |
| `/model default` | Reset thread model back to the global default |
| `/model` | Show the current model for this thread |
| `/goal <text>` | Set a persistent goal for this thread — injected into every turn until cleared |
| `/goal clear` | Clear the thread's goal (`/goal` alone shows the current goal) |
| `/loop <interval> <prompt>` | Send a prompt now and re-run it on an interval (e.g. `/loop 10m check CI`); replaces any loop already running on this thread |
| `/loop stop` | Stop the thread's loop (`/loop` alone shows it) |
| `/compact` | Summarize conversation history to free up context window |
| `/clear` | Clear conversation history and start a fresh session |
| `/cost` | Show token usage and cost for the current session |
| `/usage` | Show provider token totals, quota windows/resets, and account activity where available |
| `/context` | Show a per-category token usage breakdown for the active session (tools, system prompt, skills, MCP tools, conversation, etc.) |
| `/create-pr` | Ask Claude to push the branch and open a PR (`gh pr create`) — same action as the [git diff bar](#git-diff-bar-create-pr)'s Create PR button |
| `/create-pr --draft` | Same, but opens a draft PR — same as the git diff bar's Create draft PR button |
| `/escalate <prompt>` | Route just this turn to the [escalation model](#model-switching) (default `/escalate`, keyword and target model configurable in Settings; only shown when escalation is enabled) |

**Command pills** — when you complete a built-in command (type `/goal ` or pick one from the dropdown), it turns into a pill chip at the left of the input box. Type the arguments after it; a single Backspace at the start of the input (or clicking the pill's ×) deletes the whole command. After a command, argument autocomplete kicks in — `/model ` offers `fable|opus|sonnet|haiku|default`.

**Skills** — any `.md` file (or directory) in `~/.claude/skills/` appears below the built-in commands. Selecting one inserts the skill name into your message, which Claude handles via your `CLAUDE.md` configuration.

### Skills Manager

Open the **Skills Manager** panel from the ribbon (puzzle icon) or command palette to browse, install, and edit Claude Code skills. The list and detail panels are split by a **draggable divider** — drag it to resize, double-click to reset to the default width; your chosen width is remembered next time you open the panel.

<p align="center">
  <img src="docs/screenshot-skills-manager.png" width="800" alt="Skills Manager: source tree on the left with skill/agent detail and editor on the right" />
</p>

**Installed tab** — shows everything installed as a collapsible source tree. The top-right corner of the tab bar has two icon buttons (Installed tab only): **Import** (+) opens a menu with **Folder…** and **File (.skill)…**, letting you install a skill directly from a local folder or a packaged `.skill`/`.zip` archive without going through GitHub; and **Check for updates** (↻, shown once you have at least one GitHub plugin source) re-fetches staleness for all GitHub plugin sources in parallel — its icon spins while running, and a toast reports the result when it finishes (including which sources failed to check, e.g. if you're offline). An indicator dot appears on the button afterward if any plugin has updates (hover either button for its full status/tooltip). GitHub plugin sources appear as top-level nodes with a badge (`•N`) when updates are available; clicking one expands it to reveal its skills and opens a detail panel with **Update** (git pull, highlighted when updates are available), **Reload** (re-scan from disk), **Reinstall** (delete and re-clone for broken installs), and **Remove Source**. A **Local** node at the bottom groups your standalone skills and agents — click any item to view and edit it. For skills: **Save**, **Reload**, **Reveal in Finder**, **Uninstall**. For agents: **Save**, **Reload**, **Reveal in Finder**, **Delete**.

**Browse tab** — search the [skills.sh](https://skills.sh) registry. Results show the skill name, GitHub source, and install count. Click a result to see details and an **Install** button that clones the skill from GitHub into `~/.claude/skills/`.

### @ file mentions

Type `@` anywhere in the input box to search vault files by name. A dropdown appears showing up to 20 matching files — navigate with arrow keys and press Tab or Enter to insert.

<p align="center">
  <img src="docs/screenshot-file-mention.png" width="800" alt="@ file mention autocomplete — type @ to search vault files and inject their content as context" />
</p>

Selecting a file inserts `@[[filename]]` into your message. When you send the message, the plugin resolves each mention and appends the file's full content as context for Claude — useful for asking Claude to work with a specific note, doc, or config file without copying and pasting.

Type `@this` (no search needed) to instantly reference the currently active file in the host workspace. It resolves to the same `@[[filename]]` injection at send time.

### Model switching

`/model` sets the model for all subsequent turns in a thread:

```
/model fable    → uses Claude Fable 5 for every turn in this thread
/model opus     → uses Claude Opus for every turn in this thread
/model sonnet   → switches to Sonnet
/model haiku    → switches to Haiku
/model default  → resets to the plugin's Default model setting (or the CLI default)
```

A **Default model** dropdown in settings picks the model for threads that have no `/model` override. Family aliases (Fable / Opus / Sonnet / Haiku "latest") are always listed first; pinned model IDs are sourced from the SDK's `capabilities_discovered` event, which fires the first time a thread starts in the current host session. Before any thread has run, the dropdown falls back to a hardcoded list of current models — start a thread and reopen Settings to see the full CLI-sourced list, so no plugin update is needed when Anthropic adds a new model. The Escalation model dropdown is populated the same way.

You can also switch models without typing: a **model switcher button** (CPU icon) sits in the conversation footer, left of the menu button. Hover it to see the active model; click it to pick Default / Opus / Sonnet / Haiku / Fable from a dropdown. The icon turns accent-colored whenever a per-thread override is active, and it stays in sync with the `/model` command.

The active model is shown as a badge in the thread info bar. You can also use `/escalate` as a one-turn override — it routes just that message to the Escalation model chosen in settings (Fable 5, Opus, Sonnet, or Haiku), then the thread model resumes. Both the keyword and the target model are configurable, and (when escalation is enabled) the current keyword shows up alongside `/model`, `/goal`, etc. in the `/` autocomplete popup so it's discoverable without reading the docs — renaming the keyword or toggling escalation off in Settings updates the popup immediately. While an escalated turn is running, the model switcher button glows in the accent color and its tooltip names the escalated model, so you always have visible confirmation that the escalation took effect. The glow clears automatically when the turn finishes.

### Goals and loops

**Goals** — `/goal <text>` pins a persistent goal on a thread. Setting a goal does two things:

1. Claude immediately starts working toward it — no separate prompt needed.
2. The goal is injected into the system prompt on **every subsequent turn**, so it survives context compaction, topic drift, and multi-day threads. Claude is instructed to keep working toward it until it's met or blocked on your input.

`/goal` alone shows the current goal; `/goal clear` (or `off`/`done`) removes it.

**Loops** — `/loop <interval> <prompt>` re-sends a prompt to the thread on a schedule:

```
/loop 30s poll the deploy status     → every 30 seconds
/loop 5m check the build             → every 5 minutes
/loop 1h summarize new emails        → every hour
/loop 10 check CI                    → bare numbers mean minutes
```

Like `/goal`, starting a loop sends the prompt immediately — you don't wait for the
first interval to elapse. Intervals below 30 seconds are clamped to 30s. Loops run on
the plugin's built-in scheduler, so they **persist across plugin reloads and host app
restarts**. If a loop tick arrives before the thread's previous turn has finished, it's
retried shortly after rather than piling up as a queued duplicate. A thread can only
have one active loop at a time — starting a new `/loop` replaces whichever loop was
already running there. `/loop` alone lists the thread's loop with its next run time;
`/loop stop` (or `off`/`cancel`/`clear`) stops it. While a loop is active, a banner
above the input shows its status ("Loop running…" or the next run time) with a **Stop**
button, and a matching pill appears in the thread's status footer.

### Dispatching with commands

`/model`, `/goal`, and `/loop` also work as prefixes in the dashboard and kanban dispatch boxes, applying to the newly created thread:

- `/model opus fix the login bug` — creates the new thread with Opus set as its model and dispatches just the prompt
- `/goal ship the v1 login flow` — creates the thread with that persistent goal and immediately starts working toward it (same kickoff as `/goal` inside a thread)
- `/loop 10m check CI status` — creates the thread, sends the prompt now, and re-runs it every 10 minutes (stop it later with `/loop stop` inside the thread)

A command with bad or missing arguments shows a notice and keeps your draft instead of creating a thread. The thread-management variants (`/goal clear`, `/loop stop`) only work inside an existing thread.

`/escalate <prompt>` (when escalation is enabled) also appears in the dispatch box autocomplete — it creates the new thread and routes its first turn to the escalation model, same as using it mid-thread. A bare `/escalate` with no prompt shows a usage notice instead of dispatching.

### Context compaction

When the context window fills up, Claude compacts the conversation automatically. You can also trigger it manually with `/compact`. Either way, a divider appears in the conversation showing when compaction happened and how many tokens were in context beforehand. Compaction markers are persisted and survive plugin reloads.

### Agent dashboard

Open the **Agent Dashboard** from the ribbon or command palette to see all threads at a glance. Each thread appears as a row showing its name, working directory, current model, and status.

**Live activity (running threads):** While a thread is actively processing, the dashboard shows a live one-line summary of the current tool call or step — so you can see "Reading src/components/Header.tsx" or "Running npm test" without switching to that tab.

**Auto-generated summaries (idle threads):** After each completed response, the summarizer runs in a lightweight background process (a separate Claude Code instance using a small model) and writes a multi-sentence recap of what that thread worked on. This summary is shown in the dashboard row so you can re-orient yourself to any thread at a glance — what it accomplished, what files it touched, what's left to do.

This combination means you can dispatch several threads in parallel, switch to other work, then return to the dashboard to understand the state of every agent without reading through each conversation.

You can also send messages to any thread directly from the dashboard without switching tabs.

**Background tasks stay "Working."** A thread that spawns a background subagent (`Agent(..., run_in_background: true)`) or runs the `Workflow` tool can have its own turn finish — and its activity line stop updating — before that spawned work actually completes server-side. Rather than misclassifying the thread as New/Reviewed/Ready the moment the outer turn ends, the dashboard (and the [Kanban board](#kanban-board)) keeps it under **Working** until the background task or workflow reports back.

If a background task finishes while its thread is actively streaming, the running turn's live task pill shows the result inline. If it finishes after the thread has gone idle, a ✓/✗ summary is appended directly into that thread's conversation as a subtle centered notice row, instead of a transient top-right toast — so it's still there if you open the thread later or scroll back, rather than something you had to catch in the moment.

**Scheduled Jobs.** An hourly (or more frequent) recurring cron task (see `CronCreate` / `ScheduleWakeup` below) can produce dozens of quiet threads a day, burying the manually-created ones you actually need to triage. When a run created by the scheduler is unreviewed, reviewed, or empty — never one that's running, awaiting a permission/question, or errored — it's pulled out of its normal group into a **Scheduled Jobs** section at the bottom of the dashboard, one collapsed row per job showing its name, run count, and the latest run's time. Click a row to expand it into the individual runs. Disable via **Settings → Features → Stack scheduled job threads**.

### Inline workflow progress

When a thread runs the `Workflow` tool (multi-agent orchestration), a live progress block appears inline in the conversation — pinned above the streaming output — showing:

- **Workflow name** and **current phase** (updates as the workflow transitions between phases)
- **Per-agent rows** — each spawned sub-agent gets a row with a dot (pulsing while running, filled when done, ✗ on failure) and its task description. Rows appear as agents are launched and update in place as they complete; they don't disappear, so you can see the full run at a glance even before the workflow finishes.
- **Done / Failed badge** — when the workflow completes, the block locks into a final state with a "Done" or "Failed" annotation.

<p align="center">
  <img src="docs/screenshot-workflow-progress.png" width="800" alt="Inline workflow progress block — live agent rows with running/done dots and a phase label" />
</p>

The block is rendered entirely from the SDK event stream (no extra API calls), so it appears immediately when the first sub-agent starts and has zero overhead for threads that don't use workflows.

### Kanban board

Toggle the **Kanban** button in the dashboard toolbar to switch from the default list view to a board layout. Each thread is a card, bucketed into a column for its agent state: **Working** (also covers a thread whose own turn has ended but a background subagent or `Workflow` task it spawned hasn't reported back yet — see [Agent dashboard](#agent-dashboard)), **Awaiting** (permission), **Waiting** (a `ScheduleWakeup` is pending — shows a live countdown, e.g. "Resumes in 4m — check CI status"), **New** (unreviewed), **Done**, **Failed**, and **Ready** (empty). Columns are sorted most-recently-active first. The board has its own floating dispatch panel at the bottom — type a task and press Enter to launch a new thread without leaving it. List view is the default; the preference persists across reloads.

**Task list on cards.** When a thread has an active `TodoWrite` / `TaskCreate` checklist, its kanban card shows a compact task list: up to 5 items with status icons (✔ completed, ■ in-progress, ○ pending), a "X / Y done" progress line, and "+N more" when there are additional tasks. The list updates live as the agent ticks items off.

<p align="center">
  <img src="docs/screenshot-kanban-status.png" width="800" alt="Kanban board grouped by status — Working, Awaiting, Waiting, New, Done, Failed, and Ready columns, each holding thread cards" />
</p>

**Auto-collapse side panels.** Set **Settings → Features → Kanban board → Auto-collapse side panel** to `Left sidebar`, `Right sidebar`, or `Both sidebars` to automatically collapse the host's sidebar panel(s) when the Kanban tab opens, giving the board more horizontal room. Only the panel(s) the Kanban view collapsed are restored when you close the tab, so it won't fight a panel you collapsed or expanded manually. Defaults to `None` (opt-in).

**Group by folder or project.** The group-by toggle in the board header (the icon next to search) cycles through three layouts: **status columns** (the default), **folder swimlanes**, and **project columns**. Each click advances to the next; the choice persists across reloads.

- **Folder swimlanes** — one horizontal lane per app/project, so you can see every conversation for a given codebase together. Each lane is keyed by the thread's assigned **Project**, falling back to a working-directory label (git repo name) when no project is set, and an **Unassigned** lane catches threads with no folder. For a thread whose cwd is a temporary `EnterWorktree` worktree, the repo name is remembered from when the worktree was created, so it still groups correctly under the origin repo even after that worktree directory is later deleted. Inside each lane the cards are still grouped into the same status columns (empty columns are hidden to keep lanes compact). Lanes are ordered alphabetically (case-insensitive), with Unassigned pinned last.
- **Project columns** — one vertical column per app/project (same project resolution as folder swimlanes, alphabetical with Unassigned last), with each column's cards grouped under status **section headers** — Working, Waiting, New, Reviewed, Failed, Ready — matching the Agent Dashboard sidebar's grouping. Awaiting-permission threads fold into **Working**, and empty sections are omitted. This gives a compact, scannable per-project view where each column reads top-to-bottom like a mini dashboard.

<p align="center">
  <img src="docs/screenshot-kanban-folder.png" width="800" alt="Kanban board grouped by folder — one horizontal swimlane per app/project, each with its own nested status columns" />
</p>

**Stacked scheduled-job threads.** Repeat runs of the same cron job pile up fast — an hourly triage job produces ~24 cards a day, crowding out the threads you started yourself. In the quiet columns only (**New**, **Done**/**Reviewed**, **Ready** — a run that's Working, Awaiting, Waiting, or Failed always stays its own card), runs that share a scheduled job collapse into a single dashed-border rollup card: job name, a "×N" run count, and the latest run's time. Click the card to expand it into the individual run cards, indented beneath. This applies in status-column, folder-swimlane, and project-column mode. Disable via **Settings → Features → Stack scheduled job threads**.

### Push-to-talk voice input

Hold the configured push-to-talk key (default: none — set it in Settings → Push to Talk Hotkey) and speak. The microphone activates while you hold the key; releasing it stops recording and transcribes your speech using the Claude Code STT pipeline. The transcript populates the input box so you can review and edit before sending. The floating input panel highlights while recording so you always know the mic is live.

### Permissions

When Claude needs to write a file or run a command, a permission card appears inline in the conversation asking you to **Allow**, **Deny**, or **Always Allow**. Always Allow adds the tool to a per-vault allowlist so you're never asked again for that tool. You can also resolve permissions directly from the Agent Dashboard without switching threads. The default behavior can be changed globally in **Settings → Tools → Permission Mode**, or **per-thread** via the shield (🛡) button in the thread footer — a thread-level override takes precedence over the global setting and is useful when you want plan mode for one specific task without affecting other threads:

| Mode | Behavior |
|---|---|
| `default` | Use the Claude CLI default (prompts for most tool calls) |
| `acceptEdits` | Automatically accept file edits; prompt for commands and other tools |
| `bypassPermissions` | Skip all permission prompts — Claude executes everything without asking |
| `plan` | Claude proposes a written plan before taking any action; you approve, edit, or reject it before it proceeds (see [Plan Mode](#plan-mode) below) |
| `dontAsk` | Suppress all interactive permission dialogs; Claude proceeds without confirmation. Intended for scheduled/background sessions that run unattended |
| `auto` | Claude autonomously decides when to prompt vs. proceed based on action risk |

> **Note for scheduled sessions:** threads created by the built-in scheduler automatically use `dontAsk` so cron jobs never stall waiting for a permission dialog that nobody is watching. They also inherit any external MCP servers defined in `~/.claude/settings.json` (Compass, Helio, or any other user-configured HTTP/SSE/stdio server) alongside the plugin's built-in tools, so scheduled agents have the same tool surface as an interactive CLI session — `${VAR_NAME}` placeholders in that config are resolved from environment variables and keychain-stored secrets. Such threads also carry the originating scheduled item's id and name (`scheduledItemId`/`scheduledItemName`), captured once at creation time and surfaced as a "Scheduled: `<name>`" footer pill and in the `threads_get_current`/`threads_list` tool output.

> **Active-hours windows:** a scheduled item can be scoped to a local time-of-day window so it only fires during, say, business hours. Pass `activeHoursStart`/`activeHoursEnd` (24h `HH:MM`) to `CronCreate`, or set/clear them later with `CronUpdate` (`activeHoursStart`/`activeHoursEnd`/`clearActiveHours`). When a cycle comes due outside the window it's skipped **without opening a thread at all** — the scheduler just jumps to the next window-open time — so an every-6h job scoped to `07:00`–`22:00` never wastes an overnight run. Overnight windows (start after end, e.g. `22:00`–`06:00`) wrap past midnight. **Settings → Scheduled tasks** shows the window inline, e.g. *"Every 6 hour(s) (07:00-22:00 only)"*. This replaces baking a `date`-based business-hours check into the prompt itself, which used to burn a whole thread each time it fired just to check the clock and bail.

> **Gate commands:** a scheduled item can carry a deterministic **gate** — a shell command that runs *before* each cycle spawns a thread, so cycles with "nothing to do" are skipped without burning an agent turn. Pass `gateCommand` to `CronCreate` (with optional `gateTimeoutSeconds`, default 30 and capped at 120, and `gateFailOpen`, default `true`), or set/clear it later with `CronUpdate` (`gateCommand`/`gateTimeoutSeconds`/`gateFailOpen`/`clearGate`). The contract mirrors `test -s file` / `grep -q`: **exit `0` fires the agent; any clean non-zero exit skips the cycle entirely** — no thread, no message, no LLM call — while the schedule still advances normally to the next run. On a fire, the gate's stdout is fed into the prompt: it replaces a `{{gateOutput}}` placeholder if the prompt has one, otherwise it's appended as a `Gate output:` block (truncated to ~8 KB), so the agent doesn't have to re-derive what the check already found. The gate runs in the item's `cwd` with an environment that includes `CRON_LAST_RUN_MS` (epoch ms of the previous run, a natural "since last check" cursor), `CRON_ITEM_ID`, and `CRON_ITEM_NAME`. If the gate can't be *evaluated* — it times out or fails to spawn (e.g. command-not-found) — the item **fails open and fires anyway** by default (set `gateFailOpen: false` to fail closed and skip instead), so a broken check never silently blackholes a real cron; a clean non-zero exit is always a deliberate skip regardless. Gates run on desktop only (they're inert on mobile, where a configured gate simply fires). **Settings → Scheduled tasks** flags gated items inline, e.g. *"Every 5 minute(s) · gated"*. Example: `gateCommand: "test -s ~/inbox/pending.txt"` with a prompt of `Process the pending items:\n{{gateOutput}}` fires only when that file is non-empty. Because the gate is an arbitrary command run unattended, it carries the same trust profile as the existing `statusLineCommand` setting: it's authored by the same user who controls the vault.

### Plan Mode

Set **Permission Mode → `plan`** globally in settings, or use the **shield button** in the thread footer to set it for a single thread, to enable Plan Mode. In this mode Claude reads, researches, and thinks — but doesn't write files or run commands — until it has produced a written plan and you've approved it.

**The flow:**

1. You send a message as normal.
2. A **"Planning…"** visual state appears in the thread while Claude gathers context.
3. When Claude finishes its plan, an inline card replaces the spinner, showing the full proposed plan text.
4. You pick one of three actions on the card:
   - **Approve** — Claude proceeds to execute the plan immediately.
   - **Edit** — The plan text becomes editable in-place; submitting the edited version sends it back to Claude as the confirmed plan before execution.
   - **Reject** — Claude stops; no edits are made. You can send a follow-up message to redirect.

Plan Mode is useful for risky or large-scale tasks where you want to review the approach before any files are touched.

### MCP Elicitation

Some MCP servers need a credential or a form filled before they can proceed — for example, an OAuth flow or a confirmation dialog. When this happens, Claude Threads renders an elicitation card inline in the conversation rather than silently failing.

- **URL auth card** — displays a clickable link for the OAuth URL. Click it to open the auth page in the host's Web Viewer (or your system browser), complete the flow, then return to the thread. Claude resumes automatically once the server receives the credential.
- **Form card** — renders input fields derived from the server's JSON schema (text fields, selects, checkboxes). Fill in the form and submit; the response is forwarded to the MCP server and the session continues.

Without elicitation support the session would stall indefinitely with no visible feedback. The card makes the situation visible and actionable without leaving Claude Threads.

### Managing MCP servers

Settings → **MCP** lists, adds, edits, and removes the external MCP servers referenced above (Compass, Helio, or any other HTTP/SSE/stdio server) — no manual JSON editing required for the common case.

<p align="center">
  <img src="docs/screenshot-mcp-servers.png" width="800" alt="Settings MCP tab: a list of configured MCP servers, each with a type badge (stdio, http, sdk), a one-line summary, and Edit/Remove buttons, plus an Add MCP server button" />
</p>

**This tab edits your GLOBAL `~/.claude/settings.json`** (or the per-machine file it symlinks to), not a per-vault or per-plugin config. That file is shared by every vault running Claude Threads on this machine *and* by the `claude` CLI itself, so a server you add here shows up everywhere, and a server someone else added via the CLI shows up here too. Changes take effect for new threads only — sessions already running keep whatever MCP servers they started with.

For each server you can see its name, a type badge (`stdio`, `http`, `sse`, or `sdk`), and a one-line summary (the command for `stdio`, the URL for `http`/`sse`). Adding or editing a server opens a form for the command/args/env (stdio) or URL/transport/headers (http/sse) — env values and header values support `${VAR_NAME}` placeholders, resolved the same way as everywhere else in the plugin (environment variables merged with keychain-stored secrets).

<p align="center">
  <img src="docs/screenshot-mcp-edit-server.png" width="800" alt="Add/edit MCP server form: a type toggle between Command (stdio) and HTTP or SSE, with Name, Command, Arguments, and Environment variables fields, the env field showing a ${NOTES_API_TOKEN} placeholder" />
</p>

`sdk`-type entries (servers registered by an in-process integration rather than a spawned process or remote URL) render read-only in this tab — they need a live server instance that can't be represented as JSON, so edit `~/.claude/settings.json` by hand if you need to change one. If the settings file has invalid JSON, the tab shows the parse error and hides the add/edit controls entirely rather than risking a write that clobbers whatever's actually on disk.

### Remote access (mobile)

Claude Threads can mirror your desktop sessions to Obsidian Mobile in real time. Your phone becomes a thin client: you can read the conversation as it streams, send messages, approve permission requests, answer AskUserQuestion prompts, and switch between threads — all over a secure WebSocket relay. The desktop does all the actual Claude work; mobile just shows the state.

**Prerequisites:**

- Obsidian desktop with Claude Threads installed and running
- Obsidian Mobile with Claude Threads installed via [BRAT](https://github.com/TfTHacker/obsidian42-brat)
- Both devices on any internet connection (no LAN required)

**Setup:**

1. On desktop: open Settings > Claude Threads > Remote Access and toggle **Enable remote access** on
2. Click **Show pairing QR code** — a QR code appears with a 5-minute expiry window
3. On mobile: open the Claude Threads ribbon icon, tap **Connect to Desktop**, then scan the QR code (or tap the `claude-threads://pair` link if you're on the same device)
4. The mobile view refreshes to show all your desktop threads

**Manual pairing (URI scheme):**

If you can't scan a QR code, send yourself the pairing link directly:

```
claude-threads://pair?roomId=<ROOM_ID>&relay=<RELAY_URL>
```

Opening this URL on any device with Obsidian Mobile + Claude Threads installed will pair it to your desktop.

**What you can do on mobile:**

- Read streaming conversation output and tool calls in real time
- Send messages, approve or deny permission requests (including **Always Allow**)
- Answer **AskUserQuestion** prompts — single-select and multi-select options plus a free-text "Other" field, same as desktop
- Switch between threads and search the thread list by title or summary
- See each thread's **status rail** — spinner cards for active tool calls, error cards for failed threads
- Copy any assistant message to clipboard with the ⎘ button
- View the thread's **cwd chip**, **model**, and **message timestamps**
- See **queue rows** for pending messages (tap to pull back into the composer, × to cancel)
- View **tool pill icons** matching the desktop view

**Limitations:**

- Desktop must be running and connected — mobile cannot start new Claude sessions without desktop
- Mobile is a read-mostly thin client; it cannot access your vault files or run tools directly
- One desktop per room ID; rotate the room ID in settings to revoke all mobile access

<p align="center">
  <img src="docs/screenshot-mobile-connected.png" width="800" alt="Mobile remote access — desktop sessions mirrored to your phone in real time" />
</p>

### Compressed conversation view

Long agentic threads — especially ones with many tool calls spread across dozens of turns — can be hard to scan. Toggle **Compress view** from the `⋯` menu (top-right of the conversation panel) to collapse the history into a scannable list of one-line summaries.

**How it works:**

- Each entry represents one *exchange*: a user message followed by all the consecutive assistant turns that came back before the next user message (i.e., a full agentic run)
- The summary for each entry is generated by running the combined content of all assistant turns through a lightweight background process — so you get one meaningful summary ("Investigated codebase, added 4 MCP tools, wrote tests") rather than N fragments
- Summaries are generated lazily in a serial queue (one at a time) so toggling compress view on a 50-message thread won't spawn 50 simultaneous Claude processes
- Click the **⌄** arrow on any entry to expand it and read the full response with all tool calls intact
- Toggle the menu item again (now labelled **Expand view**) to return to the normal conversation view

Summaries are cached in memory for the session. They regenerate on the next reload — which keeps storage simple while keeping the background work cheap (the in-process model is fast and inexpensive).

### Thread summaries

A summary bar above the messages shows what the thread is about. It updates automatically after each response if **Auto-summarize** is enabled, or you can trigger it manually with the brain icon. The summarizer updates the tab name — auto-summarize only does this when the name is still the default "Thread N"; manual summarize always applies the new title regardless of what the tab is currently named.

When you switch back to a thread you haven't viewed in over a minute, a **context recap banner** floats at the top of the conversation showing the thread summary and how long ago you were last active. It auto-dismisses after 10 seconds or when you send a message.

<p align="center">
  <img src="docs/screenshot-context-recap-banner.png" width="800" alt="Context recap banner — re-orients you to a thread after returning from a break" />
</p>

### Projects

Projects group threads by vault sub-folder and inject shared context into every message, so Claude always knows what it's working on.

**Creating a project:** Go to Settings → Projects → enter a project name and vault folder path → click **Create project**. You can also add a project context prompt — a few sentences describing the project's goals, conventions, and key files that Claude should always keep in mind.

**Opening a thread in a project:** When you create a new thread, select a project from the dropdown near the input box. The thread's working directory is set to the project's vault folder, and the project context is prepended to every message you send.

**Managing projects:** Edit the name, folder, or context prompt at any time in Settings → Projects. Deleting a project keeps all its threads — they just lose the project association.

### Status line (context footer)

A row of pills below the input area shows live context for each thread — git branch, an open PR, a running dev server URL, AWS session status, or anything else you want. It's powered by a shell command (Settings → **Context footer command**) that the plugin runs **per thread, in the background**, against that thread's working directory. Desktop only.

<p align="center">
  <img src="docs/screenshot-status-line.png" width="800" alt="Status-line footer pills — dev URL, git branch, a clickable PR pill, and an AWS status pill below the message input" />
</p>

**Output format.** The command can return either:

- **A JSON array of tags** (recommended) — each pill is a `StatusTag`:

  ```json
  [
    { "label": "http://localhost:3001", "url": "http://localhost:3001", "kind": "dev" },
    { "label": "feat/social-nudge", "kind": "branch" },
    { "label": "PR #225", "url": "https://github.com/acme/app/pull/225", "kind": "pr" },
    { "label": "AWS expired", "tone": "warn", "kind": "aws" }
  ]
  ```

  | Field | Meaning |
  |---|---|
  | `label` | **Required.** Pill text. |
  | `url` | Makes the pill a clickable link (opens in your browser). |
  | `icon` | [Lucide](https://lucide.dev) icon name. Defaults from `kind` if omitted. |
  | `tone` | `normal` (default), `warn`, or `error` — colors the pill. |
  | `kind` | `pr`, `branch`, `dev`, `aws`, or any custom string. A `kind:"pr"` tag (or any `url` ending in `/pull/N`) becomes the thread's PR — shown as the PR pill and surfaced to the Kanban board, MCP tools, and release automation. |

- **Plaintext** (the Claude Code statusline convention) — segments split on 2+ spaces, with heuristic icons (URL→globe, `PR #N`→pull-request, `AWS …`→cloud, else→branch). Existing scripts keep working unchanged.

**Input.** The command receives JSON on stdin: `{ "cwd": "…", "workspace": { "current_dir": "…" }, "provider": "claude" | "bedrock" }`. Use `provider` to gate provider-specific pills — e.g. only emit an AWS pill when `provider == "bedrock"` so a logged-out AWS session doesn't show a spurious warning on a non-Bedrock machine.

**PR detection** is fully script-driven: a `kind:"pr"` tag with a `url` (e.g. from `gh pr view`) populates the thread's `prUrl`, which is **sticky** — it survives after the PR merges so release tooling can still match the thread.

**Opening links:** clicking a pill with a `url` opens it in the host's in-app **Web Viewer** when available (reusing an existing tab); otherwise it opens in your system browser. **Cmd-click** (Ctrl-click on Windows/Linux) always opens in the system browser, even when the Web Viewer is enabled.

A ready-to-use reference script (branch · PR · dev URL · Bedrock-gated AWS) ships at [`docs/statusline-command.example.sh`](docs/statusline-command.example.sh).

### Git diff bar (Create PR)

Whenever a thread's working directory is a git repo on a feature branch, a bar appears just above the compose box showing the branch name and a live diff stat (`+60 -4`) — the total change between the branch's base (e.g. `main`) and the current working tree, including any uncommitted changes. Unlike the status-line pills above, this needs no configuration: it's computed natively from local `git` commands only (no `gh`, no network), and is desktop only, mirroring the status line's mobile no-op.

A **Create PR** split button sits on the right:

- **Create PR** — sends `/create-pr`, which asks Claude to push the branch if needed, run `gh pr create` with a title/description summarizing the session, and report back the PR URL.
- **Create draft PR** (dropdown) — same, but `gh pr create --draft`. Also available directly as `/create-pr --draft`.
- **Manually create PR** (dropdown) — skips Claude entirely and opens GitHub's compare page (`/compare/<base>...<branch>`) in your browser (Web Viewer or system browser, same convention as status-line pill links), so you can review the diff and open the PR yourself. Only enabled when the repo's `origin` remote points at GitHub.

The bar is hidden when the cwd isn't a git repo, when the branch can't be resolved (e.g. detached HEAD), or when you're already sitting on the base/default branch (nothing to open a PR against).

Once a PR exists for the thread (tracked via the same sticky `prUrl` used by the [status-line PR pill](#status-line-context-footer)), the primary button switches to **View PR**, opening it the same way pill links do, and a **View PR** item is prepended to the dropdown — the other three actions stay available in case you want to open another PR later.

### Safe plugin reload

Use **Claude Threads: Reload plugin (safe)** from the command palette instead of the host's built-in "Reload plugin" button. When no threads are running it reloads immediately. When threads are active it opens a modal showing their names with three choices: **Cancel** (keep working), **Interrupt & Reload** (sends an interrupt signal and waits up to 30 seconds for a clean shutdown), or **Force Reload** (kills sessions immediately). Reloading via any other path (Settings toggle, manifest hot-reload) triggers a graceful 10-second interrupt wait automatically before teardown.

### Diagnostics report

When the host app feels slow — the renderer pinning a core, typing lag, or a machine where an EDR/antivirus agent taxes every subprocess — Claude Threads keeps a small, **always-on, local-only** diagnostics layer running so you can capture what's actually happening. Nothing ever leaves your machine: there are no network calls and no remote reporting.

In the background it tracks a few cheap signals: how often the Kanban board rebuilds vs. how often a render was merely requested (measuring the incremental-render coalescing), how many `git`/status-line subprocesses were spawned, how many settings saves coalesced into actual disk writes, plus a ring of renderer CPU/memory samples (taken only while a plugin view is open) and a summary of any long main-thread tasks. It works identically in real Obsidian and in the Geode desktop app, and is a complete no-op on mobile.

Run **Claude Threads: Generate diagnostics report** from the command palette (or click **Copy diagnostics** in Settings → General → Diagnostics). It:

- copies a **redacted** Markdown report to your clipboard, ready to paste into a GitHub issue, and
- saves that Markdown plus a raw `.json` bundle into a `claude-threads-diagnostics/` folder in your vault root, then shows a Notice with the path.

The report is redacted by construction: it never includes message or file contents, absolute paths are collapsed to `~` or reduced to a basename (so no username or private directory layout leaks), and obvious `SECRET=value` strings are stripped. On mobile the command shows a "desktop only" Notice and does nothing.

You can turn the whole layer off with the **Diagnostics** toggle in Settings → General (it's on by default, which is safe because everything stays local); turning it off stops the sampler and freezes the counters.

## Agent tools reference

Every thread runs with built-in tools for vault access, session control, and — for multi-agent workflows — live coordination with other threads. Claude receives them through the host-neutral `claude_threads` MCP server; Codex receives the same canonical definitions through its dynamic-tool protocol. No configuration is required. The former `obsidian` server and `obsidian_*` names remain callable as deprecated compatibility aliases until the next major release, but new prompts and automation should use the canonical names below.

### Vault tools

Read and search your vault from within any thread.

| Tool | Parameters | Description |
|---|---|---|
| `vault_search` | `query`, `limit?` | Full-text search across all Markdown files. Tokenizes multi-word queries so each term is matched independently. Returns results ranked by relevance (filename hits weighted 10×) with a ~300-char excerpt from the densest matching region. Default limit: 20. |
| `vault_get_note_metadata` | `path` | Returns the full metadata cache entry for a note: frontmatter, tags, wikilinks, and headings. |
| `vault_get_backlinks` | `path` | Returns all notes that link to the specified file, with source path and original link text. |
| `vault_get_outgoing_links` | `path` | Returns all wikilinks and Markdown links a note makes to other files, with display text and resolved vault paths. |

### Workspace and host tools

Interact with the active Obsidian or Geode workspace.

| Tool | Parameters | Description |
|---|---|---|
| `workspace_get_active_file` | — | Returns metadata (path, basename, extension, size, mtime, ctime) for the file currently open in the editor, or `null` if nothing is open. |
| `workspace_get_open_tabs` | — | Returns all open tabs with path, title, view type, and which one is active. |
| `workspace_navigate_to_file` | `path`, `newLeaf?` | Opens a vault file in the editor. Pass `newLeaf: true` to open in a new tab. |
| `workspace_insert_at_cursor` | `text` | Inserts text at the cursor in the active editor, replacing any current selection. |
| `host_list_commands` | `query?` | Returns all registered host commands (id + name), sorted alphabetically. Pass a `query` string to filter. Use this to discover command IDs before calling `host_execute_command`. |
| `host_execute_command` | `commandId` | Runs any host command by its ID (e.g. `obsidian-git:push`, `editor:toggle-bold`). Third-party command IDs are unchanged. |
| `host_open_url` | `url`, `newTab?` | Opens a URL in the host Web Viewer panel. Reuses an existing tab by default; set `newTab: true` to force a fresh tab. |

### Session tools

Control the current thread's session state.

| Tool | Parameters | Description |
|---|---|---|
| `set_working_directory` | `path` | Changes the working directory for this session. Accepts an absolute path; `~` is expanded. Takes effect on the next turn. |
| `ScheduleWakeup` | `delaySeconds`, `prompt`, `reason` | Schedules a message to be injected into this thread after a delay. Useful for polling CI, waiting for a deploy, or self-pacing a loop. While the wake-up is pending the thread shows a waiting indicator — a "Waiting" group with a live countdown (`Resumes in 4m — <reason>`) in the Agent Dashboard and the [Kanban board](#kanban-board), and a banner above the chat input — each with a one-click Cancel. |
| `EnterWorktree` | `branch?`, `baseBranch?`, `repoPath?` | Creates a git worktree for the current repo and switches the session cwd to it. Automatically routed to the plugin's MCP implementation, which tracks the in-session cwd correctly after `set_working_directory`. |
| `ExitWorktree` | `worktreePath?`, `force?` | Removes the worktree and restores the session cwd to the original repo root. Defaults to the current effective cwd. Pass `force: true` to remove even if there are uncommitted changes. |
| `threads_create` | `prompt`, `title?`, `cwd?`, `projectId?` | Creates a persistent thread and immediately queues its initial prompt. Working directory and project inherit from the caller when omitted; pass `projectId: null` to clear the project. |
| `request_secret` | `secretName`, `reason`, `force?` | Prompts the user (via a modal) to provide a secret value such as an API key. The value is stored in the OS keychain under the plugin's namespace and injected into future sessions as an environment variable — it never appears in the conversation. Returns `{success: true, secretName, alreadyExisted: boolean}` if the user saves, or `{success: false, reason}` if cancelled. If a secret with the same name already exists, returns `alreadyExisted: true` immediately without prompting. Pass `force: true` to always re-prompt (e.g. when rotating a stale token) — the modal will indicate that the existing value will be replaced. |

### Thread coordination tools

Discover, read, and message other running threads. These tools enable agent-to-agent delegation — one thread can assign work to another, wait for it to finish, and read the result.

| Tool | Parameters | Description |
|---|---|---|
| `threads_get_current` | — | Returns this thread's metadata, live status, project, cwd, PR, schedule origin, raw-log path, and message count. |
| `threads_list` | — | Returns the same metadata for every thread, including live `isRunning` state. |
| `threads_list_projects` | — | Returns configured projects and their vault folders. |
| `threads_create_project` | `name`, `vaultFolder`, `description?`, `cwdOverride?` | Creates and persists a project. |
| `threads_set_project` | `threadId`, `projectId` | Assigns a thread to a project, or detaches it with `null`. |
| `threads_get_messages` | `threadId`, `limit?` | Returns recent user and assistant messages. |
| `threads_get_log` | `threadId?`, `limit?`, `type?` | Returns parsed raw JSONL event-log entries. |
| `threads_wait` | `threadId`, `timeoutSeconds?` | Waits until a target thread becomes idle. |
| `threads_send_message` | `threadId`, `message` | Queues a message on another thread and triggers it. |
| `threads_archive` | `threadId` | Saves and removes a completed thread. A thread cannot archive itself. |
| `threads_set_notes` | `threadId`, `notes` | Sets orchestrator tracking notes. |
| `threads_set_proposed_reply` | `threadId`, `text` | Stages a proposed reply for human approval. |
| `threads_clear_proposed_reply` | `threadId` | Clears a stale proposed reply. |

These three tools back the bundled **thread-orchestrator** skill (`resources/skills/thread-orchestrator`), which lets one thread supervise several peers: it tracks per-thread notes across polling passes and proposes replies for a human to review rather than sending on a peer's behalf.

**`isRunning` vs `status`:** `status` is a persisted field (`waiting`, `active`, `error`, `archived`, `reconnecting`) that reflects the last known state. `isRunning` is a live flag that is `true` only while Claude is actively streaming a response. Use `isRunning` for coordination decisions; use `status` to filter out archived or errored threads. `reconnecting` is a transient state covering two distinct auto-recovery paths that share the same status and visual treatment (an amber "reconnecting" notice in the conversation, not the red error card): (1) the underlying `claude` CLI transport was force-closed mid-tool-call (a spurious "Stream closed" error, not necessarily a real failure), and the plugin auto-fires one follow-up turn so Claude can verify whether the interrupted action actually succeeded before treating it as an error; or (2) the API rejected the turn with a rate-limit/overload error before it was ever processed, in which case the plugin silently retries the exact same turn after a backoff delay (up to 5 attempts, ~3s–90s) with no new message added to the transcript. If a rate-limited turn exhausts its retries, or any other error occurs, the error card shows a short one-line headline with the full stack trace tucked behind a "Show technical details" disclosure instead of a wall of raw text.

#### Coordination pattern

A typical delegation loop:

1. Call `threads_list` to find a peer, or `threads_create` to create a dedicated one
2. Call `threads_send_message` to assign a task
3. Call `threads_wait` to block until the peer finishes
4. Call `threads_get_messages` to read the result

```
Thread A                              Thread B
  │                                      │
  ├─ threads_list                         │
  ├─ threads_send_message ───────────────►│ (Claude receives message)
  ├─ threads_wait                         │
  │   (polls isRunning every 1s)         ├─ ... processes task ...
  │◄────────────────────────────────────┤ (isRunning → false)
  └─ threads_get_messages                 │
       (reads the result)
```

This pattern works across any combination of threads — you can fan out to multiple peers simultaneously by sending messages to several threads before waiting on any of them.

### Vault Bridges integration

If you have the [Vault Bridges](https://github.com/rbcodelabs/obsidian-vault-bridges) plugin installed, Claude agents can inspect and configure bridges directly via MCP — no config-file editing or host restart required.

| Tool | Parameters | Description |
|---|---|---|
| `vault_list_bridges` | — | Returns all currently configured bridges. Agents should call this first to check what already exists before adding a new one. |
| `vault_add_bridge` | `name`, `repoPath`, `vaultPath`, `sourcePath?`, `branch?`, `autoSync?`, `syncNow?` | Adds a new bridge live via the Vault Bridges API. The bridge is registered immediately and duplicate repo/vault pairs return the existing bridge. |

Both tools return a clear error if the vault-bridges plugin is not installed or not enabled.

#### Bridge-aware edits

When an agent edits files inside a bridged repo (rather than the synced vault copy), Claude Threads detects it automatically at the end of the turn:

- **Auto-pull** — each affected bridge is synced once per turn, so the vault copies update immediately (a notice confirms success or failure).
- **Vault-relative links** — edited-file chips, the focus button, and absolute repo paths in Claude's messages all resolve to the synced vault note: chips show the vault path and open the note in the host workspace, and message paths become clickable internal links (only when the vault copy exists).

Edits made directly to vault files are unaffected — they don't match any bridge root and behave as before. Note that edits made inside a temporary coding-task worktree only reach the vault after merge plus a normal bridge pull.

### Skills Manager tools

Everything the [Skills Manager](#skills-manager) panel can do — browse the [skills.sh](https://skills.sh) registry, inspect installed skills and configured sources, check for updates, install, uninstall — is also available to agents via MCP, so a thread can manage its own skill packages without a human clicking through the UI.

| Tool | Parameters | Description |
|---|---|---|
| `skills_list_installed` | — | Lists skills currently installed in `~/.claude/skills/`: name, description, install path, and which configured skill source (if any) each came from. |
| `skills_search` | `query`, `limit?` | Searches the skills.sh marketplace registry. Returns each match's name, slug, GitHub source, install count, and whether it's already installed. Default limit: 15. |
| `skills_get` | `identifier` | Returns full detail for one skill, whether installed or not. Pass an installed skill's name, or a marketplace slug in `owner/repo/skill-id` form (as returned by `skills_search`). Installed skills include their full `SKILL.md` content. |
| `skills_list_sources` | — | Lists configured skill sources (GitHub-cloned or local-path plugin sources) plus the built-in skills.sh registry, with id, name, type, and (for GitHub sources) staleness info. |
| `skills_check_updates` | — | Checks every configured GitHub-type skill source for upstream commits it's behind (`git fetch` + count). Returns each source's id, name, and either its refreshed `behindCount`/`lastFetched` or an `error` if the check failed (e.g. offline). |
| `skills_install` | `slug`, `skillId`, `source`, `name` | Installs a skill from the marketplace into `~/.claude/skills/`. Pass the four fields exactly as returned by `skills_search` for the skill you want. |
| `skills_uninstall` | `name` | Permanently deletes an installed skill by name. |
| `skills_update` | `sourceId` | Pulls the latest commits for a configured GitHub-type skill source (`git pull` on its local clone), refreshing every skill it provides. Use the source id from `skills_list_sources` — not `"registry"`, which has no single-source update (reinstall individual skills instead). |

## Settings

| Setting | Description |
|---|---|
| Claude binary path | Path to the `claude` executable (auto-detected) |
| Default working directory | `cwd` for new threads; defaults to vault root |
| Save threads to vault | Auto-save conversations as Markdown notes |
| Vault folder | Folder for saved thread notes (default: `Claude/`) |
| Extra environment variables | `KEY=VALUE` pairs injected into Claude's environment (useful for `AWS_PROFILE`, `AWS_REGION`) |
| Secret environment variables | Keychain-backed env vars (values stored in the OS keychain, never in `data.json`) — for API keys and tokens |
| Permission mode | How Claude handles tool-use confirmation. Options: `default` (CLI default), `acceptEdits` (auto-approve file edits), `bypassPermissions` (skip all prompts), `plan` (propose a plan first — see [Plan Mode](#plan-mode)), `dontAsk` (no dialogs; for unattended/scheduled sessions), `auto` (Claude decides). See [Permissions](#permissions). |
| Thinking mode | `disabled` (default), `enabled`, or `auto` — controls whether Claude uses extended thinking for harder problems |
| Thinking budget tokens | Maximum tokens Claude can spend on reasoning when thinking mode is `enabled` (default: 8 000). Only shown when thinking mode is `enabled` |
| Effort level | `default`, `low`, `medium`, or `high` — how much work Claude invests per turn. `default` uses the CLI setting |
| Agent progress summaries | Whether sub-agent progress is summarised and shown inline (default: on) |
| Enable 1M context (beta) | Opt-in to the 1-million-token context window beta (uses the `interleaved-thinking-2025-05-14` beta flag) |
| Ephemeral session | When on, sessions are not persisted to disk — they cannot be resumed after the thread closes |
| Layout density | `Comfortable`, `Compact`, or `Spacious` — controls message spacing and padding |
| Enable summarization | Show the summarize button and auto-summarize |
| Auto-summarize after response | Regenerate summary + tab name after each assistant turn |
| Claude summarization model | Model alias for summarization (e.g. `haiku`, `sonnet`) |
| Escalation keyword | Keyword that routes a single turn to the escalation model (default: `/escalate`) |
| Escalation model | Model the escalation keyword targets (default: Opus) |
| Keep computer awake | Prevent the Mac from sleeping while Claude is processing; shows ☕ in the status bar |
| Context footer command | Shell command that produces the status-line pills (JSON tags or plaintext). Run per-thread against its cwd; receives `{cwd, workspace, provider}` on stdin. Desktop only. See [Status line](#status-line-context-footer). |
| Projects | Group threads by vault sub-folder with a shared context prompt |
| Auto-collapse side panel | Collapse the left, right, or both sidebars when the Kanban board opens, restoring them when it closes (default: `None`). See [Kanban board](#kanban-board). |
| Stack scheduled job threads | Collapse repeat runs of the same scheduled/cron job into an expandable rollup in the Kanban board's quiet columns and the Agent Dashboard's Scheduled Jobs section (default: on). See [Kanban board](#kanban-board) and [Agent dashboard](#agent-dashboard). |
| Diagnostics | Enable the always-on, local-only telemetry layer (counters + renderer CPU/memory samples) that powers the [Diagnostics report](#diagnostics-report). Nothing leaves your machine; on by default. Desktop only. |
| Remote access | Enable/disable mobile remote access via WebSocket relay |
| Room ID | Shared secret used to pair mobile (rotate to revoke all access) |
| Show pairing QR | Display a QR code for one-time mobile pairing (expires in 5 minutes) |

## Building from source

```bash
git clone https://github.com/rbcodelabs/obsidian-claude-threads
cd obsidian-claude-threads
npm install
npm run build
# Output is in dist/
```

## Releasing

The project uses a worktree-based workflow — edits directly to the main checkout are blocked by a git hook. Follow these steps:

1. **Create a worktree** for the version bump:
   ```bash
   git worktree add .claude/worktrees/chore/bump-version-X.Y.Z -b chore/bump-version-X.Y.Z
   cd .claude/worktrees/chore/bump-version-X.Y.Z
   ```

2. **Bump the version** in `manifest.json` and `package.json` (both must match), then commit and push:
   ```bash
   git add manifest.json package.json
   git commit -m "chore: bump version to vX.Y.Z"
   git push -u origin chore/bump-version-X.Y.Z
   ```

3. **Open and squash-merge a PR** for the version bump:
   ```bash
   gh pr create --title "chore: bump version to vX.Y.Z" --body "Version bump." --base main
   gh pr merge <number> --squash --delete-branch
   ```

4. **Pull main and push the tag** to trigger the release workflow:
   ```bash
   git pull origin main
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

5. That's it. The [release workflow](.github/workflows/release.yml) automatically builds the plugin and publishes a GitHub release with `main.js`, `styles.css`, and `manifest.json` attached — BRAT will pick it up within a few minutes.

## License

MIT
