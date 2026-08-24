import { readFileSync, realpathSync } from 'fs';
import { isAbsolute, join, relative, resolve, sep } from 'path';

export interface AgentProfile { description: string; prompt: string }
export type AgentProfileMap = Record<string, AgentProfile>;

interface GitHubAgentSource { type: string; clonePath?: string }

function parseAgentMarkdown(content: string): { name?: string; description?: string; prompt?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return {};
  const frontmatter = match[1];
  const prompt = match[2].trim();
  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const blockDescription = frontmatter.match(/^description:\s*>[-]?\r?\n((?:[ \t]+[^\r\n]*\r?\n?)+)/m);
  const description = blockDescription
    ? blockDescription[1].split(/\r?\n/).map(line => line.trim()).filter(Boolean).join(' ')
    : frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  return { name, description, prompt };
}

export function loadAgentProfiles(sources: GitHubAgentSource[]): AgentProfileMap {
  const profiles: AgentProfileMap = {};
  for (const source of sources) {
    if (source.type !== 'github' || !source.clonePath) continue;
    try {
      const manifest = JSON.parse(readFileSync(join(source.clonePath, '.claude-plugin', 'plugin.json'), 'utf-8')) as Record<string, unknown>;
      const agentPaths = Array.isArray(manifest.agents) ? manifest.agents : [];
      const cloneRoot = realpathSync(source.clonePath);
      for (const relativePath of agentPaths) {
        if (typeof relativePath !== 'string' || isAbsolute(relativePath)) continue;
        try {
          const candidate = resolve(cloneRoot, relativePath);
          const lexicalRelative = relative(cloneRoot, candidate);
          if (lexicalRelative === '..' || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) continue;
          const resolvedAgentPath = realpathSync(candidate);
          const realRelative = relative(cloneRoot, resolvedAgentPath);
          if (realRelative === '..' || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) continue;
          const parsed = parseAgentMarkdown(readFileSync(resolvedAgentPath, 'utf-8'));
          if (parsed.name && parsed.description && parsed.prompt) profiles[parsed.name] = { description: parsed.description, prompt: parsed.prompt };
        } catch { /* unreadable definition */ }
      }
    } catch { /* missing or invalid manifest */ }
  }
  return profiles;
}

export function renderCodexAgentProfiles(profiles: AgentProfileMap): string {
  const entries = Object.entries(profiles);
  if (entries.length === 0) return '';
  const rendered = entries.map(([name, profile]) => [
    `### Profile: ${name}`,
    `Description: ${profile.description}`,
    'Role prompt to include verbatim in the delegated task:',
    profile.prompt,
  ].join('\n')).join('\n\n');
  return [
    '## Configured sub-agent profiles',
    'When delegating a task that matches a profile, call `spawn_agent` with a concrete bounded task and include the selected profile name, description, and full role prompt in the task message. Follow that profile for the delegated work. Do not claim a profile was used unless its role prompt was included in the `spawn_agent` task.',
    rendered,
  ].join('\n\n');
}
