/** Exit status reserved for a gate that could not determine whether work exists. */
export const GATE_INDETERMINATE_EXIT_CODE = 75;

const GATE_DIAGNOSTIC_MAX_BYTES = 4 * 1024;
const GATE_DIAGNOSTIC_TRUNCATED = '\n… [gate diagnostic truncated]';

export interface GateEnvironment {
  env: NodeJS.ProcessEnv;
  /** Keychain-backed names and values used only to redact diagnostics before persistence. */
  sensitiveValues: string[];
}

export interface GateRunOptions extends GateEnvironment {
  cwd: string;
  timeoutMs: number;
}

export interface GateResult {
  exitCode: number | null;
  stdout: string;
  /** Already bounded and sanitized; safe to persist as diagnostic context. */
  stderr: string;
  timedOut: boolean;
  /** Already bounded and sanitized; safe to persist as diagnostic context. */
  spawnError?: string;
}

type GateExecError = Error & { killed?: boolean; code?: number | string };

export type GateExec = (
  command: string,
  options: {
    cwd: string;
    timeout: number;
    env: NodeJS.ProcessEnv;
    maxBuffer: number;
    encoding: BufferEncoding;
  },
  callback: (error: GateExecError | null, stdout: string, stderr: string) => void,
) => unknown;

/** Merge process/tool env with keychain values without placing secrets in durable state. */
export function makeGateEnvironment(baseEnv: NodeJS.ProcessEnv, secretEnv: Record<string, string>): GateEnvironment {
  return {
    env: { ...baseEnv, ...secretEnv },
    sensitiveValues: Object.entries(secretEnv).flatMap(([name, value]) => value ? [name, value] : [name]),
  };
}

/** Redact keychain values and normalize arbitrary process output before persistence. */
export function sanitizeGateDiagnostic(input: string, sensitiveValues: string[]): string {
  let sanitized = input
    // CSI/OSC and simpler ANSI escapes emitted by common CLIs.
    .replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  const secrets = [...new Set(sensitiveValues.filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const secret of secrets) sanitized = sanitized.split(secret).join('[REDACTED]');
  sanitized = sanitized.trim();

  const bytes = Buffer.from(sanitized, 'utf8');
  if (bytes.length <= GATE_DIAGNOSTIC_MAX_BYTES) return sanitized;

  const markerBytes = Buffer.byteLength(GATE_DIAGNOSTIC_TRUNCATED, 'utf8');
  let end = GATE_DIAGNOSTIC_MAX_BYTES - markerBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString('utf8')}${GATE_DIAGNOSTIC_TRUNCATED}`;
}

/** Create the desktop gate runner with child_process.exec injected for unit tests. */
export function createGateRunner(exec: GateExec) {
  return (command: string, options: GateRunOptions): Promise<GateResult> =>
    new Promise((resolve) => {
      exec(
        command,
        {
          cwd: options.cwd,
          timeout: options.timeoutMs,
          env: options.env,
          maxBuffer: 1024 * 1024,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          const diagnostic = sanitizeGateDiagnostic(stderr ?? '', options.sensitiveValues);
          const spawnError = error && typeof error.code !== 'number' && !error.killed
            ? sanitizeGateDiagnostic(error.message, options.sensitiveValues)
            : undefined;

          if (error?.killed) {
            resolve({ exitCode: null, stdout: stdout ?? '', stderr: diagnostic, timedOut: true });
          } else if (spawnError !== undefined) {
            resolve({ exitCode: null, stdout: stdout ?? '', stderr: diagnostic, timedOut: false, spawnError });
          } else {
            resolve({
              exitCode: typeof error?.code === 'number' ? error.code : 0,
              stdout: stdout ?? '',
              stderr: diagnostic,
              timedOut: false,
            });
          }
        },
      );
    });
}
