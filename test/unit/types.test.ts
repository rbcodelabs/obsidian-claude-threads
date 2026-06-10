import { describe, it, expect } from 'vitest';
import { parseExtraEnv, effectiveExtraEnv } from '../../src/types';

describe('parseExtraEnv', () => {
  it('returns empty object for empty string', () => {
    expect(parseExtraEnv('')).toEqual({});
  });

  it('parses simple KEY=value pairs', () => {
    expect(parseExtraEnv('FOO=bar\nBAZ=qux')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('skips comment lines', () => {
    expect(parseExtraEnv('# a comment\nFOO=bar')).toEqual({ FOO: 'bar' });
  });

  it('skips blank lines', () => {
    expect(parseExtraEnv('\n\nFOO=bar\n\n')).toEqual({ FOO: 'bar' });
  });

  it('preserves value when it contains = signs', () => {
    expect(parseExtraEnv('TOKEN=abc=def=ghi')).toEqual({ TOKEN: 'abc=def=ghi' });
  });

  it('trims key whitespace', () => {
    expect(parseExtraEnv('  KEY  =value')).toEqual({ KEY: 'value' });
  });

  it('skips lines without =', () => {
    expect(parseExtraEnv('NOEQUALS\nFOO=bar')).toEqual({ FOO: 'bar' });
  });

  it('handles empty value', () => {
    expect(parseExtraEnv('FOO=')).toEqual({ FOO: '' });
  });
});

describe('effectiveExtraEnv', () => {
  it('returns extraEnv unchanged for the claude provider', () => {
    expect(effectiveExtraEnv({ provider: 'claude', extraEnv: 'FOO=bar' })).toBe('FOO=bar');
  });

  it('prepends CLAUDE_CODE_USE_BEDROCK=1 for the bedrock provider', () => {
    const raw = effectiveExtraEnv({ provider: 'bedrock', extraEnv: 'AWS_PROFILE=dev' });
    expect(parseExtraEnv(raw)).toEqual({ CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'dev' });
  });

  it('lets a user-supplied CLAUDE_CODE_USE_BEDROCK line override the provider default', () => {
    const raw = effectiveExtraEnv({ provider: 'bedrock', extraEnv: 'CLAUDE_CODE_USE_BEDROCK=0' });
    expect(parseExtraEnv(raw)).toEqual({ CLAUDE_CODE_USE_BEDROCK: '0' });
  });

  it('handles empty extraEnv on bedrock', () => {
    expect(parseExtraEnv(effectiveExtraEnv({ provider: 'bedrock', extraEnv: '' })))
      .toEqual({ CLAUDE_CODE_USE_BEDROCK: '1' });
  });
});
