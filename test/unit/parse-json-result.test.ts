import { describe, it, expect } from 'vitest';
import { parseJsonResult } from '../../src/InProcessSummarizer';

describe('parseJsonResult', () => {
  it('parses valid JSON into title and summary', () => {
    const result = parseJsonResult('{"title":"Fix auth","summary":"Fixes JWT validation"}');
    expect(result).toEqual({ title: 'Fix auth', summary: 'Fixes JWT validation' });
  });

  it('strips ```json fences before parsing', () => {
    const input = '```json\n{"title":"Fix auth","summary":"Fixes JWT validation"}\n```';
    const result = parseJsonResult(input);
    expect(result).toEqual({ title: 'Fix auth', summary: 'Fixes JWT validation' });
  });

  it('strips plain ``` fences before parsing', () => {
    const input = '```\n{"title":"Fix auth","summary":"Fixes JWT validation"}\n```';
    const result = parseJsonResult(input);
    expect(result).toEqual({ title: 'Fix auth', summary: 'Fixes JWT validation' });
  });

  it('falls back to { title: "", summary: rawText } for completely invalid JSON', () => {
    const result = parseJsonResult('not json at all');
    expect(result).toEqual({ title: '', summary: 'not json at all' });
  });

  it('defaults title to "" when the key is missing from the JSON', () => {
    const result = parseJsonResult('{"summary":"Fixes JWT validation"}');
    expect(result).toEqual({ title: '', summary: 'Fixes JWT validation' });
  });

  it('defaults summary to "" when the key is missing from the JSON', () => {
    const result = parseJsonResult('{"title":"Fix auth"}');
    expect(result).toEqual({ title: 'Fix auth', summary: '' });
  });
});
