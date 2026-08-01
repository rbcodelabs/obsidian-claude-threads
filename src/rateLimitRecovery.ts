/**
 * Recovery helpers for API rate-limit / overload errors from the Claude Code
 * CLI binary (e.g. "Server is temporarily limiting requests (not your usage
 * limit) · Rate limited"). The SDK's async message-loop iterator throws
 * before yielding anything for this failure shape, and without special
 * handling it surfaces as a hard, terminal error card.
 *
 * Unlike a transport-closed error (which happens mid-turn, after a tool call
 * has already gone out), a rate-limit error happens before the turn is
 * processed at all — the model never saw the user's prompt. So instead of
 * sending a synthetic follow-up message, the retry must silently replay the
 * exact same turn with a backoff delay in between attempts.
 */

export const MAX_RATE_LIMIT_AUTO_RETRIES = 5;

const RATE_LIMIT_BACKOFF_MS = [3000, 8000, 20000, 45000, 90000];

export function isRateLimitError(message: string): boolean {
  return /rate limit|temporarily limiting requests|overloaded_error|\b429\b|\b529\b/i.test(message);
}

export function shouldAutoRetryRateLimitError(message: string, currentRetryCount: number): boolean {
  return isRateLimitError(message) && currentRetryCount < MAX_RATE_LIMIT_AUTO_RETRIES;
}

export function rateLimitBackoffMs(retryCount: number): number {
  return RATE_LIMIT_BACKOFF_MS[Math.min(retryCount, RATE_LIMIT_BACKOFF_MS.length - 1)];
}
