import { describe, expect, it } from 'vitest';
import * as main from '../../src/main';

describe('Claude Threads public API v1 contract', () => {
  it('exports a factory for the generation-bound peer-plugin API', () => {
    expect(typeof (main as Record<string, unknown>).createClaudeThreadsApiV1).toBe('function');
  });
});
