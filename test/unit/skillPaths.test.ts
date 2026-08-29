/**
 * skillPaths.test.ts
 *
 * Covers the containment predicates and root resolution that enforce the
 * plugin's one hard rule: never create, modify, or delete anything under
 * `~/.claude/`.
 *
 * The full gate matrix (vault skill, home skill, home symlink into a user repo,
 * vault symlink into a user repo, sibling-prefix path, unresolvable root) is
 * asserted explicitly, because each row corresponds to a real bug class:
 * write-through into a user's git repo, deletion of a Claude-Code-managed
 * skill, and a bare-`startsWith` prefix escape.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  VAULT_SKILLS_PLUGIN_NAME,
  computeSkillRoots,
  pluginSkillsRootFrom,
  isInsideRoot,
  expandHome,
  setSkillRoots,
  resetSkillRoots,
  getSkillRoots,
  requirePluginRoot,
  canEditSkill,
  canRemoveSkill,
  enumerateSkillDirs,
  ensureVaultSkillsPluginManifest,
  type SkillRoots,
} from '../../src/skillPaths';

const MANIFEST_DIR = '.obsidian/plugins/claude-threads';

let tmpVault: string;
let tmpHome: string;

beforeEach(() => {
  // realpathSync: on macOS os.tmpdir() lives under /var, itself a symlink to
  // /private/var. computeSkillRoots canonicalizes its roots, so the fixtures
  // have to be canonical too or every containment assertion would be comparing
  // /var/... against /private/var/... and failing for the wrong reason.
  tmpVault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skillpaths-vault-')));
  tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skillpaths-home-')));
});

afterEach(() => {
  resetSkillRoots();
  fs.rmSync(tmpVault, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function roots(): SkillRoots {
  return computeSkillRoots(tmpVault, MANIFEST_DIR, tmpHome);
}

// ── computeSkillRoots ─────────────────────────────────────────────────────────

describe('computeSkillRoots', () => {
  it('resolves the plugin root beside skill-sources inside the vault', () => {
    const r = roots();
    expect(r.pluginRoot).toBe(path.join(tmpVault, MANIFEST_DIR, 'skills'));
  });

  it('resolves the read-only home roots from the given home directory', () => {
    const r = roots();
    expect(r.homeRoot).toBe(path.join(tmpHome, '.claude', 'skills'));
    expect(r.homeAgentsRoot).toBe(path.join(tmpHome, '.claude', 'agents'));
  });

  it('returns an empty pluginRoot — never a home fallback — when the vault root is unknown', () => {
    const r = computeSkillRoots('', MANIFEST_DIR, tmpHome);
    expect(r.pluginRoot).toBe('');
    expect(r.pluginRoot).not.toContain(tmpHome);
  });

  it('returns an empty pluginRoot — never a home fallback — when the manifest dir is unknown', () => {
    const r = computeSkillRoots(tmpVault, '', tmpHome);
    expect(r.pluginRoot).toBe('');
    expect(r.pluginRoot).not.toContain(tmpHome);
  });

  it('canonicalizes a symlinked vault root so containment checks still match', () => {
    const realVault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skillpaths-real-')));
    const linkVault = path.join(tmpVault, 'link-to-vault');
    fs.symlinkSync(realVault, linkVault);
    try {
      const r = computeSkillRoots(linkVault, MANIFEST_DIR, tmpHome);
      expect(r.pluginRoot).toBe(path.join(realVault, MANIFEST_DIR, 'skills'));
    } finally {
      fs.rmSync(realVault, { recursive: true, force: true });
    }
  });
});

describe('pluginSkillsRootFrom', () => {
  it('appends skills/ to the plugin resource dir', () => {
    const resourceDir = path.join(tmpVault, MANIFEST_DIR);
    expect(pluginSkillsRootFrom(resourceDir)).toBe(path.join(resourceDir, 'skills'));
  });

  it('returns an empty string for an empty resource dir', () => {
    expect(pluginSkillsRootFrom('')).toBe('');
  });
});

describe('expandHome', () => {
  it('expands a leading tilde', () => {
    expect(expandHome('~/skills', '/Users/test')).toBe('/Users/test/skills');
  });

  it('leaves absolute paths alone', () => {
    expect(expandHome('/abs/skills', '/Users/test')).toBe('/abs/skills');
  });
});

// ── isInsideRoot ──────────────────────────────────────────────────────────────

describe('isInsideRoot', () => {
  it('accepts a direct child', () => {
    expect(isInsideRoot('/a/b/c', '/a/b')).toBe(true);
  });

  it('accepts a deeply nested descendant', () => {
    expect(isInsideRoot('/a/b/c/d/e', '/a/b')).toBe(true);
  });

  it('accepts the root itself', () => {
    expect(isInsideRoot('/a/b', '/a/b')).toBe(true);
  });

  it('rejects a sibling directory sharing the root as a string prefix', () => {
    expect(isInsideRoot('/a/b-evil/c', '/a/b')).toBe(false);
    expect(isInsideRoot('/a/b-evil', '/a/b')).toBe(false);
  });

  it('rejects a parent of the root', () => {
    expect(isInsideRoot('/a', '/a/b')).toBe(false);
  });

  it('rejects when either side is empty', () => {
    expect(isInsideRoot('', '/a/b')).toBe(false);
    expect(isInsideRoot('/a/b/c', '')).toBe(false);
  });

  it('normalizes traversal segments before comparing', () => {
    expect(isInsideRoot('/a/b/../b-evil/c', '/a/b')).toBe(false);
    expect(isInsideRoot('/a/b/c/../d', '/a/b')).toBe(true);
  });
});

// ── setSkillRoots / getSkillRoots / requirePluginRoot ─────────────────────────

describe('skill root registry', () => {
  it('reports an empty pluginRoot and live home roots before setSkillRoots runs', () => {
    const r = getSkillRoots();
    expect(r.pluginRoot).toBe('');
    expect(r.homeRoot).toContain(path.join('.claude', 'skills'));
  });

  it('returns the installed roots after setSkillRoots', () => {
    setSkillRoots(roots());
    expect(getSkillRoots().pluginRoot).toBe(path.join(tmpVault, MANIFEST_DIR, 'skills'));
  });

  it('requirePluginRoot returns the root when resolvable', () => {
    expect(requirePluginRoot(roots())).toBe(path.join(tmpVault, MANIFEST_DIR, 'skills'));
  });

  it('requirePluginRoot throws a named error instead of falling back to home', () => {
    expect(() => requirePluginRoot(computeSkillRoots('', '', tmpHome)))
      .toThrow(/never writes to ~\/\.claude/);
  });
});

// ── The gate matrix ───────────────────────────────────────────────────────────

describe('canEditSkill / canRemoveSkill gate matrix', () => {
  let r: SkillRoots;
  let userRepo: string;

  beforeEach(() => {
    r = roots();
    userRepo = path.join(tmpVault, 'some-user-repo', 'skills', 'thing');
  });

  it('vault skill: editable and removable', () => {
    const s = { skillPath: path.join(r.pluginRoot, 'mine'), realPath: path.join(r.pluginRoot, 'mine') };
    expect(canEditSkill(s, r)).toBe(true);
    expect(canRemoveSkill(s, r)).toBe(true);
  });

  it('home skill: neither editable nor removable', () => {
    const s = { skillPath: path.join(r.homeRoot, 'agent-browser'), realPath: path.join(r.homeRoot, 'agent-browser') };
    expect(canEditSkill(s, r)).toBe(false);
    expect(canRemoveSkill(s, r)).toBe(false);
  });

  it('home symlink into a user repo: not editable (no write-through) and not removable', () => {
    const s = { skillPath: path.join(r.homeRoot, 'linked'), realPath: userRepo };
    expect(canEditSkill(s, r)).toBe(false);
    expect(canRemoveSkill(s, r)).toBe(false);
  });

  it('vault symlink into a user repo: not editable, but removable (rm unlinks, does not follow)', () => {
    const s = { skillPath: path.join(r.pluginRoot, 'linked'), realPath: userRepo };
    expect(canEditSkill(s, r)).toBe(false);
    expect(canRemoveSkill(s, r)).toBe(true);
  });

  it('sibling-prefix path (<pluginRoot>-evil/foo): neither editable nor removable', () => {
    const evil = `${r.pluginRoot}-evil`;
    const s = { skillPath: path.join(evil, 'foo'), realPath: path.join(evil, 'foo') };
    expect(canEditSkill(s, r)).toBe(false);
    expect(canRemoveSkill(s, r)).toBe(false);
  });

  it("pluginRoot === '': neither editable nor removable, even for a home-looking path", () => {
    const empty = computeSkillRoots('', '', tmpHome);
    const s = { skillPath: path.join(empty.homeRoot, 'x'), realPath: path.join(empty.homeRoot, 'x') };
    expect(canEditSkill(s, empty)).toBe(false);
    expect(canRemoveSkill(s, empty)).toBe(false);
  });

  it('falls back to the installed roots when none are passed', () => {
    setSkillRoots(r);
    const s = { skillPath: path.join(r.pluginRoot, 'mine'), realPath: path.join(r.pluginRoot, 'mine') };
    expect(canEditSkill(s)).toBe(true);
    expect(canRemoveSkill(s)).toBe(true);
  });
});

// ── enumerateSkillDirs ────────────────────────────────────────────────────────

describe('enumerateSkillDirs', () => {
  it('returns an empty array for an empty or missing root', () => {
    expect(enumerateSkillDirs('')).toEqual([]);
    expect(enumerateSkillDirs(path.join(tmpVault, 'nope'))).toEqual([]);
  });

  it('returns only subdirectories containing a SKILL.md, sorted', () => {
    const root = path.join(tmpVault, 'skills');
    for (const name of ['zeta', 'alpha']) {
      fs.mkdirSync(path.join(root, name), { recursive: true });
      fs.writeFileSync(path.join(root, name, 'SKILL.md'), `---\nname: ${name}\n---\n`, 'utf-8');
    }
    fs.mkdirSync(path.join(root, 'not-a-skill'), { recursive: true });
    fs.writeFileSync(path.join(root, 'loose.md'), 'x', 'utf-8');

    expect(enumerateSkillDirs(root)).toEqual([
      path.join(root, 'alpha'),
      path.join(root, 'zeta'),
    ]);
  });

  it('follows symlinked skill directories', () => {
    const target = path.join(tmpVault, 'external', 'linked');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'SKILL.md'), '---\nname: linked\n---\n', 'utf-8');

    const root = path.join(tmpVault, 'skills');
    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync(target, path.join(root, 'linked'));

    expect(enumerateSkillDirs(root)).toEqual([path.join(root, 'linked')]);
  });
});

// ── ensureVaultSkillsPluginManifest ───────────────────────────────────────────

describe('ensureVaultSkillsPluginManifest', () => {
  it('writes a plugin manifest at the parent of the skills root and returns that parent', () => {
    const skillsRoot = path.join(tmpVault, MANIFEST_DIR, 'skills');
    fs.mkdirSync(skillsRoot, { recursive: true });

    const pluginRoot = ensureVaultSkillsPluginManifest(skillsRoot);
    expect(pluginRoot).toBe(path.join(tmpVault, MANIFEST_DIR));

    const manifest = JSON.parse(
      fs.readFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf-8'),
    );
    expect(manifest.name).toBe(VAULT_SKILLS_PLUGIN_NAME);
    expect(manifest.skills).toBe('./skills');
  });

  it('does not overwrite an existing manifest', () => {
    const skillsRoot = path.join(tmpVault, MANIFEST_DIR, 'skills');
    const manifestPath = path.join(tmpVault, MANIFEST_DIR, '.claude-plugin', 'plugin.json');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({ name: 'custom' }), 'utf-8');

    ensureVaultSkillsPluginManifest(skillsRoot);
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')).name).toBe('custom');
  });

  it('returns an empty string for an empty root rather than writing anywhere', () => {
    expect(ensureVaultSkillsPluginManifest('')).toBe('');
  });
});
