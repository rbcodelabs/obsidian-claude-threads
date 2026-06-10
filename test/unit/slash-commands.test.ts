import { describe, it, expect } from 'vitest';
import {
  DISPATCH_BUILTIN_COMMANDS,
  DISPATCH_ARG_COMPLETIONS,
  THREAD_BUILTIN_COMMANDS,
} from '../../src/slashCommands';

describe('DISPATCH_BUILTIN_COMMANDS', () => {
  it('advertises exactly the commands the dispatch flow intercepts', () => {
    expect(DISPATCH_BUILTIN_COMMANDS.map((c) => c.name)).toEqual(['model', 'goal', 'loop']);
  });

  it('never advertises session-scoped commands (/compact, /clear, /cost)', () => {
    const names = new Set(DISPATCH_BUILTIN_COMMANDS.map((c) => c.name));
    for (const sessionOnly of ['compact', 'clear', 'cost']) {
      expect(names.has(sessionOnly)).toBe(false);
    }
  });

  it('stays a subset of the thread command list (single source of truth)', () => {
    const threadNames = new Set(THREAD_BUILTIN_COMMANDS.map((c) => c.name));
    for (const c of DISPATCH_BUILTIN_COMMANDS) {
      expect(threadNames.has(c.name)).toBe(true);
    }
  });

  it('only offers arg completions for commands with fixed argument sets', () => {
    // /model has a fixed alias list; /goal and /loop take free text at
    // dispatch (clear/stop are thread-only and must not be suggested).
    expect(Object.keys(DISPATCH_ARG_COMPLETIONS)).toEqual(['model']);
    expect(DISPATCH_ARG_COMPLETIONS.model.length).toBeGreaterThan(0);
  });
});
