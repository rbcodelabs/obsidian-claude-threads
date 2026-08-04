import { CodexSession } from './CodexSession';
import { ThreadSession } from './ThreadSession';
import type { HarnessSession } from './HarnessSession';
import type { PluginSettings, Thread } from './types';

/** Central harness selection point. ThreadManager never constructs adapters directly. */
export function createHarnessSession(thread: Thread, settings: PluginSettings): HarnessSession {
  return thread.agentHarness === 'codex'
    ? new CodexSession(settings.codexBinaryPath)
    : new ThreadSession(settings.claudeBinaryPath);
}
