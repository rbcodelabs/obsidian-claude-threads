/**
 * obsidian-tools-skills.test.ts
 *
 * Unit tests for the 8 skills_* MCP tools defined in ObsidianTools.ts
 * (skills_list_installed, skills_search, skills_get, skills_list_sources,
 * skills_check_updates, skills_install, skills_uninstall, skills_update).
 *
 * These tools are thin adapters over the onSkillsXxx callbacks in
 * ObsidianMcpServerOptions — the real logic lives in skillManager.ts and is
 * covered by skillManager.test.ts. Here we only verify: the tool is wired up
 * correctly, args are passed through faithfully, success responses are
 * JSON-serialized, and errors (missing callback, or callback rejection) come
 * back as `{ error }` with `isError: true` rather than throwing.
 *
 * Strategy mirrors obsidian-tools-cron-durability.test.ts: mock
 * @anthropic-ai/claude-agent-sdk/browser so we can capture each tool's handler
 * function and invoke it directly.
 */

import { describe, it, expect, vi } from 'vitest';
import type { App } from 'obsidian';

vi.mock('@anthropic-ai/claude-agent-sdk/browser', () => ({
  tool: (
    name: string,
    _description: string,
    _schema: unknown,
    handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult>,
  ) => ({ _toolName: name, _handler: handler }),

  createSdkMcpServer: ({ tools }: { tools: CapturedTool[] }) => ({ tools }),
}));

import { createObsidianMcpServer } from '../../src/ObsidianTools';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ToolResult {
  content: [{ type: string; text: string }];
  isError?: boolean;
}

