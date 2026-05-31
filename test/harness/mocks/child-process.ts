type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

export const exec = (
  _cmd: string,
  optionsOrCb?: Record<string, unknown> | ExecCallback,
  maybeCb?: ExecCallback,
) => {
  const cb: ExecCallback | undefined = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
  if (cb) cb(null, '', '');
  return { kill: () => {}, stdin: { write: () => {}, end: () => {} } };
};
