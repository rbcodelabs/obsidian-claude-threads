const SKILLS: Array<{ name: string; description: string; content: string }> = [
  {
    name: 'brain-dump',
    description: 'Interactive knowledge extraction — structured interview to capture tacit knowledge.',
    content: '',
  },
  {
    name: 'brainstorm',
    description: 'Active ideation partner — Claude leads the session, proposes angles, surfaces frameworks.',
    content: '',
  },
  {
    name: 'chief-of-staff',
    description: 'Standing behavioral rules for how Claude acts as your chief of staff.',
    content: '',
  },
  {
    name: 'nextjs-local-dev',
    description: 'Manage a local Next.js dev server — start, stop, restart, monitor logs.',
    content: '',
  },
  {
    name: 'pr-checklist',
    description: 'Run the pre-PR definition-of-done checklist before opening a pull request.',
    content: '',
  },
  {
    name: 'vercel-tools',
    description: 'Vercel CLI recipes — check deploy status, apply migrations, watch deployments.',
    content: '',
  },
];

// build content from name/description
for (const s of SKILLS) {
  s.content = `---\nname: ${s.name}\ndescription: ${s.description}\n---\n\n# ${s.name}\n\nThis skill teaches Claude how to ${s.description.toLowerCase()}\n`;
}

function makeEntries() {
  return SKILLS.map((s) => ({
    name: `${s.name}.md`,
    isSymbolicLink: () => false,
    isDirectory: () => false,
  }));
}

// Fixture for ~/.claude/settings.json — read by claudeSettingsMcp(Editor).ts
// via require('fs').readFileSync(). Populated with one server of each shape
// (stdio, http, sdk) so the Settings → MCP tab screenshot shows real rows,
// including the read-only sdk entry, instead of just an empty state.
const MCP_SETTINGS_JSON = JSON.stringify(
  {
    model: 'sonnet',
    mcpServers: {
      obsidian_notes: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@example/obsidian-notes-mcp'],
        env: { NOTES_API_TOKEN: '${NOTES_API_TOKEN}' },
      },
      compass: {
        type: 'http',
        url: 'https://compass.rbcodelabs.com/api/mcp',
        headers: { Authorization: 'Bearer ${COMPASS_API_KEY}' },
      },
      internal_tools: {
        type: 'sdk',
        name: 'internal-tools',
      },
    },
  },
  null,
  2,
);

function resolveContent(filePath: string): string {
  if (filePath.endsWith('settings.json')) return MCP_SETTINGS_JSON;
  for (const s of SKILLS) {
    if (filePath.includes(s.name)) return s.content;
  }
  return '';
}

// Named exports so dynamic require('fs') at runtime returns the right shape.
// (esbuild wraps ESM as { __esModule: true, default: ..., ...namedExports };
// callers using require() get the namespace, not the default, so named exports
// are required for dynamic require() calls in SkillsManagerView to work.)

export const existsSync = (_p: string) => false;
export const readdirSync = (_p: string) => SKILLS.map((s) => `${s.name}.md`);
export const readFileSync = (p: string, _enc: string): string => resolveContent(p);
export const statSync = (_p: string) => ({ isDirectory: () => false });
// realpathSync/mkdirSync/writeFileSync are no-ops in the harness — the MCP
// settings tab reads via readFileSync above; writes (Add/Edit/Remove) are
// exercised by the unit tests against the real fs, not this browser harness.
export const realpathSync = (p: string) => p;
export const mkdirSync = (_p: string, _opts?: unknown) => undefined;
export const writeFileSync = (_p: string, _data: string, _enc?: string) => undefined;

export const promises = {
  readdir: async (_path: string, _opts?: unknown) => makeEntries(),
  stat: async (_path: string) => ({ isDirectory: () => false }),
  realpath: async (p: string) => p,
  readFile: async (p: string, _enc: string) => resolveContent(p),
  writeFile: async (_p: string, _data: string, _enc: string) => {},
  rm: async (_p: string, _opts?: unknown) => {},
  mkdir: async (_p: string, _opts?: unknown) => {},
  cp: async (_src: string, _dst: string, _opts?: unknown) => {},
};

// Also keep a default export for static `import fs from 'fs'` usage.
export default {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  promises,
};
