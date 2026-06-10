/**
 * Helpers for the /loop slash command — parsing "<interval> <prompt>" arguments
 * and formatting intervals for display.
 */

export interface ParsedLoopArgs {
  intervalSeconds: number;
  prompt: string;
}

/** Minimum loop interval. Guards against accidental tight loops like "/loop 1s …". */
export const MIN_LOOP_INTERVAL_SECONDS = 30;

/**
 * Parses the argument string of /loop: an interval token (e.g. "30s", "5m",
 * "1h", or a bare number meaning minutes) followed by the prompt text.
 * Returns null when the input doesn't match the expected shape.
 */
export function parseLoopArgs(arg: string): ParsedLoopArgs | null {
  const match = arg.match(/^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs)?\s+([\s\S]+)$/i);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  if (!Number.isFinite(value) || value <= 0) return null;

  const unit = (match[2] ?? 'm').toLowerCase();
  let seconds: number;
  if (unit.startsWith('s')) seconds = value;
  else if (unit.startsWith('h')) seconds = value * 3600;
  else seconds = value * 60;

  const prompt = match[3].trim();
  if (!prompt) return null;

  return {
    intervalSeconds: Math.max(seconds, MIN_LOOP_INTERVAL_SECONDS),
    prompt,
  };
}

/** Formats a number of seconds as a compact human interval ("45s", "5m", "1h 30m"). */
export function formatLoopInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}