interface CapturedTool {
  _toolName: string;
  _handler: (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult>;
}

interface CapturedServer {
  tools: CapturedTool[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeApp(): App {
  return {
    plugins: { plugins: {} },
    workspace: {
      getLeavesOfType: () => [],
      onLayoutReady: (cb: () => void) => cb(),
    },
    vault: { getAbstractFileByPath: () => null },
    metadataCache: { on: () => {} },
  } as unknown as App;
}

function getTool(server: CapturedServer, name: string): CapturedTool {
  const t = server.tools.find((tool) => tool._toolName === name);
  if (!t) throw new Error(`Tool "${name}" not found in server`);
  return t;
}

function parseResult(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

// ── skills_list_installed ──────────────────────────────────────────────────────

describe('skills_list_installed', () => {
  it('returns an error when onSkillsListInstalled is not provided', async () => {
    const server = createObsidianMcpServer(makeApp(), {}) as unknown as CapturedServer;
    const result = await getTool(server, 'skills_list_installed')._handler({});
    expect(result.isError).toBe(true);
    expect((parseResult(result) as { error: string }).error).toMatch(/not available/);
  });

  it('returns the installed skills list on success', async () => {
    const skills = [{ name: 'foo', description: 'does foo', skillPath: '/x/foo', realPath: '/x/foo', isSymlink: false, isDirectory: true, skillMdPath: '/x/foo/SKILL.md' }];
    const onSkillsListInstalled = vi.fn().mockResolvedValue(skills);
    const server = createObsidianMcpServer(makeApp(), { onSkillsListInstalled }) as unknown as CapturedServer;

    const result = await getTool(server, 'skills_list_installed')._handler({});
    expect(result.isError).toBeUndefined();
    expect(parseResult(result)).toEqual(skills);
    expect(onSkillsListInstalled).toHaveBeenCalledWith();
  });

  it('returns an error (not a throw) when the callback rejects', async () => {
    const onSkillsListInstalled = vi.fn().mockRejectedValue(new Error('disk error'));
    const server = createObsidianMcpServer(makeApp(), { onSkillsListInstalled }) as unknown as CapturedServer;

    const result = await getTool(server, 'skills_list_installed')._handler({});
    expect(result.isError).toBe(true);
    expect((parseResult(result) as { error: string }).error).toMatch(/disk error/);
  });
});

// ── skills_search ───────────────────────────────────────────────────────────────

describe('skills_search', () => {
  it('returns an error when onSkillsSearch is not provided', async () => {
    const server = createObsidianMcpServer(makeApp(), {}) as unknown as CapturedServer;
    const result = await getTool(server, 'skills_search')._handler({ query: 'foo' });
    expect(result.isError).toBe(true);
  });

  it('passes query and limit through to the callback', async () => {
    const results = [{ name: 'Foo', slug: 'o/r/foo', skillId: 'foo', source: 'o/r', installs: 5, isInstalled: false }];
    const onSkillsSearch = vi.fn().mockResolvedValue(results);
    const server = createObsidianMcpServer(makeApp(), { onSkillsSearch }) as unknown as CapturedServer;

    const result = await getTool(server, 'skills_search')._handler({ query: 'foo', limit: 5 });
    expect(onSkillsSearch).toHaveBeenCalledWith('foo', 5);
    expect(parseResult(result)).toEqual(results);
  });

  it('returns an error when the callback rejects', async () => {
    const onSkillsSearch = vi.fn().mockRejectedValue(new Error('network down'));
    const server = createObsidianMcpServer(makeApp(), { onSkillsSearch }) as unknown as CapturedServer;

    const result = await getTool(server, 'skills_search')._handler({ query: 'foo' });
    expect(result.isError).toBe(true);
    expect((parseResult(result) as { error: string }).error).toMatch(/network down/);
  });
});

// ── skills_get ──────────────────────────────────────────────────────────────────

describe('skills_get', () => {
  it('returns an error when onSkillsGet is not provided', async () => {
    const server = createObsidianMcpServer(makeApp(), {}) as unknown as CapturedServer;
    const result = await getTool(server, 'skills_get')._handler({ identifier: 'foo' });
    expect(result.isError).toBe(true);
  });

  it('passes the identifier through and returns detail on success', async () => {
    const detail = { name: 'foo', description: 'x', installed: true, content: '---\nname: foo\n---\n' };
    const onSkillsGet = vi.fn().mockResolvedValue(detail);
    const server = createObsidianMcpServer(makeApp(), { onSkillsGet }) as unknown as CapturedServer;

    const result = await getTool(server, 'skills_get')._handler({ identifier: 'foo' });
    expect(onSkillsGet).toHaveBeenCalledWith('foo');
    expect(parseResult(result)).toEqual(detail);
  });

  it('returns an error when the callback rejects (e.g. skill not found)', async () => {
    const onSkillsGet = vi.fn().mockRejectedValue(new Error('No installed skill named "foo"'));
    const server = createObsidianMcpServer(makeApp(), { onSkillsGet }) as unknown as CapturedServer;

    const result = await getTool(server, 'skills_get')._handler({ identifier: 'foo' });
    expect(result.isError).toBe(true);
    expect((parseResult(result) as { error: string }).error).toMatch(/No installed skill named/);
  });
});

// ── skills_list_sources ──────────────────────────────────────────────────────────

describe('skills_list_sources', () => {
  it('returns an error when onSkillsListSources is not provided', async () => {
    const server = createObsidianMcpServer(makeApp(), {}) as unknown as CapturedServer;
    const result = await getTool(server, 'skills_list_sources')._handler({});
    expect(result.isError).toBe(true);
  });

  it('returns the sources list on success (sync callback)', async () => {
    const sources = [{ id: 'registry', name: 'skills.sh', type: 'registry' as const }];
    const onSkillsListSources = vi.fn().mockReturnValue(sources);
    const server = createObsidianMcpServer(makeApp(), { onSkillsListSources }) as unknown as CapturedServer;

    const result = await getTool(server, 'skills_list_sources')._handler({});
    expect(parseResult(result)).toEqual(sources);
  });

  it('returns an error (not a throw) when the sync callback throws', async () => {
    const onSkillsListSources = vi.fn().mockImplementation(() => { throw new Error('boom'); });
    const server = createObsidianMcpServer(makeApp(), { onSkillsListSources }) as unknown as CapturedServer;

    const result = await getTool(server, 'skills_list_sources')._handler({});
    expect(result.isError).toBe(true);
    expect((parseResult(result) as { error: string }).error).toMatch(/boom/);
  });
});

// ── skills_check_updates ──────────────────────────────────────────────────────────

describe('skills_check_updates', () => {
  it('returns an error when onSkillsCheckUpdates is not provided', async () => {
    const server = createObsidianMcpServer(makeApp(), {}) as unknown as CapturedServer;
    const result = await getTool(server, 'skills_check_updates')._handler({});
    expect(result.isError).toBe(true);
  });

  it('returns the update-check results on success', async () => {
    const results = [{ id: 'gh-1', name: 'Some Plugin', behindCount: 2, lastFetched: 123 }];
    const onSkillsCheckUpdates = vi.fn().mockResolvedValue(results);
    const server = createObsidianMcpServer(makeApp(), { onSkillsCheckUpdates }) as unknown as CapturedServer;

    const result = await getTool(server, 'skills_check_updates')._handler({});
    expect(parseResult(result)).toEqual(results);
  });

  it('returns an error when the callback rejects', async () => {
    const onSkillsCheckUpdates = vi.fn().mockRejectedValue(new Error('git not found'));
    const server = createObsidianMcpServer(makeApp(), { onSkillsCheckUpdates }) as unknown as CapturedServer;

    const result = await getTool(server, 'skills_check_updates')._handler({});
    expect(result.isError).toBe(true);
    expect((parseResult(result) as { error: string }).error).toMatch(/git not found/);
  });
});

// ── skills_install ──────────────────────────────────────────────────────────────

describe('skills_install', () => {
  it('returns an error when onSkillsInstall is not provided', async () => {
    const server = createObsidianMcpServer(makeApp(), {}) as unknown as CapturedServer;
    const result = await getTool(server, 'skills_install')._handler({
      slug: 'o/r/foo', skillId: 'foo', source: 'o/r', name: 'Foo',
    });
    expect(result.isError).toBe(true);
  });

  it('passes all four fields through to the callback', async () => {
    const onSkillsInstall = vi.fn().mockResolvedValue({ name: 'Foo', targetDir: '/x/.claude/skills/foo' });
    const server = createObsidianMcpServer(makeApp(), { onSkillsInstall }) as unknown as CapturedServer;

    const result = await getTool(server, 'skills_install')._handler({
      slug: 'o/r/foo', skillId: 'foo', source: 'o/r', name: 'Foo',
    });
    expect(onSkillsInstall).toHaveBeenCalledWith({ slug: 'o/r/foo', skillId: 'foo', source: 'o/r', name: 'Foo' });
    expect(parseResult(result)).toEqual({ name: 'Foo', targetDir: '/x/.claude/skills/foo' });
  });

  it('returns an error (not a throw) when install fails', async () => {
    const onSkillsInstall = vi.fn().mockRejectedValue(new Error('A skill named "foo" is already installed'));
    const server = createObsidianMcpServer(makeApp(), { onSkillsInstall }) as unknown as CapturedServer;

    const result = await getTool(server, 'skills_install')._handler({
      slug: 'o/r/foo', skillId: 'foo', source: 'o/r', name: 'Foo',
    });
    expect(result.isError).toBe(true);
    expect((parseResult(result) as { error: string }).error).toMatch(/already installed/);
  });
});

// ── skills_uninstall ──────────────────────────────────────────────────────────

describe('skills_uninstall', () => {
  it('returns an error when onSkillsUninstall is not provided', async () => {
    const server = createObsidianMcpServer(makeApp(), {}) as unknown as CapturedServer;
    const result = await getTool(server, 'skills_uninstall')._handler({ name: 'foo' });
    expect(result.isError).toBe(true);
  });

  it('passes the name through and reports success', async () => {
    const onSkillsUninstall = vi.fn().mockResolvedValue({ skillPath: '/x/.claude/skills/foo' });
    const server = createObsidianMcpServer(makeApp(), { onSkillsUninstall }) as unknown as CapturedServer;

    const result = await getTool(server, 'skills_uninstall')._handler({ name: 'foo' });
    expect(onSkillsUninstall).toHaveBeenCalledWith('foo');
    expect(parseResult(result)).toEqual({ success: true, skillPath: '/x/.claude/skills/foo' });
  });

  it('returns an error (not a throw) when no such skill is installed', async () => {
    const onSkillsUninstall = vi.fn().mockRejectedValue(new Error('No installed skill named "foo"'));
    const server = createObsidianMcpServer(makeApp(), { onSkillsUninstall }) as unknown as CapturedServer;

    const result = await getTool(server, 'skills_uninstall')._handler({ name: 'foo' });
    expect(result.isError).toBe(true);
    expect((parseResult(result) as { error: string }).error).toMatch(/No installed skill named/);
  });
});

// ── skills_update ────────────────────────────────────────────────────────────────

describe('skills_update', () => {
  it('returns an error when onSkillsUpdate is not provided', async () => {
    const server = createObsidianMcpServer(makeApp(), {}) as unknown as CapturedServer;
    const result = await getTool(server, 'skills_update')._handler({ sourceId: 'gh-1' });
    expect(result.isError).toBe(true);
  });

  it('passes the sourceId through and returns the refreshed staleness info', async () => {
    const onSkillsUpdate = vi.fn().mockResolvedValue({ behindCount: 0, lastFetched: 456 });
    const server = createObsidianMcpServer(makeApp(), { onSkillsUpdate }) as unknown as CapturedServer;

    const result = await getTool(server, 'skills_update')._handler({ sourceId: 'gh-1' });
    expect(onSkillsUpdate).toHaveBeenCalledWith('gh-1');
    expect(parseResult(result)).toEqual({ behindCount: 0, lastFetched: 456 });
  });

  it('returns an error (not a throw) when the source id is unknown', async () => {
    const onSkillsUpdate = vi.fn().mockRejectedValue(new Error('No skill source configured with id "gh-1"'));
    const server = createObsidianMcpServer(makeApp(), { onSkillsUpdate }) as unknown as CapturedServer;

    const result = await getTool(server, 'skills_update')._handler({ sourceId: 'gh-1' });
    expect(result.isError).toBe(true);
    expect((parseResult(result) as { error: string }).error).toMatch(/No skill source configured/);
  });
});
