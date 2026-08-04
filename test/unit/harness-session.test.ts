import { describe, expect, it } from 'vitest';
import { resolveCodexPermissions } from '../../src/HarnessSession';

describe('resolveCodexPermissions', () => {
  it('keeps the default policy conservative', () => {
    expect(resolveCodexPermissions('default')).toEqual({ approvalPolicy: 'untrusted', sandbox: 'workspace-write' });
  });

  it('enforces a read-only sandbox for plan mode', () => {
    expect(resolveCodexPermissions('plan')).toEqual({ approvalPolicy: 'on-request', sandbox: 'read-only' });
  });

  it.each(['bypassPermissions', 'dontAsk'] as const)('maps %s to non-interactive workspace writes', (mode) => {
    expect(resolveCodexPermissions(mode)).toEqual({ approvalPolicy: 'never', sandbox: 'workspace-write' });
  });
});
