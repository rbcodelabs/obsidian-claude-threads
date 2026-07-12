/**
 * Recovery helpers for the closed-source claude CLI binary stdio reader loop,
 * which force-rejects every pending control request on EOF regardless of how
 * long it should legitimately wait (e.g. a long-running ExitPlanMode
 * human-approval wait). This surfaces as Stream closed / Tool permission
 * stream closed before response received even though the underlying action
 * may have completed successfully server-side.
 *
 * We cannot fix the CLI binary itself, but we can recognize this specific
 * failure shape and give the model a chance to auto-retry instead of forcing
 * the user to notice and manually resend a message.
 */

export const MAX_TRANSPORT_ERROR_AUTO_RETRIES = 1;

export function isTransportClosedError(message: string): boolean {
  return /stream closed/i.test(message);
}

export function shouldAutoRetryTransportError(message: string, currentRetryCount: number): boolean {
  return isTransportClosedError(message) && currentRetryCount < MAX_TRANSPORT_ERROR_AUTO_RETRIES;
}

export const TRANSPORT_ERROR_CONTINUATION_PROMPT =
  '[System: the connection to Claude Code was interrupted while a tool call was in flight. ' +
  'Its result may not have reached you, but it may have completed successfully server-side. ' +
  'Do not assume it failed — verify actual state before proceeding, and avoid repeating an ' +
  'action that may have already succeeded.]';
