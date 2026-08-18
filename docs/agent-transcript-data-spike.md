# Child-agent transcript data availability

Checked against the installed Claude Agent SDK `0.3.233`, the Codex app-server
notification handling in `CodexSession`, and the repository's current fixtures.

| Harness | Stable child-agent events observed | Full child transcript? |
|---|---|---|
| Claude | `task_started` (id, description, task/subagent type, parent id, model), `task_progress` (description, last tool name, optional summary), `task_updated` (status/description/error), and `task_notification` (terminal status and summary) | No. The SDK stream exposes lifecycle and progress summaries to the parent session, but no child-scoped user/assistant message stream. |
| Codex | `collabAgentToolCall` (spawn prompt, sender/receiver thread ids, model, aggregate agent states) and `subAgentActivity` (agent/parent thread id, activity kind, model) | No. Current app-server items expose lifecycle/activity and final state, but not the child thread's message items. |

Therefore the durable model keeps lifecycle/activity events and reserves an
optional `transcript` field for a future verified native feed. Current Claude
and Codex child views are explicitly titled **Agent activity**; they are never
presented as full conversations.
