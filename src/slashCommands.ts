/**
 * Shared definitions for built-in slash commands shown in the DispatchInput
 * autocomplete dropdown. Single source of truth — ThreadsView, AgentDashboard,
 * and KanbanView all import from here so the lists can't drift apart.
 */

export interface SlashCommand {
  name: string;
  description: string;
}

/** Commands available inside an open thread (ThreadsView intercepts all of these). */
export const THREAD_BUILTIN_COMMANDS: SlashCommand[] = [
  { name: 'compact', description: 'Summarize conversation history to free up context' },
  { name: 'clear', description: 'Clear conversation history and start fresh' },
  { name: 'cost', description: 'Show token usage and cost for this session' },
  { name: 'model', description: 'Set persistent model: /model fable|opus|sonnet|haiku|default' },
  { name: 'goal', description: 'Set a persistent goal for this thread: /goal <text> · /goal clear' },
  { name: 'loop', description: 'Re-run a prompt on an interval: /loop 5m <prompt> · /loop stop' },
];

/**
 * Commands advertised in the dashboard/kanban dispatch boxes, which create a
 * new thread from the typed text. Allowlist: only /model makes sense when
 * dispatching a brand-new thread — the rest (/compact, /clear, /cost, /goal,
 * /loop) are thread-scoped and meaningless before a session exists.
 */
export const DISPATCH_BUILTIN_COMMANDS: SlashCommand[] = THREAD_BUILTIN_COMMANDS.filter(
  (c) => c.name === 'model',
);

/** Argument completions for /model — shown after typing "/model ". */
export const MODEL_ARG_COMPLETIONS: SlashCommand[] = [
  { name: 'fable', description: 'Claude Fable 5 — most capable' },
  { name: 'opus', description: 'Claude Opus' },
  { name: 'sonnet', description: 'Claude Sonnet — speed/quality balance' },
  { name: 'haiku', description: 'Claude Haiku — fastest, cheapest' },
  { name: 'default', description: 'Reset to the Default model setting / CLI default' },
];

/** Argument completions keyed by command name, for DispatchInput.argCompletions. */
export const THREAD_ARG_COMPLETIONS: Record<string, SlashCommand[]> = {
  model: MODEL_ARG_COMPLETIONS,
  goal: [{ name: 'clear', description: 'Clear the goal for this thread' }],
  loop: [{ name: 'stop', description: 'Stop the loops running in this thread' }],
};

export const DISPATCH_ARG_COMPLETIONS: Record<string, SlashCommand[]> = {
  model: MODEL_ARG_COMPLETIONS,
};
