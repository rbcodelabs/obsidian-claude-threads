import { describe, it, expect } from 'vitest';
import {
  DISPATCH_BUILTIN_COMMANDS,
  DISPATCH_ARG_COMPLETIONS,
  THREAD_BUILTIN_COMMANDS,
} from '../../src/slashCommands';

describe('DISPATCH_BUILTIN_COMMANDS', () => {
  it('only advertises /model — the rest are thread-scoped and meaningless at dispatch', () => {
    expect(DISPATCH_BUILTIN_COMMANDS.map((c) => c.name)).toEqual(['model']);
  });

  it('stays a subset of the thread command list (single source of truth)', () => {
    const threadNames = new Set(THREAD_BUILTIN_COMMANDS.map((c) => c.name));
    for (const c of DISPATCH_BUILTIN_COMMANDS) {
      expect(threadNames.has(c.name)).toBe(true);
    }
  });

  it('has arg completions for every advertised dispatch command', () => {
    for (const c of DISPATCH_BUILTIN_COMMANDS) {
      expect(DISPATCH_ARG_COMPLETIONS[c.name]?.length).toBeGreaterThan(0);
    }
  });
});
