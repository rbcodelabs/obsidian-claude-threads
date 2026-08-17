export type ClaudeThreadsHostName = 'Geode' | 'Obsidian';

/** Geode exposes a compatibility marker on its host window. */
export function detectHostName(hostWindow: { geode?: unknown }): ClaudeThreadsHostName {
  return hostWindow.geode ? 'Geode' : 'Obsidian';
}
