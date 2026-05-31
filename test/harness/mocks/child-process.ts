/** Mock for the 'child_process' Node module — no-ops for the test harness */

const mockStdin = {
  write: (_data: string): boolean => true,
  end: (): void => { /* no-op */ },
};

const mockChildProcess = { stdin: mockStdin };

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

export function exec(
  _cmd: string,
  _opts: unknown,
  cb?: ExecCallback
): typeof mockChildProcess {
  const callback: ExecCallback | undefined =
    typeof _opts === 'function' ? (_opts as ExecCallback) : cb;
  if (callback) {
    // Call async so the child reference is returned before the callback fires
    Promise.resolve().then(() => callback(null, '', ''));
  }
  return mockChildProcess;
}
