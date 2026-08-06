/**
 * skillManager.test.ts
 *
 * Unit tests for the headless skill-management module extracted from
 * SkillsManagerView.ts. This is now the single source of truth for
 * list/search/install/uninstall/update logic — both the Skills Manager UI and
 * the skills_* MCP tools in ObsidianTools.ts delegate here.
 *
 * `requestUrl` (from 'obsidian') is mocked so marketplace-search/description
 * tests don't hit the real network. `listInstalledSkills` and friends read
 * from `~/.claude/skills/`, which is hardcoded (matching the pre-refactor
 * behavior in SkillsManagerView) — tests redirect that by overriding
 * `process.env.HOME` to a temp directory for the duration of each test, since
 * Node's `os.homedir()` reads `$HOME` on every call rather than caching it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import type { SkillSource } from '../../src/types';

const mockRequestUrl = vi.fn();
vi.mock('obsidian', () => ({
  requestUrl: (...args: unknown[]) => mockRequestUrl(...args),
}));

import {
  listInstalledSkills,
  uninstallSkillByPath,
  uninstallSkillByName,
  searchMarketplaceSkills,
  getPopularMarketplaceSkills,
  getMarketplaceSkillDescription,
  getSkillDetail,
  listSkillSources,
  checkSourceForUpdates,
  checkAllSourcesForUpdates,
  pullGithubSourceUpdates,
  listGithubSourceSkills,
  installSkillFromMarketplace,
  codexSkillRoots,
} from '../../src/skillManager';

// ── Home dir sandbox ──────────────────────────────────────────────────────────

let realHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
  realHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skillmanager-home-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (realHome !== undefined) process.env.HOME = realHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  mockRequestUrl.mockReset();
});

function writeInstalledSkill(name: string, description = 'a test skill', dirName = name): string {
  const skillDir = path.join(tmpHome, '.claude', 'skills', dirName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`,
    'utf-8',
  );
  return skillDir;
}

describe('codexSkillRoots', () => {
  it('resolves GitHub, local, and bundled roots for app-server discovery', () => {
    const cloneRoot = path.join(tmpHome, 'source');
    fs.mkdirSync(path.join(cloneRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(cloneRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'test-source', skills: './custom-skills' }),
    );

    expect(codexSkillRoots([
      { id: 'github', name: 'GitHub', type: 'github', clonePath: cloneRoot },
      { id: 'local', name: 'Local', type: 'local', skillsPath: '~/local-skills' },
    ], path.join(tmpHome, 'bundled'))).toEqual([
      path.resolve(cloneRoot, 'custom-skills'),
      path.resolve(tmpHome, 'local-skills'),
      path.resolve(tmpHome, 'bundled'),
    ]);
  });
});

// ── listInstalledSkills ────────────────────────────────────────────────────

describe('listInstalledSkills', () => {
  it('returns an empty array when ~/.claude/skills does not exist', async () => {
    const result = await listInstalledSkills();
    expect(result).toEqual([]);
  });

  it('lists skills installed as directories with SKILL.md', async () => {
    writeInstalledSkill('alpha-skill', 'does alpha things');
    writeInstalledSkill('beta-skill', 'does beta things');

    const result = await listInstalledSkills();

    expect(result.map((s) => s.name)).toEqual(['alpha-skill', 'beta-skill']); // sorted
    expect(result[0].description).toBe('does alpha things');
    expect(result[0].isDirectory).toBe(true);
    expect(result[0].isSymlink).toBe(false);
    expect(result[0].content).toContain('does alpha things');
  });

  it('falls back to the directory name when frontmatter has no name', async () => {
    const skillDir = path.join(tmpHome, '.claude', 'skills', 'no-name-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\ndescription: nameless\n---\n', 'utf-8');

    const result = await listInstalledSkills();
    expect(result[0].name).toBe('no-name-skill');
  });

  it('annotates symlinked skills with the matching configured SkillSource name', async () => {
    // Resolved with realpathSync: on macOS, os.tmpdir() returns a path under
    // /var/... which is itself a symlink to /private/var/..., and
    // fs.promises.realpath() (used internally to resolve the installed
    // symlink) always returns the fully-canonicalized form. A real
    // SkillSource.clonePath (e.g. ~/.claude/skill-sources/<id>) doesn't sit
    // under a symlinked path, so this canonicalization only matters for the
    // temp-dir fixture here, not for production behavior.
    const cloneRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skillmanager-clone-')));
    const skillsDir = path.join(cloneRoot, 'skills');
    const realSkillDir = path.join(skillsDir, 'linked-skill');
    fs.mkdirSync(realSkillDir, { recursive: true });
    fs.writeFileSync(path.join(realSkillDir, 'SKILL.md'), '---\nname: linked-skill\ndescription: linked\n---\n', 'utf-8');

    const installedDir = path.join(tmpHome, '.claude', 'skills');
    fs.mkdirSync(installedDir, { recursive: true });
    fs.symlinkSync(realSkillDir, path.join(installedDir, 'linked-skill'));

    const skillSources: SkillSource[] = [
      { id: 'src-1', name: 'My Plugin Source', type: 'github', clonePath: cloneRoot },
    ];

    try {
      const result = await listInstalledSkills(skillSources);
      const linked = result.find((s) => s.name === 'linked-skill');
      expect(linked?.isSymlink).toBe(true);
      expect(linked?.sourceName).toBe('My Plugin Source');
    } finally {
      fs.rmSync(cloneRoot, { recursive: true, force: true });
    }
  });

  it('skips non-.md, non-directory entries', async () => {
    const skillsDir = path.join(tmpHome, '.claude', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'README.txt'), 'not a skill', 'utf-8');

    const result = await listInstalledSkills();
    expect(result).toEqual([]);
  });
});

// ── uninstallSkillByPath / uninstallSkillByName ───────────────────────────────

describe('uninstallSkillByPath', () => {
  it('removes the skill directory entirely', async () => {
    const skillDir = writeInstalledSkill('to-remove');
    await uninstallSkillByPath(skillDir);
    expect(fs.existsSync(skillDir)).toBe(false);
  });
});

describe('uninstallSkillByName', () => {
  it('finds and removes an installed skill by name', async () => {
    const skillDir = writeInstalledSkill('named-skill');
    const result = await uninstallSkillByName('named-skill');
    expect(result.skillPath).toBe(skillDir);
    expect(fs.existsSync(skillDir)).toBe(false);
  });

  it('throws when no installed skill has that name', async () => {
    await expect(uninstallSkillByName('does-not-exist')).rejects.toThrow(/No installed skill named/);
  });
});

// ── Marketplace search ────────────────────────────────────────────────────────

describe('searchMarketplaceSkills', () => {
  it('maps raw API results and marks already-installed skills', async () => {
    mockRequestUrl.mockResolvedValue({
      status: 200,
      json: {
        skills: [
          { id: 'owner/repo/foo-skill', name: 'Foo Skill', installs: 10, source: 'owner/repo' },
          { id: 'owner2/repo2/bar-skill', name: 'Bar Skill', installs: 500, source: 'owner2/repo2' },
        ],
      },
    });

    const installed = [
      { name: 'Bar Skill', skillPath: '/home/.claude/skills/bar-skill' } as never,
    ];

    const results = await searchMarketplaceSkills('foo', 15, installed);

    // sorted by installs descending
    expect(results.map((r) => r.name)).toEqual(['Bar Skill', 'Foo Skill']);
    expect(results.find((r) => r.name === 'Bar Skill')?.isInstalled).toBe(true);
    expect(results.find((r) => r.name === 'Foo Skill')?.isInstalled).toBe(false);
    expect(mockRequestUrl).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining('q=foo') }),
    );
  });

  it('throws on a non-200 response', async () => {
    mockRequestUrl.mockResolvedValue({ status: 500, json: {} });
    await expect(searchMarketplaceSkills('foo', 15, [])).rejects.toThrow(/HTTP 500/);
  });
});

describe('getPopularMarketplaceSkills', () => {
  it('delegates to the same search endpoint with the "er" query', async () => {
    mockRequestUrl.mockResolvedValue({ status: 200, json: { skills: [] } });
    await getPopularMarketplaceSkills([], 30);
    expect(mockRequestUrl).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining('q=er') }),
    );
  });
});

// ── getMarketplaceSkillDescription ────────────────────────────────────────────

describe('getMarketplaceSkillDescription', () => {
  it('returns null immediately when there is no source', async () => {
    const result = await getMarketplaceSkillDescription('some/slug', '');
    expect(result).toBeNull();
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });

  it('parses the frontmatter description from the first candidate URL that responds 200', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 200,
      text: '---\nname: foo-skill\ndescription: "A quoted description"\n---\n',
    });

    const result = await getMarketplaceSkillDescription('owner/repo/foo-skill', 'owner/repo');
    expect(result).toBe('A quoted description');
  });

  it('falls back to later candidate URLs when earlier ones 404', async () => {
    mockRequestUrl
      .mockResolvedValueOnce({ status: 404 })
      .mockResolvedValueOnce({ status: 404 })
      .mockResolvedValueOnce({ status: 200, text: '---\nname: foo-skill\ndescription: root layout\n---\n' });

    const result = await getMarketplaceSkillDescription('owner/repo/foo-skill', 'owner/repo');
    expect(result).toBe('root layout');
    expect(mockRequestUrl).toHaveBeenCalledTimes(3);
  });

  it('returns null when no candidate responds with a usable description', async () => {
    mockRequestUrl.mockResolvedValue({ status: 404 });
    const result = await getMarketplaceSkillDescription('owner/repo/foo-skill', 'owner/repo');
    expect(result).toBeNull();
  });
});

// ── getSkillDetail ─────────────────────────────────────────────────────────────

describe('getSkillDetail', () => {
  it('returns installed detail (with content) when the identifier matches an installed skill name', async () => {
    writeInstalledSkill('installed-one', 'installed description');

    const result = await getSkillDetail('installed-one');
    expect(result.installed).toBe(true);
    expect(result.description).toBe('installed description');
    expect(result.content).toContain('installed-one');
  });

  it('falls back to a marketplace lookup when not installed and identifier looks like a slug', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 200,
      text: '---\nname: not-installed\ndescription: from marketplace\n---\n',
    });

    const result = await getSkillDetail('owner/repo/not-installed');
    expect(result.installed).toBe(false);
    expect(result.slug).toBe('owner/repo/not-installed');
    expect(result.source).toBe('owner/repo');
    expect(result.description).toBe('from marketplace');
  });

  it('throws when not installed and the identifier is not a marketplace-slug shape', async () => {
    await expect(getSkillDetail('just-a-name')).rejects.toThrow(/does not look like a marketplace slug/);
  });
});

// ── listSkillSources ───────────────────────────────────────────────────────────

describe('listSkillSources', () => {
  it('always includes the built-in skills.sh registry pseudo-source', () => {
    const result = listSkillSources([]);
    expect(result).toEqual([{ id: 'registry', name: 'skills.sh', type: 'registry' }]);
  });

  it('includes configured sources alongside the registry', () => {
    const sources: SkillSource[] = [
      { id: 'gh-1', name: 'Some Plugin', type: 'github', repoUrl: 'https://github.com/o/r', behindCount: 2, lastFetched: 123 },
    ];
    const result = listSkillSources(sources);
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({ id: 'gh-1', name: 'Some Plugin', type: 'github', repoUrl: 'https://github.com/o/r', behindCount: 2, lastFetched: 123 });
  });
});

// ── Git-backed source updates (real local repos, no network) ─────────────────

function initGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execSync('git init --quiet -b main', { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'file.txt'), 'v1', 'utf-8');
  execSync('git add . && git commit --quiet -m "initial"', { cwd: dir });
}

describe('checkSourceForUpdates / checkAllSourcesForUpdates / pullGithubSourceUpdates', () => {
  let origin: string;
  let clone: string;

  beforeEach(() => {
    origin = fs.mkdtempSync(path.join(os.tmpdir(), 'skillmanager-origin-'));
    clone = fs.mkdtempSync(path.join(os.tmpdir(), 'skillmanager-clone-'));
    fs.rmSync(clone, { recursive: true, force: true }); // git clone needs the target to not exist
    initGitRepo(origin);
    execSync(`git clone --quiet "${origin}" "${clone}"`);
  });

  afterEach(() => {
    fs.rmSync(origin, { recursive: true, force: true });
    fs.rmSync(clone, { recursive: true, force: true });
  });

  it('reports behindCount 0 right after a fresh clone', async () => {
    const source: SkillSource = { id: 's1', name: 'Test Source', type: 'github', clonePath: clone };
    const result = await checkSourceForUpdates(source);
    expect(result.error).toBeUndefined();
    expect(result.behindCount).toBe(0);
    expect(result.lastFetched).toBeGreaterThan(0);
  });

  it('reports a positive behindCount after the origin gains commits', async () => {
    fs.writeFileSync(path.join(origin, 'file2.txt'), 'v2', 'utf-8');
    execSync('git add . && git commit --quiet -m "second commit"', { cwd: origin });

    const source: SkillSource = { id: 's1', name: 'Test Source', type: 'github', clonePath: clone };
    const result = await checkSourceForUpdates(source);
    expect(result.behindCount).toBe(1);
  });

  it('returns an error result (not a throw) when clonePath is missing', async () => {
    const source: SkillSource = { id: 's1', name: 'Test Source', type: 'github' };
    const result = await checkSourceForUpdates(source);
    expect(result.error).toMatch(/No clone path configured/);
  });

  it('returns an error result when the clonePath is not a git repo', async () => {
    const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillmanager-notgit-'));
    try {
      const source: SkillSource = { id: 's1', name: 'Test Source', type: 'github', clonePath: badDir };
      const result = await checkSourceForUpdates(source);
      expect(result.error).toBeTruthy();
    } finally {
      fs.rmSync(badDir, { recursive: true, force: true });
    }
  });

  it('checkAllSourcesForUpdates only checks github-type sources with a clonePath', async () => {
    const sources: SkillSource[] = [
      { id: 's1', name: 'GitHub Source', type: 'github', clonePath: clone },
      { id: 's2', name: 'Local Source', type: 'local', skillsPath: '~/some/path' },
      { id: 's3', name: 'No Clone Path', type: 'github' },
    ];
    const results = await checkAllSourcesForUpdates(sources);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('s1');
  });

  it('pullGithubSourceUpdates pulls new commits and resets behindCount to 0', async () => {
    fs.writeFileSync(path.join(origin, 'file2.txt'), 'v2', 'utf-8');
    execSync('git add . && git commit --quiet -m "second commit"', { cwd: origin });

    const source: SkillSource = { id: 's1', name: 'Test Source', type: 'github', clonePath: clone };
    const result = await pullGithubSourceUpdates(source);
    expect(result.behindCount).toBe(0);
    expect(fs.existsSync(path.join(clone, 'file2.txt'))).toBe(true);
  });

  it('pullGithubSourceUpdates throws when clonePath is missing', async () => {
    const source: SkillSource = { id: 's1', name: 'Test Source', type: 'github' };
    await expect(pullGithubSourceUpdates(source)).rejects.toThrow(/no clone path configured/);
  });
});

// ── listGithubSourceSkills ─────────────────────────────────────────────────────

describe('listGithubSourceSkills', () => {
  it('returns an empty array when clonePath is missing', async () => {
    const result = await listGithubSourceSkills({ id: 's1', name: 'x', type: 'github' });
    expect(result).toEqual([]);
  });

  it('lists skills under <clonePath>/skills/ by default', async () => {
    const clonePath = fs.mkdtempSync(path.join(os.tmpdir(), 'skillmanager-source-'));
    try {
      const skillDir = path.join(clonePath, 'skills', 'my-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: my-skill\ndescription: from source\n---\n', 'utf-8');

      const result = await listGithubSourceSkills({ id: 's1', name: 'x', type: 'github', clonePath });
      expect(result).toEqual([{ id: 'my-skill', name: 'my-skill', description: 'from source', skillDir }]);
    } finally {
      fs.rmSync(clonePath, { recursive: true, force: true });
    }
  });

  it('respects a custom skills path declared in .claude-plugin/plugin.json', async () => {
    const clonePath = fs.mkdtempSync(path.join(os.tmpdir(), 'skillmanager-source-'));
    try {
      fs.mkdirSync(path.join(clonePath, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(
        path.join(clonePath, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'my-plugin', skills: 'custom-skills-dir' }),
        'utf-8',
      );
      const skillDir = path.join(clonePath, 'custom-skills-dir', 'nested-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: nested-skill\n---\n', 'utf-8');

      const result = await listGithubSourceSkills({ id: 's1', name: 'x', type: 'github', clonePath });
      expect(result).toEqual([{ id: 'nested-skill', name: 'nested-skill', description: '', skillDir }]);
    } finally {
      fs.rmSync(clonePath, { recursive: true, force: true });
    }
  });
});

// ── installSkillFromMarketplace (fast-fail paths only — full install requires network) ─

describe('installSkillFromMarketplace', () => {
  it('throws immediately when the skill has no GitHub source', async () => {
    await expect(
      installSkillFromMarketplace({ slug: 'x/y/z', skillId: 'z', name: 'Z', source: '' }),
    ).rejects.toThrow(/No GitHub source available/);
  });

  it('throws before attempting to clone when a skill with that id is already installed', async () => {
    writeInstalledSkill('already-there', 'existing', 'already-there');

    await expect(
      installSkillFromMarketplace({ slug: 'owner/repo/already-there', skillId: 'already-there', name: 'Already There', source: 'owner/repo' }),
    ).rejects.toThrow(/already installed/);
  });
});
