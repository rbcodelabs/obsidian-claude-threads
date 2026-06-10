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
 * new thread from the typed text. /goal and /loop are thread-scoped commands
 * handled by ThreadsView, so they're excluded here.
 */
export const DISPATCH_BUILTIN_COMMANDS: SlashCommand[] = THREAD_BUILTIN_COMMANDS.filter(
  (c) => c.name !== 'goal' && c.name !== 'loop',
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

/**
 * Maps /model argument aliases to the model id passed to the CLI.
 * `undefined` means "reset to the default model". Shared by ThreadsView
 * (thread-scoped /model) and the dispatch boxes (leading /model prefix).
 */
export const MODEL_ALIASES: Record<string, string | undefined> = {
  fable: 'fable',
  opus: 'opus',
  sonnet: 'sonnet',
  haiku: 'haiku',
  default: undefined,
  reset: undefined,
};

export interface DispatchModelPrefix {
  /** Resolved model id, or undefined for default/reset. Unset when error is present. */
  model?: string;
  /** Prompt text remaining after the /model command. */
  rest: string;
  /** Set when the command is malformed (missing or unknown model name). */
  error?: string;
}

export const MODEL_USAGE_HINT = 'Usage: /model fable|opus|sonnet|haiku|default <prompt>';

/**
 * Parses a leading "/model <name>" prefix on text typed into a dispatch box.
 * Returns null when the text is not a /model command (dispatch it as-is).
 * Returns { error } when the model name is missing or unknown.
 * Otherwise returns the resolved model and the remaining prompt text —
 * callers decide how to handle an empty prompt (e.g. images may be attached).
 */
export function parseDispatchModelPrefix(text: string): DispatchModelPrefix | null {
  if (!/^\/model(\s|$)/i.test(text.trim())) return null;
  const m = text.trim().match(/^\/model\s+(\S+)\s*([\s\S]*)$/i);
  if (!m) return { rest: '', error: MODEL_USAGE_HINT };
  const arg = m[1].toLowerCase();
  if (!(arg in MODEL_ALIASES)) {
    return { rest: m[2].trim(), error: `Unknown model "${m[1]}". Use: fable, opus, sonnet, haiku, default` };
  }
  return { model: MODEL_ALIASES[arg], rest: m[2].trim() };
}
