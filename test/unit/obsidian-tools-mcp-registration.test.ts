import { expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
vi.mock('@anthropic-ai/claude-agent-sdk/browser', () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
  createSdkMcpServer: ({ tools }: { tools: unknown[] }) => ({ tools }),
}));
import { createClaudeThreadsMcpServers } from '../../src/ObsidianTools';
import { createMcpRegistration } from '../../src/mcpServerStore';
const app = { plugins: { plugins: {} }, workspace: { getLeavesOfType: () => [] }, vault: {}, metadataCache: {} } as unknown as App;
it('shares one handler across Claude, legacy and direct Codex calls, always confirming accepted registration', async () => {
  const confirm = vi.fn(async () => true);
  const settings = { mcpServers: {} };
  const register = createMcpRegistration({ getSettings: () => settings, confirm, save: async () => {} });
  const servers = createClaudeThreadsMcpServers(app, { onRegisterMcpServer: register });
  const canonical = (servers.claude_threads as any).tools.find((t: any) => t.name === 'mcp_register_server');
  const legacy = (servers.obsidian as any).tools.find((t: any) => t.name === 'mcp_register_server');
  expect(canonical).toBeDefined();
  expect(canonical.handler).toBe(legacy.handler);
  expect(canonical.inputSchema).toBe(legacy.inputSchema);
  const codex = servers.claude_threads.harnessTools!.find(t => t.name === 'mcp_register_server')!;
  expect(codex.requiresApproval).toBe(true);
  const invalid = await codex.invoke({ name: 'x', type: 'stdio', command: 42 });
  expect(JSON.stringify(invalid)).toContain('invalid');
  expect(confirm).not.toHaveBeenCalled();
  await codex.invoke({ name: 'example', type: 'stdio', command: 'example' });
  expect(confirm).toHaveBeenCalledOnce();
});
it('reports missing host callback without writes', async () => {
  const servers = createClaudeThreadsMcpServers(app);
  const codex = servers.claude_threads.harnessTools!.find(t => t.name === 'mcp_register_server')!;
  expect(JSON.stringify(await codex.invoke({ name: 'x', type: 'stdio', command: 'x' }))).toContain('unavailable');
});

/**
 * Regression guard for a real miss: the schema accepted `type: "oauth"` while the
 * tool description still advertised only "stdio, HTTP or SSE" and no field carried
 * any `.describe()` text. Asked to "connect the Vercel MCP server", agents therefore
 * picked `http`, which saved a server that could never authenticate and never opened
 * a consent screen. The transport list is the model's only cue, so it has to name
 * OAuth and the schema has to explain when to use it.
 */
it('advertises the oauth transport to agents, not just in the schema enum', () => {
  const servers = createClaudeThreadsMcpServers(app);
  const canonical = (servers.claude_threads as any).tools.find((t: any) => t.name === 'mcp_register_server');

  expect(canonical.description.toLowerCase()).toContain('oauth');
  // The type field must carry guidance, or the enum value alone is a coin flip.
  const typeDescription = canonical.inputSchema.type?.description ?? '';
  expect(typeDescription.toLowerCase()).toContain('oauth');
  expect(typeDescription.toLowerCase()).toContain('sign-in');
});

it('accepts an oauth registration through the direct Codex path', async () => {
  const onRegisterMcpServer = vi.fn(async () => ({ success: true, status: 'registered' as const, message: 'ok' }));
  const servers = createClaudeThreadsMcpServers(app, { onRegisterMcpServer });
  const codex = servers.claude_threads.harnessTools!.find(t => t.name === 'mcp_register_server')!;

  await codex.invoke({ name: 'vercel', type: 'oauth', url: 'https://mcp.vercel.com/' });

  expect(onRegisterMcpServer).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ name: 'vercel', type: 'oauth', url: 'https://mcp.vercel.com/' }),
  );
});
