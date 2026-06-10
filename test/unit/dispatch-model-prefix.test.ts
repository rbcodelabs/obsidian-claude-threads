import { describe, it, expect } from 'vitest';
import { parseDispatchModelPrefix, MODEL_USAGE_HINT } from '../../src/slashCommands';

describe('parseDispatchModelPrefix', () => {
  it('returns null for plain prompts', () => {
    expect(parseDispatchModelPrefix('fix the login bug')).toBeNull();
  });

  it('returns null for other slash commands', () => {
    expect(parseDispatchModelPrefix('/compact')).toBeNull();
    expect(parseDispatchModelPrefix('/goal ship v1')).toBeNull();
  });

  it('returns null when /model is a prefix of a longer word', () => {
    expect(parseDispatchModelPrefix('/modeling clay tips')).toBeNull();
  });

  it('parses a valid model and remaining prompt', () => {
    expect(parseDispatchModelPrefix('/model opus fix the login bug')).toEqual({
      model: 'opus',
      rest: 'fix the login bug',
    });
  });

  it('is case-insensitive for the command and model name', () => {
    expect(parseDispatchModelPrefix('/Model OPUS do it')).toEqual({
      model: 'opus',
      rest: 'do it',
    });
  });

  it('preserves multi-line prompt text', () => {
    const parsed = parseDispatchModelPrefix('/model haiku line one\nline two');
    expect(parsed).toEqual({ model: 'haiku', rest: 'line one\nline two' });
  });

  it('resolves default and reset to undefined model', () => {
    expect(parseDispatchModelPrefix('/model default do it')).toEqual({
      model: undefined,
      rest: 'do it',
    });
    expect(parseDispatchModelPrefix('/model reset do it')).toEqual({
      model: undefined,
      rest: 'do it',
    });
  });

  it('returns empty rest when no prompt follows the model name', () => {
    expect(parseDispatchModelPrefix('/model sonnet')).toEqual({
      model: 'sonnet',
      rest: '',
    });
  });

  it('returns a usage error for bare /model', () => {
    expect(parseDispatchModelPrefix('/model')).toEqual({
      rest: '',
      error: MODEL_USAGE_HINT,
    });
    expect(parseDispatchModelPrefix('/model   ')).toEqual({
      rest: '',
      error: MODEL_USAGE_HINT,
    });
  });

  it('returns an error for an unknown model name', () => {
    const parsed = parseDispatchModelPrefix('/model gpt5 do it');
    expect(parsed?.error).toContain('Unknown model "gpt5"');
    expect(parsed?.rest).toBe('do it');
  });

  it('tolerates leading whitespace', () => {
    expect(parseDispatchModelPrefix('  /model fable hi')).toEqual({
      model: 'fable',
      rest: 'hi',
    });
  });
});
