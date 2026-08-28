/**
 * Skill root resolution and containment predicates.
 *
 * The plugin treats the user's home Claude config directory (`~/.claude/`) as
 * strictly READ-ONLY: it is scanned and displayed, because the Claude CLI
 * genuinely loads those skills into every session, but the plugin never
 * creates, modifies, or deletes anything inside it. Everything the plugin
 * installs lives under `<vault>/<plugin-dir>/skills/`, beside the existing
 * `skill-sources/` clones.
 *
 * This module is deliberately pure — no Obsidian imports, no DOM, no `App`
 * handle — so `skillManager.ts` (headless), `ThreadManager` (no `App`), the
 * views, and the MCP callbacks can all share exactly one definition of "is
 * this path ours to write to?".
 *
 * Case sensitivity: `realpath` does not normalize case, so on a
 * case-insensitive volume `/vault/Skills/x` and `/vault/skills/x` are the same
 * directory but would fail `isInsideRoot`. Both sides always derive from the
 * same `manifest.dir` join in production, so this is not reachable in practice.
 * Lowercasing instead would break case-sensitive volumes, which is worse.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs') as typeof import('fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path') as typeof import('path');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require('os') as typeof import('os');

/** The generated plugin `name` for the vault skills root. Becomes the user-visible slash-command prefix (`/vault:my-skill`). */
export const VAULT_SKILLS_PLUGIN_NAME = 'vault';

export interface SkillRoots {
  /**
   * `<vault>/<plugin-dir>/skills` — the only place the plugin ever writes.
   * `''` when unresolvable (mobile, no `FileSystemAdapter`, or a test that
   * never called `setSkillRoots`). Callers that need to write must go through
   * `requirePluginRoot`, which turns `''` into a named error rather than a
   * silent fallback to the home directory.
   */
  pluginRoot: string;
  /** `~/.claude/skills` — read-only, managed by Claude Code. */
  homeRoot: string;
  /** `~/.claude/agents` — read-only, managed by Claude Code. */
  homeAgentsRoot: string;
}

/** Minimal shape of an installed skill needed by the edit/remove gates. */
export interface SkillPathPair {
  /** The entry as it sits in a skills root (may itself be a symlink). */
  skillPath: string;
  /** The symlink-resolved target (equals `skillPath` for a plain directory). */
  realPath: string;
}

/** `fs.realpathSync`, falling back to the input when the path does not exist yet. */
function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Expands a leading `~` to the given home directory. */
export function expandHome(p: string, home: string = os.homedir()): string {
  return p.replace(/^~/, home);
}

/**
 * Resolves the three skill roots.
 *
 * `vaultRoot` / `manifestDir` come from `FileSystemAdapter.getBasePath()` and
 * `Plugin.manifest.dir`. When either is missing, `pluginRoot` is `''` — it is
 * NEVER derived from `home`, because a home fallback is exactly the bug this
 * module exists to prevent.
 *
 * Roots are canonicalized with `realpathSync` so containment checks work on
 * macOS, where `os.tmpdir()` resolves `/var` → `/private/var` and symlinked
 * paths would otherwise fail `isInsideRoot`.
 */
export function computeSkillRoots(
  vaultRoot: string,
  manifestDir: string,
  home: string,
): SkillRoots {
  const pluginRoot = vaultRoot && manifestDir
    ? realpathOrSelf(path.join(realpathOrSelf(vaultRoot), manifestDir, 'skills'))
    : '';
  const homeBase = realpathOrSelf(home);
  return {
    pluginRoot,
    homeRoot: realpathOrSelf(path.join(homeBase, '.claude', 'skills')),
    homeAgentsRoot: realpathOrSelf(path.join(homeBase, '.claude', 'agents')),
  };
}

/**
 * Derives the vault skills root from `ThreadManager.pluginResourceDir`
 * (`<vault>/<plugin-dir>`), which is the only plugin-path handle available in
 * harness contexts that have no `App`. Returns `''` for an empty input.
 */
export function pluginSkillsRootFrom(pluginResourceDir: string): string {
  if (!pluginResourceDir) return '';
  return realpathOrSelf(path.join(pluginResourceDir, 'skills'));
}

/**
 * True when `candidate` is `root` itself or sits underneath it.
 *
 * The `+ path.sep` is load-bearing: a bare `startsWith` would treat
 * `<root>-evil/foo` as inside `<root>`.
 */
export function isInsideRoot(candidate: string, root: string): boolean {
  if (!candidate || !root) return false;
  const c = path.resolve(candidate);
  const r = path.resolve(root);
  return c === r || c.startsWith(r + path.sep);
}

// ── Module-level roots ────────────────────────────────────────────────────────

let currentRoots: SkillRoots | null = null;

/** Installs the process-wide roots. Called once from `main.ts` during load. */
export function setSkillRoots(roots: SkillRoots): void {
  currentRoots = roots;
}

