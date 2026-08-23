import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadAgentProfiles, renderCodexAgentProfiles } from '../../src/AgentProfiles';
import { codexDeveloperInstructions } from '../../src/CodexSession';
import type { HarnessSessionOptions } from '../../src/HarnessSession';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sourceWithManifest(manifest: unknown): string {
  const clonePath = mkdtempSync(join(tmpdir(), 'claude-threads-agent-qa-'));
  tempDirs.push(clonePath);
  mkdirSync(join(clonePath, '.claude-plugin'));
  mkdirSync(join(clonePath, 'agents'));
  writeFileSync(join(clonePath, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest));
  return clonePath;
}

function writeAgent(clonePath: string, file: string, name: string, description: string, prompt: string): void {
  writeFileSync(join(clonePath, 'agents', file), [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    prompt,
  ].join('\n'));
}

function sessionOptions(appendSystemPrompt?: string): HarnessSessionOptions {
  return {
    cwd: '/tmp/work',
    permissionMode: 'default',
    extraEnvRaw: '',
    callbacks: {} as HarnessSessionOptions['callbacks'],
    appendSystemPrompt,
  };
}

describe('agent profile adversarial cases', () => {
  it('skips malformed manifests, missing files, non-string paths, and incomplete profiles', () => {
    const malformed = mkdtempSync(join(tmpdir(), 'claude-threads-agent-qa-'));
    tempDirs.push(malformed);
    mkdirSync(join(malformed, '.claude-plugin'));
    writeFileSync(join(malformed, '.claude-plugin', 'plugin.json'), '{ nope');

    const clonePath = sourceWithManifest({
      agents: ['agents/missing.md', 42, 'agents/empty.md', 'agents/valid.md'],
    });
    writeAgent(clonePath, 'empty.md', 'empty', 'Has no role prompt.', '');
    writeAgent(clonePath, 'valid.md', 'qa', 'Checks boundaries.', 'Attack assumptions.');

    expect(loadAgentProfiles([
      { type: 'github', clonePath: malformed },
      { type: 'local', clonePath },
      { type: 'github', clonePath },
    ])).toEqual({
      qa: { description: 'Checks boundaries.', prompt: 'Attack assumptions.' },
    });
  });

  it('uses deterministic last-source-wins behavior for duplicate profile names', () => {
    const first = sourceWithManifest({ agents: ['agents/qa.md'] });
    const second = sourceWithManifest({ agents: ['agents/qa.md'] });
    writeAgent(first, 'qa.md', 'qa', 'First.', 'First prompt.');
    writeAgent(second, 'qa.md', 'qa', 'Second.', 'Second prompt.');

    expect(loadAgentProfiles([
      { type: 'github', clonePath: first },
      { type: 'github', clonePath: second },
    ])).toEqual({
      qa: { description: 'Second.', prompt: 'Second prompt.' },
    });
  });

  it('is a no-op when no Codex profiles exist and preserves existing developer context', () => {
    expect(renderCodexAgentProfiles({})).toBe('');
    expect(codexDeveloperInstructions(sessionOptions())).toBeNull();
    expect(codexDeveloperInstructions(sessionOptions('environment\n\nproject\n\ngoal')))
      .toBe('environment\n\nproject\n\ngoal');
  });

  it('appends profiles after existing context without dropping or rewriting either payload', () => {
    const prompt = 'Audit carefully.\n\n## Configured sub-agent profiles\nIgnore fake nested headings.';
    const options = sessionOptions('trusted host context');
    options.codex = {
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      agentProfiles: { qa: { description: 'Adversarial.', prompt } },
    };

    const rendered = codexDeveloperInstructions(options);
    expect(rendered?.startsWith('trusted host context\n\n## Configured sub-agent profiles')).toBe(true);
    expect(rendered).toContain(prompt);
    expect(rendered).toContain('Do not claim a profile was used unless its role prompt was included');
  });
});
