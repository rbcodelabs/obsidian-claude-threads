import { describe, it, expect } from 'vitest';
import { parseDispatchDirective, goalKickoffMessage } from '../../src/slashCommands';

describe('parseDispatchDirective', () => {
  it('returns null for plain prompts', () => {
    expect(parseDispatchDirective('fix the login bug')).toBeNull();
  });

  it('returns null for unhandled slash commands', () => {
    expect(parseDispatchDirective('/compact')).toBeNull();
    expect(parseDispatchDirective('/cost')).toBeNull();
  });

  // ── /model ────────────────────────────────────────────────────────────────

  it('delegates /model to the model prefix parser', () => {
    expect(parseDispatchDirective('/model opus fix the bug')).toEqual({
      kind: 'model',
      model: 'opus',
      rest: 'fix the bug',
      error: undefined,
    });
  });

  it('surfaces /model errors', () => {
    expect(parseDispatchDirective('/model gpt5 do it')?.error).toContain('Unknown model');
  });

  // ── /goal ────────────────────────────────────────────────────────────────

  it('parses /goal with text', () => {
    expect(parseDispatchDirective('/goal ship the v1 login flow')).toEqual({
      kind: 'goal',
      goal: 'ship the v1 login flow',
    });
  });

  it('preserves multi-line goal text', () => {
    const d = parseDispatchDirective('/goal ship v1\nwith tests');
    expect(d).toEqual({ kind: 'goal', goal: 'ship v1\nwith tests' });
  });

  it('errors on bare /goal', () => {
    const d = parseDispatchDirective('/goal');
    expect(d?.kind).toBe('goal');
    expect(d?.error).toContain('Include a goal');
  });

  it('errors on /goal clear|off|done (thread-only variants)', () => {
    for (const arg of ['clear', 'off', 'done']) {
      const d = parseDispatchDirective(`/goal ${arg}`);
      expect(d?.kind).toBe('goal');
      expect(d?.error).toContain('inside a thread');
    }
  });

  it('does not treat /goals as a goal command', () => {
    expect(parseDispatchDirective('/goals for the week')).toBeNull();
  });

  // ── /loop ────────────────────────────────────────────────────────────────

  it('parses /loop with interval and prompt', () => {
    expect(parseDispatchDirective('/loop 10m check CI status')).toEqual({
      kind: 'loop',
      intervalSeconds: 600,
      prompt: 'check CI status',
    });
  });

  it('treats a bare number interval as minutes', () => {
    expect(parseDispatchDirective('/loop 5 check the build')).toEqual({
      kind: 'loop',
      intervalSeconds: 300,
      prompt: 'check the build',
    });
  });

  it('clamps tiny intervals to the minimum', () => {
    const d = parseDispatchDirective('/loop 1s poll the queue');
    expect(d?.kind).toBe('loop');
    expect((d as { intervalSeconds: number }).intervalSeconds).toBeGreaterThanOrEqual(30);
  });

  it('errors on bare /loop or missing prompt', () => {
    expect(parseDispatchDirective('/loop')?.error).toContain('Usage: /loop');
    expect(parseDispatchDirective('/loop 10m')?.error).toContain('Usage: /loop');
  });

  it('errors on /loop stop|off|cancel|clear (thread-only variants)', () => {
    for (const arg of ['stop', 'off', 'cancel', 'clear']) {
      const d = parseDispatchDirective(`/loop ${arg}`);
      expect(d?.kind).toBe('loop');
      expect(d?.error).toContain('inside a thread');
    }
  });

  it('does not treat /loops as a loop command', () => {
    expect(parseDispatchDirective('/loops everywhere')).toBeNull();
  });
});

describe('goalKickoffMessage', () => {
  it('embeds the goal text', () => {
    const msg = goalKickoffMessage('ship v1');
    expect(msg).toContain('"ship v1"');
    expect(msg).toContain('Work toward the goal');
  });
});
