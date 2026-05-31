# Claude Threads for Obsidian

A native Obsidian sidebar plugin for running multiple Claude Code sessions in parallel — with streaming markdown responses, tab management, and deep vault integration.

![Claude Threads](https://img.shields.io/badge/Obsidian-Plugin-7C3AED) ![Version](https://img.shields.io/badge/version-0.8.0-blue)

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

Claude Threads embeds Claude Code directly in your Obsidian sidebar. Each tab is an independent Claude Code session with its own working directory and conversation history. You can run multiple sessions in parallel — one debugging a bug, another drafting docs, another answering questions about your vault.

**Key features:**

- **Multi-tab sessions** — open as many Claude threads as you need, switch between them instantly
- **Streaming responses** — tokens stream in with live markdown rendering (code blocks, tables, lists, etc.)
- **Persistent conversations** — sessions resume where you left off after restarting Obsidian
- **Auto-naming** — tabs rename themselves based on what you're working on (powered by the summarizer)
- **Thread summaries** — a header bar shows what each thread is about, auto-updated after each response
- **Agent dashboard** — monitor and dispatch to multiple threads from a single view; attach images or files to dispatched tasks via the paperclip button or drag-and-drop; resolve pending permission requests directly from dashboard rows without switching threads; toggle between list view and **kanban board** to visualize agent state by column (idle, running, waiting, done)
- **Focus edited files** — one click closes all other tabs and opens only the files Claude touched in this thread, snapping your workspace to the work
- **Workspace tab syncing** — the Obsidian workspace tab title automatically reflects the active thread so you always know which session is which
- **Slash commands** — built-in context commands plus your full `~/.claude/skills/` library, browseable with `/`
- **Model switching** — set a persistent model per thread with `/model opus|sonnet|haiku`
- **Context compaction** — auto and manual compaction shown as persistent dividers in the conversation
- **Permission dialogs** — Claude asks before writing files or running commands; you approve or deny inline
- **@ file mentions** — type `@` in the input to search vault files by name; selecting one injects its full content into the prompt as context; type `@this` to reference the currently open file without searching
- **Push-to-talk voice input** — hold a configurable hotkey to dictate a message via speech-to-text (uses the Claude Code STT pipeline); transcript populates the input box ready to send or edit
- **Projects** — group threads by vault sub-folder with a shared context prompt injected into every message
- **Draft persistence** — input text and attachments auto-save when switching threads and survive plugin reloads
- **Context recap banner** — when you return to a thread you haven't viewed in over a minute, a floating banner shows the thread summary and how long ago you were last active; auto-dismisses after 10 seconds
- **Keep computer awake** — prevents the Mac from sleeping while Claude is active; shows a ☕ indicator in the status bar (uses `caffeinate -i` on macOS, Web Lock API as fallback)
- **Tool call visibility** — see exactly which files Claude is reading/writing during each response
- **Cancel and restore** — press Escape (or click Stop) while Claude is running to cancel; the sent message pops back into the input box ready to edit and re-send
- **Keyboard shortcuts** — navigate tabs without touching the mouse

## Prerequisites

- [Obsidian](https://obsidian.md) v1.0.0 or later (desktop only)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
  - The plugin auto-detects `claude` at `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`, or `~/.local/bin/claude`
  - AWS Bedrock / SSO users: set `AWS_PROFILE` and `AWS_REGION` in the plugin's Extra Environment Variables setting

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

### Slash commands

Type `/` in the input box to see built-in context commands and your installed Claude Code skills. Navigate with arrow keys, Tab, or Enter.

**Built-in commands** (handled by the plugin):

| Command | What it does |
|---|---|
| `/model opus\|sonnet\|haiku` | Set a persistent model for this thread |
| `/model default` | Reset thread model back to the global default |
| `/model` | Show the current model for this thread |
| `/compact` | Summarize conversation history to free up context window |
| `/clear` | Clear conversation history and start a fresh session |
| `/cost` | Show token usage and cost for the current session |

**Skills** — any `.md` file (or directory) in `~/.claude/skills/` appears below the built-in commands. Selecting one inserts the skill name into your message, which Claude handles via your `CLAUDE.md` configuration.

### @ file mentions

Type `@` anywhere in the input box to search vault files by name. A dropdown appears showing up to 20 matching files — navigate with arrow keys and press Tab or Enter to insert.

<p align="center">
  <img src="docs/screenshot-file-mention.png" width="800" alt="@ file mention autocomplete — type @ to search vault files and inject their content as context" />
</p>

Selecting a file inserts `@[[filename]]` into your message. When you send the message, the plugin resolves each mention and appends the file's full content as context for Claude — useful for asking Claude to work with a specific note, doc, or config file without copying and pasting.

Type `@this` (no search needed) to instantly reference the currently active file in Obsidian. It resolves to the same `@[[filename]]` injection at send time.

### Model switching

`/model` sets the model for all subsequent turns in a thread:

```
/model opus     → uses Claude Opus for every turn in this thread
/model sonnet   → switches to Sonnet
/model haiku    → switches to Haiku
/model default  → resets to whatever Claude Code's default is
```

The active model is shown as a badge in the thread info bar. You can also use `/opus` as a one-turn override (controlled by the Opus Escalation Keyword setting) — it applies only to that message, then the thread model resumes.

### Context compaction

When the context window fills up, Claude compacts the conversation automatically. You can also trigger it manually with `/compact`. Either way, a divider appears in the conversation showing when compaction happened and how many tokens were in context beforehand. Compaction markers are persisted and survive plugin reloads.

### Agent dashboard

Open the **Agent Dashboard** from the ribbon or command palette to see all threads at a glance. Each thread appears as a row showing its name, working directory, current model, and status.

**Live activity (running threads):** While a thread is actively processing, the dashboard shows a live one-line summary of the current tool call or step — so you can see "Reading src/components/Header.tsx" or "Running npm test" without switching to that tab.

**Auto-generated summaries (idle threads):** After each completed response, the summarizer runs in a lightweight background process (a separate Claude Code instance using a small model) and writes a multi-sentence recap of what that thread worked on. This summary is shown in the dashboard row so you can re-orient yourself to any thread at a glance — what it accomplished, what files it touched, what's left to do.

This combination means you can dispatch several threads in parallel, switch to other work, then return to the dashboard to understand the state of every agent without reading through each conversation.

You can also send messages to any thread directly from the dashboard without switching tabs.

Toggle the **Kanban** button in the dashboard toolbar to switch from the default list view to a board layout with columns for each agent state: idle, running, waiting for permission, and done. List view is the default; the preference is persisted across reloads.

### Push-to-talk voice input

Hold the configured push-to-talk key (default: none — set it in Settings → Push to Talk Hotkey) and speak. The microphone activates while you hold the key; releasing it stops recording and transcribes your speech using the Claude Code STT pipeline. The transcript populates the input box so you can review and edit before sending. The floating input panel highlights while recording so you always know the mic is live.

### Permissions

When Claude needs to write a file or run a command, a permission card appears inline in the conversation asking you to **Allow**, **Deny**, or **Always Allow**. Always Allow adds the tool to a per-vault allowlist so you're never asked again for that tool. You can also resolve permissions directly from the Agent Dashboard without switching threads. The default behavior can be changed globally in settings.

### Remote access (mobile)

Claude Threads can mirror your desktop sessions to Obsidian Mobile in real time. Your phone becomes a thin client: you can read the conversation as it streams, send messages, approve permission requests, and switch between threads — all over a secure WebSocket relay. The desktop does all the actual Claude work; mobile just shows the state.

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

**Limitations:**

- Desktop must be running and connected — mobile cannot start new Claude sessions without desktop
- Mobile is a read-mostly thin client; it cannot access your vault files or run tools directly
- One desktop per room ID; rotate the room ID in settings to revoke all mobile access

<p align="center">
  <img src="docs/screenshot-mobile-connected.png" width="800" alt="Mobile remote access — desktop sessions mirrored to your phone in real time" />
</p>

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

### Vault Bridges integration

If you have the [Vault Bridges](https://github.com/rbcodelabs/obsidian-vault-bridges) plugin installed, Claude agents can inspect and configure bridges directly via MCP — no config-file editing or Obsidian restarts required.

Two tools are exposed:

| Tool | What it does |
|---|---|
| `obsidian_list_vault_bridges` | Returns all currently configured bridges. Agents should call this first to check what already exists before adding a new one. |
| `obsidian_add_vault_bridge` | Adds a new bridge live via the Vault Bridges API. The bridge is registered immediately — the status bar updates, per-bridge push/pull commands are wired up, and settings are saved. If a bridge with the same `repoPath` + `vaultPath` already exists, the existing record is returned without creating a duplicate. |

Both tools return a clear error if the vault-bridges plugin is not installed or not enabled.

## Settings

| Setting | Description |
|---|---|
| Claude binary path | Path to the `claude` executable (auto-detected) |
| Default working directory | `cwd` for new threads; defaults to vault root |
| Save threads to vault | Auto-save conversations as Markdown notes |
| Vault folder | Folder for saved thread notes (default: `Claude/`) |
| Extra environment variables | `KEY=VALUE` pairs injected into Claude's environment (useful for `AWS_PROFILE`, `AWS_REGION`) |
| Permission mode | `Accept edits automatically`, `Bypass all permissions`, or `Prompt for permissions` |
| Layout density | `Comfortable` or `Compact` — controls message spacing and padding |
| Enable summarization | Show the summarize button and auto-summarize |
| Auto-summarize after response | Regenerate summary + tab name after each assistant turn |
| Claude summarization model | Model alias for summarization (e.g. `haiku`, `sonnet`) |
| Opus escalation keyword | Keyword that triggers Opus for a single turn (default: `/opus`) |
| Keep computer awake | Prevent the Mac from sleeping while Claude is processing; shows ☕ in the status bar |
| Projects | Group threads by vault sub-folder with a shared context prompt |
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

To auto-sync builds to your local Obsidian vault during development, create a `.env.local` file in the project root:

```
OBSIDIAN_PLUGIN_DIR=/path/to/your/vault/.obsidian/plugins/claude-threads
```

Then run `npm run dev` — every rebuild will copy `main.js`, `styles.css`, and `manifest.json` to your vault automatically.

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
