# Native agent workspace

Claude Threads preserves harness-native child agents as durable `AgentRun` records. When Claude or Codex reports an agent, the parent conversation shows an **Agent Team** tree. Select an agent to inspect its harness-exposed activity, lifecycle, errors, result, and hierarchy without creating a separate thread.

The Agent Dashboard also shows compact child-agent entries. Agent role, task, and current activity are included in dashboard search.

## Current capability matrix

| Harness | Stable child ID | Lifecycle/activity | Parent linkage | Direct message from UI | Interrupt one agent from UI |
|---|---:|---:|---:|---:|---:|
| Claude Agent SDK 0.3.233 | Yes (`task_id`) | Yes (`task_started`, `task_updated`, `task_progress`, notifications) | Used when `parent_task_id` is present | No verified public `Query` method | No verified public `Query` method |
| Codex app-server | Yes (`receiverThreadIds`, `agentThreadId`) | Yes (`collabAgentToolCall`, `agentsStates`, `subAgentActivity`) | Used when the event provides `senderThreadId`/`parentThreadId` | No verified host-callable path | No verified host-callable path |

The Claude SDK defines model-invoked `SendMessage` and `TaskStop` tool inputs, but its public host-side `Query` surface exposes only whole-query interruption. Claude Threads does not pretend those model tools are direct UI controls. Codex collaboration events similarly prove observation, not a callable host control. Consequently, the detail view explains that direct message and single-agent interrupt are unavailable, and never redirects an attempted child action to `main`.

## Persistence and recovery

Agent runs are persisted with their owning thread in plugin data. Terminal history survives reload. A run that was active when Obsidian closed is restored as **unavailable** until its harness reports live activity again. Duplicate native events are replay-safe, and a child whose parent arrives later is reattached automatically.

Background shell jobs and local workflow phases remain ordinary tasks; they are not promoted to conversational agents.
# Compact status and child-agent navigation

The conversation footer shows aggregate native-agent status beside the working
folder. Activating it opens and focuses the current thread in the Agent
Dashboard without filtering away other threads. Selecting a child agent opens
its scoped central-pane view; breadcrumbs return to its parent or the main
conversation. The composer is disabled because current Claude and Codex host
protocols do not expose direct child messaging.

Current host event coverage is documented in
[`agent-transcript-data-spike.md`](agent-transcript-data-spike.md). Both harnesses
currently provide lifecycle/activity summaries but not full child transcripts,
so these views are labeled **Agent activity**.