/** Clears the process-wide roots (test hook). */
export function resetSkillRoots(): void {
  currentRoots = null;
}

/**
 * The process-wide roots. Before `setSkillRoots` runs (and in tests that never
 * call it) this reports home roots derived live from `os.homedir()` and an
 * empty `pluginRoot`, so read paths keep working and write paths fail loudly.
 */
export function getSkillRoots(): SkillRoots {
  if (currentRoots) return currentRoots;
  return computeSkillRoots('', '', os.homedir());
}

/** The vault skills root, or a named error when it could not be resolved. */
export function requirePluginRoot(roots: SkillRoots = getSkillRoots()): string {
  if (!roots.pluginRoot) {
    throw new Error(
      'Cannot resolve the vault skills folder (<vault>/<plugin-dir>/skills). ' +
      'Skill installs require a desktop vault on a real filesystem; the plugin never writes to ~/.claude/.',
    );
  }
  return roots.pluginRoot;
}

// ── Edit / remove gates ───────────────────────────────────────────────────────

/**
 * Whether the plugin may write to this skill's SKILL.md.
 *
 * Both the entry path AND its symlink target must be inside the vault root.
 * Checking only `skillPath` would let a symlink inside the vault write straight
 * through into whatever user repo it points at, with nothing in the UI saying
 * so — that was the original `saveSkillContent` bug.
 */
export function canEditSkill(skill: SkillPathPair, roots: SkillRoots = getSkillRoots()): boolean {
  if (!roots.pluginRoot) return false;
  return isInsideRoot(skill.realPath, roots.pluginRoot)
    && isInsideRoot(skill.skillPath, roots.pluginRoot);
}

/**
 * Whether the plugin may delete this skill entry.
 *
 * Only `skillPath` matters: `fs.rm` on a symlink removes the link and does not
 * follow it, so removing a vault-local symlink never touches the target repo.
 */
export function canRemoveSkill(skill: { skillPath: string }, roots: SkillRoots = getSkillRoots()): boolean {
  if (!roots.pluginRoot) return false;
  return isInsideRoot(skill.skillPath, roots.pluginRoot);
}

// ── Directory enumeration ─────────────────────────────────────────────────────

/**
 * Absolute paths of every immediate subdirectory of `root` that contains a
 * SKILL.md, sorted for determinism. Returns `[]` for an empty/missing root.
 *
 * Shared by the session `opts.plugins` enumeration and the `/` autocomplete
 * scan, which previously carried two near-identical copies of this loop.
 */
export function enumerateSkillDirs(
  root: string,
  fsModule: typeof import('fs') = fs,
): string[] {
  if (!root) return [];
  let entries: string[];
  try {
    entries = fsModule.readdirSync(root);
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry);
    try {
      if (!fsModule.statSync(entryPath).isDirectory()) continue;
      if (!fsModule.existsSync(path.join(entryPath, 'SKILL.md'))) continue;
      dirs.push(entryPath);
    } catch {
      continue;
    }
  }
  return dirs.sort();
}

// ── Generated plugin manifest ─────────────────────────────────────────────────

/**
 * Ensures `<pluginRoot>/../.claude-plugin/plugin.json` exists so the vault
 * skills folder can be registered with the SDK as ONE local plugin rather than
 * one plugin per skill.
 *
 * Registering the plugin root (a directory holding `.claude-plugin/plugin.json`
 * plus a `skills/` subdir) yields `vault:my-skill`; registering each individual
 * skill directory yields the stuttering `my-skill:my-skill`. Verified against
 * the real `claude` CLI.
 *
 * Returns the plugin root to hand to `{ type: 'local', path }`, or `''` when
 * the manifest could not be written (in which case nothing is registered).
 */
export function ensureVaultSkillsPluginManifest(
  vaultSkillsRoot: string,
  fsModule: typeof import('fs') = fs,
): string {
  if (!vaultSkillsRoot) return '';
  // The SDK expects <pluginRoot>/skills/<skill>/SKILL.md, and vaultSkillsRoot
  // IS that skills/ dir, so the plugin root is its parent.
  const pluginRoot = path.dirname(vaultSkillsRoot);
  const manifestDir = path.join(pluginRoot, '.claude-plugin');
  const manifestPath = path.join(manifestDir, 'plugin.json');
  try {
    if (!fsModule.existsSync(manifestPath)) {
      fsModule.mkdirSync(manifestDir, { recursive: true });
      fsModule.writeFileSync(
        manifestPath,
        JSON.stringify({ name: VAULT_SKILLS_PLUGIN_NAME, version: '1.0.0', skills: './skills' }, null, 2) + '\n',
        'utf-8',
      );
    }
    return pluginRoot;
  } catch {
    return '';
  }
}
