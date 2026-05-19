import { describe, it, expect } from 'vitest';
import { isDefaultThreadTitle } from '../../src/thread-title-utils';

describe('isDefaultThreadTitle', () => {
  it('returns true for "Thread 1"', () => {
    expect(isDefaultThreadTitle('Thread 1')).toBe(true);
  });

  it('returns true for "Thread 42"', () => {
    expect(isDefaultThreadTitle('Thread 42')).toBe(true);
  });

  it('returns true for "Thread 0"', () => {
    expect(isDefaultThreadTitle('Thread 0')).toBe(true);
  });

  it('returns false for a custom title', () => {
    expect(isDefaultThreadTitle('My custom title')).toBe(false);
  });

  it('returns false for a descriptive title', () => {
    expect(isDefaultThreadTitle('Fix the JWT bug in auth.ts')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isDefaultThreadTitle('')).toBe(false);
  });

  it('returns false for "Thread" with no number', () => {
    expect(isDefaultThreadTitle('Thread')).toBe(false);
  });

  it('returns false for lowercase "thread 1"', () => {
    expect(isDefaultThreadTitle('thread 1')).toBe(false);
  });

  it('returns false for "Thread 1 extra" with trailing content', () => {
    expect(isDefaultThreadTitle('Thread 1 extra')).toBe(false);
  });
});
