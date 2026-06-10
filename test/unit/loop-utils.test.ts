import { describe, it, expect } from 'vitest';
import { parseLoopArgs, formatLoopInterval, MIN_LOOP_INTERVAL_SECONDS } from '../../src/loopUtils';

describe('parseLoopArgs', () => {
  it('parses seconds', () => {
    expect(parseLoopArgs('45s check the build')).toEqual({
      intervalSeconds: 45,
      prompt: 'check the build',
    });
  });

  it('parses minutes', () => {
    expect(parseLoopArgs('5m check CI')).toEqual({
      intervalSeconds: 300,
      prompt: 'check CI',
    });
  });

  it('parses hours', () => {
    expect(parseLoopArgs('2h summarize inbox')).toEqual({
      intervalSeconds: 7200,
      prompt: 'summarize inbox',
    });
  });

  it('defaults a bare number to minutes', () => {
    expect(parseLoopArgs('10 poll the deploy')).toEqual({
      intervalSeconds: 600,
      prompt: 'poll the deploy',
    });
  });

  it('accepts long unit names', () => {
    expect(parseLoopArgs('3 mins do a thing')?.intervalSeconds).toBe(180);
    expect(parseLoopArgs('1 hr do a thing')?.intervalSeconds).toBe(3600);
  });

  it('clamps to the minimum interval', () => {
    expect(parseLoopArgs('1s spam')?.intervalSeconds).toBe(MIN_LOOP_INTERVAL_SECONDS);
  });

  it('returns null when the prompt is missing', () => {
    expect(parseLoopArgs('5m')).toBeNull();
    expect(parseLoopArgs('5m   ')).toBeNull();
  });

  it('returns null when no interval is given', () => {
    expect(parseLoopArgs('check the build')).toBeNull();
  });

  it('returns null for a zero interval', () => {
    expect(parseLoopArgs('0m check')).toBeNull();
  });

  it('preserves multi-line prompts', () => {
    expect(parseLoopArgs('5m line one\nline two')?.prompt).toBe('line one\nline two');
  });
});

describe('formatLoopInterval', () => {
  it('formats sub-minute intervals as seconds', () => {
    expect(formatLoopInterval(45)).toBe('45s');
  });

  it('formats whole minutes', () => {
    expect(formatLoopInterval(300)).toBe('5m');
  });

  it('formats minutes with leftover seconds', () => {
    expect(formatLoopInterval(90)).toBe('1m 30s');
  });

  it('formats whole hours', () => {
    expect(formatLoopInterval(7200)).toBe('2h');
  });

  it('formats hours with leftover minutes', () => {
    expect(formatLoopInterval(5400)).toBe('1h 30m');
  });
});
