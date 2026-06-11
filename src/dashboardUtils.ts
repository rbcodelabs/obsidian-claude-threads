/**
 * Shared utility functions for the Agent Dashboard and Kanban Board views.
 */

import { resolveProjectName } from './pathUtils';

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/**
 * Formats the remaining time until a scheduled wake-up fires as a short,
 * human phrase: "now", "in 45s", "in 4m", "in 1h 5m". Used by both the Agent
 * Dashboard waiting rows and the chat-view wake-up banner.
 */
export function formatWakeupCountdown(fireAt: number): string {
  const remaining = fireAt - Date.now();
  if (remaining <= 0) return 'now';
  const totalSeconds = Math.round(remaining / 1000);
  if (totalSeconds < 60) return `in ${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `in ${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `in ${hours}h ${minutes}m` : `in ${hours}h`;
}

export function shortenPath(p: string, vaultRoot?: string): string {
  if (vaultRoot && p.startsWith(vaultRoot)) {
    const rel = p.slice(vaultRoot.length).replace(/^\//, '');
    return rel || '/';
  }
  const home = process.env.HOME ?? '';
  if (home && p.startsWith(home)) p = '~' + p.slice(home.length);
  const parts = p.split('/');
  return parts.length > 4 ? '…/' + parts.slice(-2).join('/') : p;
}

/**
 * Builds a human-readable label for a working-directory path, shared across the
 * conversation view, Agent Dashboard, and Kanban board.
 *
 * When the path is inside a git repo the label is "project · branch" (or just
 * "project" when the branch name matches the repo name). Otherwise it falls back
 * to the shortened filesystem path from `shortenPath`.
 */
export function buildCwdLabel(cwd: string, vaultRoot?: string): string {
  if (!cwd) return '';
  const projectName = resolveProjectName(cwd);
  if (projectName) {
    const lastSegment = cwd.replace(/\/$/, '').split('/').pop() ?? '';
    return (lastSegment && lastSegment !== projectName)
      ? `${projectName} · ${lastSegment}`
      : projectName;
  }
  return shortenPath(cwd, vaultRoot);
}

/**
 * Returns true when the error message looks like an AWS SSO token expiry that
 * requires running `aws sso login` to refresh credentials.
 */
export function isAwsSsoError(err?: string): boolean {
  if (!err) return false;
  return /token.*expir|expir.*token|aws sso login|sso.*session.*expir|Error loading SSO/i.test(err);
}

/**
 * Extracts the AWS_PROFILE value from a KEY=VALUE extra-env block, if present.
 */
export function extractAwsProfile(extraEnv: string): string | null {
  const match = extraEnv.match(/(?:^|\n)AWS_PROFILE=([^\s]+)/);
  return match ? match[1] : null;
}

/**
 * Resolves the absolute path to the `aws` CLI binary.
 *
 * Obsidian launches with a minimal PATH (no `/opt/homebrew/bin`), so spawning
 * `aws` via `child_process.exec` fails with "command not found" on Macs where
 * the AWS CLI was installed via Homebrew. Walk the common install locations
 * and fall back to the bare name so users with `aws` on PATH still work.
 *
 * Accepts an optional `fileExists` predicate for testing — defaults to the
 * real `fs.existsSync`.
 */
export function resolveAwsBinary(fileExists?: (p: string) => boolean): string {
  const exists = fileExists ?? defaultFileExists;
  const home = process.env.HOME ?? '';
  const candidates = [
    '/opt/homebrew/bin/aws',
    '/usr/local/bin/aws',
    home ? `${home}/.local/bin/aws` : '',
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (exists(p)) return p;
    } catch {
      // ignore — fall through to the next candidate
    }
  }
  return 'aws';
}

function defaultFileExists(p: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs');
  return fs.existsSync(p);
}

/**
 * Returns an env object suitable for `child_process.exec` that prepends the
 * common Homebrew / user-local bin directories to PATH. Needed so that any
 * subprocesses the AWS CLI itself spawns (e.g. `aws sso login` opening a
 * browser helper) can also find their dependencies.
 */
export function awsExecEnv(): NodeJS.ProcessEnv {
  const extraPath = ['/opt/homebrew/bin', '/usr/local/bin'];
  const home = process.env.HOME;
  if (home) extraPath.push(`${home}/.local/bin`);
  const currentPath = process.env.PATH ?? '';
  return {
    ...process.env,
    PATH: `${extraPath.join(':')}:${currentPath}`,
  };
}
