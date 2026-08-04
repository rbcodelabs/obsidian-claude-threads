import { describe, expect, it } from 'vitest';
import { resolveCodexPermissions, resolveDynamicToolApproval } from '../../src/HarnessSession';

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

describe('resolveDynamicToolApproval', () => {
  it('allows read-only host tools without a prompt', () => {
    expect(resolveDynamicToolApproval('default', false)).toBe('allow');
  });

  it.each(['default', 'acceptEdits'] as const)('prompts for a mutation in %s mode', (mode) => {
    expect(resolveDynamicToolApproval(mode, true)).toBe('prompt');
  });

  it.each(['plan', 'dontAsk'] as const)('denies a mutation in %s mode', (mode) => {
    expect(resolveDynamicToolApproval(mode, true)).toBe('deny');
  });
});
