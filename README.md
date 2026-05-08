# Claude Threads for Obsidian

A native Obsidian sidebar plugin for running multiple Claude Code sessions in parallel — with streaming markdown responses, tab management, and deep vault integration.

![Claude Threads](https://img.shields.io/badge/Obsidian-Plugin-7C3AED) ![Version](https://img.shields.io/badge/version-0.1.25-blue)

<p align="center">
  <img src="docs/screenshot-main.png" width="380" alt="Main view showing a conversation with code blocks and multiple tabs" />
</p>

<p align="center">
  <img src="docs/screenshot-slash-commands.png" width="380" alt="Slash command autocomplete showing installed skills" />
  &nbsp;&nbsp;
  <img src="docs/screenshot-permission.png" width="380" alt="Permission dialog for file writes" />
</p>

## What it does

Claude Threads embeds Claude Code directly in your Obsidian sidebar. Each tab is an independent Claude Code session with its own working directory and conversation history. You can run multiple sessions in parallel — one debugging a bug, another drafting docs, another answering questions about your vault.

**Key features:**

- **Multi-tab sessions** — open as many Claude threads as you need, switch between them instantly
- **Streaming responses** — tokens stream in with live markdown rendering (code blocks, tables, lists, etc.)
- **Persistent conversations** — sessions resume where you left off after restarting Obsidian
- **Auto-naming** — tabs rename themselves based on what you're working on (powered by the summarizer)
- **Thread summaries** — a header bar shows what each thread is about, auto-updated after each response
- **Slash command autocomplete** — type `/` to browse your installed `~/.claude/skills/` with descriptions
- **Permission dialogs** — Claude asks before writing files or running commands; you approve or deny inline
- **Tool call visibility** — see exactly which files Claude is reading/writing during each response
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
3. Enter: `richardbowman/obsidian-claude-threads`
4. Enable **Claude Threads** in Settings → Community Plugins

### Manual install

1. Download the latest release from [GitHub Releases](https://github.com/richardbowman/obsidian-claude-threads/releases)
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
- **`/`** — opens skill autocomplete (browse `~/.claude/skills/`)

### Slash commands / Skills

Type `/` in the input box to see all your installed Claude Code skills with descriptions. Select with arrow keys, Tab, or Enter — the skill name is inserted into your message and Claude handles it naturally via your `CLAUDE.md` configuration.

### Permissions

When Claude needs to write a file or run a command, a dialog appears asking you to **Allow** or **Deny**. This mirrors Claude Code's permission system. You can change the default behavior in settings.

### Thread summaries

A summary bar above the messages shows what the thread is about. It updates automatically after each response if **Auto-summarize** is enabled, or you can trigger it manually with the brain icon. The summarizer also updates the tab name.

## Settings

| Setting | Description |
|---|---|
| Claude binary path | Path to the `claude` executable (auto-detected) |
| Default working directory | `cwd` for new threads; defaults to vault root |
| Save threads to vault | Auto-save conversations as Markdown notes |
| Vault folder | Folder for saved thread notes (default: `Claude/`) |
| Extra environment variables | `KEY=VALUE` pairs injected into Claude's environment (useful for `AWS_PROFILE`, `AWS_REGION`) |
| Permission mode | `Accept edits automatically`, `Bypass all permissions`, or `Prompt for permissions` |
| Enable summarization | Show the summarize button and auto-summarize |
| Auto-summarize after response | Regenerate summary + tab name after each assistant turn |
| Mode | `Claude (via CLI)` uses your existing auth; `Remote endpoint` calls an OpenAI-compatible server |
| Claude summarization model | Model alias for summarization (e.g. `haiku`, `sonnet`) |

## Building from source

```bash
git clone https://github.com/richardbowman/obsidian-claude-threads
cd obsidian-claude-threads
npm install
npm run build
# Output is in dist/
```

Symlink `dist/` into your vault's plugins folder for live development:

```bash
ln -s $(pwd)/dist ~/.obsidian/plugins/claude-threads
```

## License

MIT
