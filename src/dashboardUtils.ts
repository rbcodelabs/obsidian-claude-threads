/**
 * Shared utility functions for the Agent Dashboard and Kanban Board views.
 */

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
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
