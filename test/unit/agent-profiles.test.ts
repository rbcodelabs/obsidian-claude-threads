import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { tmpdir } from 'os';
import { loadAgentProfiles, renderCodexAgentProfiles } from '../../src/AgentProfiles';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('agent profile parity', () => {
  it('loads manifest-listed profiles once into a harness-neutral map', () => {
    const clonePath = mkdtempSync(join(tmpdir(), 'claude-threads-agents-'));
    tempDirs.push(clonePath);
    mkdirSync(join(clonePath, '.claude-plugin'));
    mkdirSync(join(clonePath, 'agents'));
    writeFileSync(join(clonePath, '.claude-plugin', 'plugin.json'), JSON.stringify({
      agents: ['agents/qa.md'],
    }));
    writeFileSync(join(clonePath, 'agents', 'qa.md'), [
      '---',
      'name: qa',
      'description: >-',
      '  Adversarially verify',
      '  product behavior.',
      '---',
      'Find edge cases before release.',
    ].join('\n'));

    expect(loadAgentProfiles([{ type: 'github', clonePath } as any])).toEqual({
      qa: {
        description: 'Adversarially verify product behavior.',
        prompt: 'Find edge cases before release.',
      },
    });
  });

  it('ignores non-string, absolute, and traversal agent paths', () => {
    const clonePath = mkdtempSync(join(tmpdir(), 'claude-threads-agents-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'claude-threads-outside-agent-'));
    tempDirs.push(clonePath);
    tempDirs.push(outsideDir);
    mkdirSync(join(clonePath, '.claude-plugin'));
    mkdirSync(join(clonePath, 'agents'));
    const outsidePath = join(outsideDir, 'outside-agent.md');
    writeFileSync(outsidePath, [
      '---', 'name: escaped', 'description: Must not load.', '---', 'Unsafe prompt.',
    ].join('\n'));
    writeFileSync(join(clonePath, 'agents', 'safe.md'), [
      '---', 'name: safe', 'description: Safe profile.', '---', 'Safe prompt.',
    ].join('\n'));
    writeFileSync(join(clonePath, '.claude-plugin', 'plugin.json'), JSON.stringify({
      agents: ['agents/safe.md', 42, null, outsidePath, relative(clonePath, outsidePath)],
    }));

    expect(loadAgentProfiles([{ type: 'github', clonePath }])).toEqual({
      safe: { description: 'Safe profile.', prompt: 'Safe prompt.' },
    });
  });

  it('renders precise Codex delegation instructions containing the selected role prompt', () => {
    const instructions = renderCodexAgentProfiles({
      qa: { description: 'Adversarial verification.', prompt: 'Find edge cases.' },
      engineer: { description: 'Implement approved work.', prompt: 'Use strict TDD.' },
    });

    expect(instructions).toContain('When delegating a task that matches a profile');
    expect(instructions).toContain('spawn_agent');
    expect(instructions).toContain('Profile: qa');
    expect(instructions).toContain('Find edge cases.');
    expect(instructions).toContain('Profile: engineer');
    expect(instructions).toContain('Use strict TDD.');
  });
});
