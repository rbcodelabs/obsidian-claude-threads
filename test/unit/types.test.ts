import { describe, it, expect } from 'vitest';
import { parseExtraEnv } from '../../src/types';

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
