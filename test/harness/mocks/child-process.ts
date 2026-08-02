/** Stub for Node's child_process module in the Playwright browser harness. */

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

interface StubChildProcess {
  stdin: { write: (_data: string) => void; end: () => void };
}

export const exec = (
  _cmd: string,
  _optsOrCb?: Record<string, unknown> | ExecCallback,
  _cb?: ExecCallback,
): StubChildProcess => {
  // Normalise overloaded signatures: exec(cmd, cb) or exec(cmd, opts, cb)
  const callback = typeof _optsOrCb === 'function' ? _optsOrCb : _cb;
  // Invoke asynchronously so callers can chain .stdin before the callback fires
  if (callback) setTimeout(() => callback(null, '', ''), 0);
  return { stdin: { write: () => {}, end: () => {} } };
};

/**
 * Stub for the synchronous git-shelling calls in skillManager.ts (staleness
 * checks, pull-updates, marketplace installs). None of the screenshot tests
 * click buttons that reach these code paths, so an empty buffer is enough to
 * satisfy the static `import { execSync } from 'child_process'` binding
 * without crashing the harness bundle.
 */
export const execSync = (_cmd: string, _opts?: unknown): Buffer => Buffer.from('');

export const execFileSync = (_cmd: string, _args?: string[], _opts?: unknown): Buffer => Buffer.from('');
