/**
 * Lightweight debug logger for Claude Threads.
 *
 * High-frequency operational logs (stream events, per-message, per-connection) are
 * gated behind debug mode so they don't accumulate in long-running sessions.
 * Warnings and errors always surface regardless of the setting.
 *
 * Call setDebugLogging(true) from the plugin's onload / settings change handler
 * to enable verbose output.
 */

let _debugEnabled = false;

export function setDebugLogging(enabled: boolean): void {
  _debugEnabled = enabled;
}

/** Emit only when debug mode is on. Use for high-frequency or verbose operational logs. */
export function debugLog(...args: unknown[]): void {
  if (_debugEnabled) console.log(...args);
}
