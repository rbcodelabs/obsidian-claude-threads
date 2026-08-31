import { exec as nodeExec } from 'child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  GATE_INDETERMINATE_EXIT_CODE,
  createGateRunner,
  makeGateEnvironment,
  sanitizeGateDiagnostic,
  type GateExec,
} from '../../src/gateRunner';

describe('makeGateEnvironment', () => {
  it('overlays keychain secrets on the base environment and keeps redaction values separate', () => {
    const bundle = makeGateEnvironment(
      { PATH: '/usr/bin', COMPASS_MCP_API_KEY: 'stale-process-value' },
      { COMPASS_MCP_API_KEY: 'keychain-value', SECOND_TOKEN: 'second-value' },
    );

    expect(bundle.env).toMatchObject({
      PATH: '/usr/bin',
      COMPASS_MCP_API_KEY: 'keychain-value',
      SECOND_TOKEN: 'second-value',
    });
    expect(bundle.sensitiveValues).toEqual([
      'COMPASS_MCP_API_KEY', 'keychain-value', 'SECOND_TOKEN', 'second-value',
    ]);
  });

  it('includes configured secret names in diagnostic redactions', () => {
    const bundle = makeGateEnvironment({}, { COMPASS_MCP_API_KEY: 'keychain-value' });
    expect(bundle.sensitiveValues).toContain('COMPASS_MCP_API_KEY');
  });
});

describe('sanitizeGateDiagnostic', () => {
  it('redacts overlapping secrets longest-first and ignores empty values', () => {
    expect(sanitizeGateDiagnostic('token-long token \u001b[31mfailed\u001b[0m', ['', 'token', 'token-long']))
      .toBe('[REDACTED] [REDACTED] failed');
  });

  it('removes unsafe controls while retaining tabs and newlines', () => {
    expect(sanitizeGateDiagnostic('one\u0000two\tthree\nfour\u007f', []))
      .toBe('onetwo\tthree\nfour');
  });

  it('caps diagnostics at 4 KiB on a valid UTF-8 boundary', () => {
    const result = sanitizeGateDiagnostic('🙂'.repeat(2_000), []);
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThan(4_200);
    expect(result).toContain('[gate diagnostic truncated]');
    expect(result).not.toContain('�');
  });
});

describe('createGateRunner', () => {
  it.each([
    { error: null, expected: { exitCode: 0, timedOut: false } },
    { error: Object.assign(new Error('Command failed'), { code: 1 }), expected: { exitCode: 1, timedOut: false } },
    { error: Object.assign(new Error('timed out'), { killed: true }), expected: { exitCode: null, timedOut: true } },
    { error: Object.assign(new Error('spawn failed'), { code: 'ENOENT' }), expected: { exitCode: null, timedOut: false } },
  ])('maps child-process completion %#', async ({ error, expected }) => {
    const fakeExec: GateExec = vi.fn((_command, _options, callback) => {
      callback(error, 'stdout', 'stderr');
      return undefined;
    });
    const runGate = createGateRunner(fakeExec);

    const result = await runGate('check.sh', {
      cwd: '/tmp',
      timeoutMs: 1_000,
      env: {},
      sensitiveValues: [],
    });

    expect(result).toMatchObject(expected);
    expect(result.stdout).toBe('stdout');
    expect(result.stderr).toBe('stderr');
    if (typeof (error as { code?: unknown } | null)?.code !== 'number' && error && !(error as { killed?: boolean }).killed) {
      expect(result.spawnError).toBe('spawn failed');
    }
  });

  it('sanitizes stderr and spawn errors before returning them', async () => {
    const secret = 'super-secret-token';
    const fakeExec: GateExec = vi.fn((_command, _options, callback) => {
      callback(Object.assign(new Error(`cannot launch ${secret}`), { code: 'ENOENT' }), '', `Bearer ${secret}`);
      return undefined;
    });
    const result = await createGateRunner(fakeExec)('check.sh', {
      cwd: '/tmp', timeoutMs: 1_000, env: {}, sensitiveValues: [secret],
    });

    expect(result.stderr).toBe('Bearer [REDACTED]');
    expect(result.spawnError).toBe('cannot launch [REDACTED]');
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

function shellGate(command: string, env: Record<string, string>): Promise<number | null> {
  return createGateRunner(nodeExec)(command, {
    cwd: '/tmp', timeoutMs: 2_000, env: { ...process.env, ...env }, sensitiveValues: [],
  }).then((result) => result.exitCode);
}

describe('Compass count gate shell contracts', () => {
  const feedbackCommand = 'case "$FEEDBACK_COUNT" in (""|*[!0-9]*) exit 75;; esac; [ "$FEEDBACK_COUNT" -gt 0 ]';
  const experimentCommand = 'case "$EXPERIMENT_COUNT" in (""|*[!0-9]*) exit 75;; esac; [ $((EXPERIMENT_COUNT + 0)) -gt 0 ]';

  it.each([
    ['feedback positive', feedbackCommand, { FEEDBACK_COUNT: '3' }, 0],
    ['feedback empty queue', feedbackCommand, { FEEDBACK_COUNT: '0' }, 1],
    ['feedback invalid response', feedbackCommand, { FEEDBACK_COUNT: '' }, GATE_INDETERMINATE_EXIT_CODE],
    ['experiment positive', experimentCommand, { EXPERIMENT_COUNT: '1' }, 0],
    ['experiment empty queue', experimentCommand, { EXPERIMENT_COUNT: '0' }, 1],
    ['experiment invalid response', experimentCommand, { EXPERIMENT_COUNT: 'nope' }, GATE_INDETERMINATE_EXIT_CODE],
  ])('%s returns the intended gate status', async (_name, command, env, expected) => {
    await expect(shellGate(command, env)).resolves.toBe(expected);
  });

  it('preserves an explicit 401 authentication failure as indeterminate', async () => {
    const result = await createGateRunner(nodeExec)(
      "printf 'HTTP 401 Unauthorized\\n' >&2; exit 75",
      { cwd: '/tmp', timeoutMs: 2_000, env: process.env, sensitiveValues: [] },
    );

    expect(result.exitCode).toBe(GATE_INDETERMINATE_EXIT_CODE);
    expect(result.stderr).toBe('HTTP 401 Unauthorized');
  });
});
