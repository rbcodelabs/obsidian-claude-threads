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

// Fixture for the inline `visualize` card screenshot. A Codex fragment: no
// doctype, no <html>/<body>, and no external resources — the whole point of the
// card is that the plugin wraps it into a themed, sandboxed document. Kept
// deterministic (no animation, no randomness, no CDN) so the baseline is stable.
export const VISUALIZE_FRAGMENT = `<div id="quarterly-revenue">
  <h2>Quarterly revenue</h2>
  <div class="viz-grid">
    <div class="card viz-stat">
      <span class="text-muted text-small">Bookings</span>
      <span class="viz-stat-value">$4.2M</span>
      <span class="text-muted text-small">+12% vs Q2</span>
    </div>
    <div class="card viz-stat">
      <span class="text-muted text-small">Net revenue</span>
      <span class="viz-stat-value">$3.1M</span>
      <span class="text-muted text-small">+8% vs Q2</span>
    </div>
  </div>
  <table class="table table-sm">
    <thead><tr><th>Region</th><th class="text-end">Revenue</th><th>Share</th></tr></thead>
    <tbody>
      <tr>
        <td>North America</td><td class="text-end">$1.8M</td>
        <td><div class="progress" role="progressbar" aria-label="North America share" aria-valuenow="58" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar" style="width:58%"></div></div></td>
      </tr>
      <tr>
        <td>Europe</td><td class="text-end">$0.9M</td>
        <td><div class="progress" role="progressbar" aria-label="Europe share" aria-valuenow="29" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar" style="width:29%"></div></div></td>
      </tr>
      <tr>
        <td>APAC</td><td class="text-end">$0.4M</td>
        <td><div class="progress" role="progressbar" aria-label="APAC share" aria-valuenow="13" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar" style="width:13%"></div></div></td>
      </tr>
    </tbody>
  </table>
  <div class="viz-row">
    <span class="viz-badge">Q3 2026</span>
    <button type="button" class="btn btn-primary">Export</button>
    <button type="button" class="btn">Compare</button>
  </div>
</div>`;

function resolveContent(filePath: string): string {
  if (/\.html?$/i.test(filePath)) return VISUALIZE_FRAGMENT;
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
  // isFile/size/mtimeMs are read by visualizeRenderer's fragment guards; the
  // fixed mtime keeps its document cache key stable across a screenshot run.
  stat: async (p: string) => ({
    isDirectory: () => false,
    isFile: () => true,
    size: resolveContent(p).length,
    mtimeMs: 1_700_000_000_000,
  }),
  realpath: async (p: string) => p,
  readFile: async (p: string, _enc: string) => resolveContent(p),
  writeFile: async (_p: string, _data: string, _enc: string) => {},
  rm: async (_p: string, _opts?: unknown) => {},
  mkdir: async (_p: string, _opts?: unknown) => {},
  cp: async (_src: string, _dst: string, _opts?: unknown) => {},
  // Used by skillManager.ts's listGithubSourceSkills to check a SKILL.md
  // exists before reading it. No screenshot test expands a GitHub source
  // node, so always resolving (never throwing) is enough to satisfy the
  // static `import * as fsp from 'fs/promises'` binding without crashing.
  access: async (_p: string) => {},
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
