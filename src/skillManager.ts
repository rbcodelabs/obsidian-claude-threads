/**
 * Headless skill-management module: list/search/install/uninstall/update logic
 * for the `~/.claude/skills/` marketplace and configured SkillSources.
 *
 * This is the single source of truth for skill management — both
 * `SkillsManagerView.ts` (the UI) and the `skills_*` MCP tools in
 * `ObsidianTools.ts` delegate here. Zero DOM/UI dependencies: no
 * `ItemView`/`containerEl`, no `Notice`, no rendering. Callers own presentation
 * (Notices, re-renders, progress UI) and persistence of `SkillSource[]` mutations.
 */
import { requestUrl } from 'obsidian';
import fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import type { SkillSource } from './types';
import { getSkillsDirForSource } from './claudeSettings';

/** Resolve configured sources to roots containing Codex skill directories. */
export function codexSkillRoots(skillSources: SkillSource[] = [], bundledSkillsRoot?: string): string[] {
  const roots: string[] = [];
  for (const source of skillSources) {
    if (source.type === 'github' && source.clonePath) {
      roots.push(getSkillsDirForSource(source.clonePath));
    } else if (source.type === 'local' && source.skillsPath) {
      roots.push(source.skillsPath.replace(/^~/, os.homedir()));
    }
  }
  if (bundledSkillsRoot) roots.push(bundledSkillsRoot);
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

// ── Frontmatter parsing ───────────────────────────────────────────────────────

/** Parses `name`/`description` out of a SKILL.md's YAML frontmatter block. */
export function parseFrontmatter(content: string): { name: string; description: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { name: '', description: '' };
  const fm = match[1];

  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const name = nameMatch?.[1]?.trim() ?? '';

  // Parse description, handling YAML block scalar indicators (>- >  |- |)
  const descLineMatch = fm.match(/^description:(.*)$/m);
  if (!descLineMatch) return { name, description: '' };

  const afterColon = descLineMatch[1].trim();

  // Block scalar: value on the key line is just the indicator (> >- | |-), content follows on indented lines
  if (/^[>|]-?$/.test(afterColon)) {
    const isFolded = afterColon.startsWith('>');
    const fmLines = fm.split(/\r?\n/);
    const keyLineIndex = fmLines.findIndex((l) => /^description:/.test(l));
    const bodyLines: string[] = [];
    for (let i = keyLineIndex + 1; i < fmLines.length; i++) {
      const line = fmLines[i];
      // Indented lines (at least one space) or blank lines belong to the block
      if (line === '' || /^\s/.test(line)) {
        bodyLines.push(line.trim());
      } else {
        break;
      }
    }
    // Strip trailing empty lines (chomping)
    while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') {
      bodyLines.pop();
    }
    const description = isFolded
      ? bodyLines.join(' ').trim()
      : bodyLines.join('\n').trim();
    return { name, description };
  }

  // Inline value: strip surrounding quotes
  const description = afterColon.replace(/^["']|["']$/g, '');
  return { name, description };
}

// ── Installed skills ──────────────────────────────────────────────────────────

export interface InstalledSkillInfo {
  name: string;
  description: string;
  /** Path inside ~/.claude/skills/ (may be a symlink) */
  skillPath: string;
  /** Resolved real path after following symlinks */
  realPath: string;
  isSymlink: boolean;
  isDirectory: boolean;
  /** Absolute path to the SKILL.md (or .md file) to read/write */
  skillMdPath: string;
  content: string;
  /** Name of the configured SkillSource this skill's real path belongs to, if any */
  sourceName?: string;
}

/**
 * Scans `~/.claude/skills/` and returns every installed skill (directories
 * containing a SKILL.md, or standalone .md files), annotated with which
 * configured SkillSource (if any) a symlinked skill belongs to.
 */
export async function listInstalledSkills(skillSources: SkillSource[] = []): Promise<InstalledSkillInfo[]> {
  const skillsDir = path.join(os.homedir(), '.claude', 'skills');

  let entries: import('fs').Dirent[];
  try {
    entries = await fsp.readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: InstalledSkillInfo[] = [];

  for (const entry of entries) {
    const skillPath = path.join(skillsDir, entry.name);

    try {
      const isSymlink = entry.isSymbolicLink();
      let realPath = skillPath;
      if (isSymlink) {
        try {
          realPath = await fsp.realpath(skillPath);
        } catch {
          realPath = skillPath;
        }
      }

      const stat = await fsp.stat(skillPath);
      const isDirectory = stat.isDirectory();

      // Determine where SKILL.md lives
      let skillMdPath: string;
      if (isDirectory) {
        skillMdPath = path.join(realPath, 'SKILL.md');
      } else if (entry.name.endsWith('.md')) {
        skillMdPath = realPath;
      } else {
        continue; // skip non-.md non-directory entries
      }

      let content = '';
      try {
        content = await fsp.readFile(skillMdPath, 'utf-8');
      } catch {
        // SKILL.md missing — keep empty content
      }

      const { name, description } = parseFrontmatter(content);

      skills.push({
        name: name || entry.name.replace(/\.md$/, ''),
        description,
        skillPath,
        realPath,
        isSymlink,
        isDirectory,
        skillMdPath,
        content,
      });
    } catch (err) {
      console.warn(`[ClaudeThreads] Skipping skill entry "${entry.name}":`, err);
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));

  // Compute sourceName for symlinked skills by matching against configured SkillSources
  if (skillSources.length > 0) {
    for (const skill of skills) {
      if (!skill.isSymlink) continue;
      for (const source of skillSources) {
        const sourcePath = source.type === 'github' ? source.clonePath : (source.skillsPath ?? '');
        const expandedSourcePath = (sourcePath ?? '').replace(/^~/, os.homedir());
        if (expandedSourcePath && skill.realPath.startsWith(expandedSourcePath)) {
          skill.sourceName = source.name;
          break;
        }
      }
    }
  }

  return skills;
}

/** Removes an installed skill's directory/file entirely. Caller resolves the path first (e.g. via `listInstalledSkills`). */
export async function uninstallSkillByPath(skillPath: string): Promise<void> {
  await fsp.rm(skillPath, { recursive: true, force: true });
}

/** Looks up an installed skill by name and removes it. Throws if no skill with that name is installed. */
export async function uninstallSkillByName(
  name: string,
  skillSources: SkillSource[] = [],
): Promise<{ skillPath: string }> {
  const installed = await listInstalledSkills(skillSources);
  const match = installed.find((s) => s.name === name);
  if (!match) {
    throw new Error(`No installed skill named "${name}"`);
  }
  await uninstallSkillByPath(match.skillPath);
  return { skillPath: match.skillPath };
}

// ── Marketplace (skills.sh) search ────────────────────────────────────────────

export interface MarketplaceSkill {
  name: string;
  /** Full skills.sh id, e.g. "owner/repo/skill-name". Used as the canonical key. */
  slug: string;
  /** Bare skill folder name (last path segment of slug). Used as the install dir basename. */
  skillId: string;
  source: string;
  installs: number;
  isInstalled: boolean;
}

interface RawMarketplaceSkill {
  id: string;
  skillId?: string;
  name: string;
  installs: number;
  source: string;
}

function toMarketplaceSkills(
  raw: RawMarketplaceSkill[],
  installedSkills: InstalledSkillInfo[],
): MarketplaceSkill[] {
  const installedNames = new Set(installedSkills.map((s) => s.name));
  const installedSlugs = new Set(installedSkills.map((s) => s.skillPath.split('/').pop() ?? ''));

  return raw
    .map((s) => {
      const skillId = s.skillId || s.id.split('/').pop() || s.id;
      return {
        name: s.name,
        slug: s.id,
        skillId,
        source: s.source ?? '',
        installs: s.installs ?? 0,
        isInstalled: installedNames.has(s.name) || installedSlugs.has(skillId),
      };
    })
    .sort((a, b) => b.installs - a.installs);
}

/** Searches the skills.sh marketplace registry for the given query, annotating results already installed locally. */
export async function searchMarketplaceSkills(
  query: string,
  limit: number,
  installedSkills: InstalledSkillInfo[],
): Promise<MarketplaceSkill[]> {
  const res = await requestUrl({
    url: `https://skills.sh/api/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    method: 'GET',
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);

  const data = res.json as { skills: RawMarketplaceSkill[] };
  return toMarketplaceSkills(data.skills ?? [], installedSkills);
}

/**
 * Fetches a "popular skills" list shown when browsing with no search query.
 * Uses the same underlying search endpoint as `searchMarketplaceSkills` with a
 * broad query — there's no dedicated "popular" endpoint on skills.sh.
 */
export async function getPopularMarketplaceSkills(
  installedSkills: InstalledSkillInfo[],
  limit = 30,
): Promise<MarketplaceSkill[]> {
  return searchMarketplaceSkills('er', limit, installedSkills);
}

/** Fetches and parses a marketplace skill's SKILL.md description from its GitHub source, trying a few common repo layouts. Returns null if none could be found/parsed. */
export async function getMarketplaceSkillDescription(slug: string, source: string): Promise<string | null> {
  if (!source) return null;

  // Derive the skill's own ID (last path segment after removing the source prefix)
  const skillId = slug.startsWith(source + '/') ? slug.slice(source.length + 1) : slug;

  // Try common SKILL.md locations in the repo, in order
  const candidates = [
    `https://raw.githubusercontent.com/${source}/main/skills/${skillId}/SKILL.md`,
    `https://raw.githubusercontent.com/${source}/main/${skillId}/SKILL.md`,
    `https://raw.githubusercontent.com/${source}/main/SKILL.md`,
  ];

  for (const url of candidates) {
    try {
      const res = await requestUrl({ url, method: 'GET', throw: false });
      if (res.status === 200 && res.text) {
        const { description: fm } = parseFrontmatter(res.text);
        if (fm) {
          return fm.replace(/^["']|["']$/g, '');
        }
        // No frontmatter description — try first non-heading, non-empty paragraph
        const lines = res.text.split('\n');
        const start = lines.findIndex((l) => l.startsWith('---')) >= 0
          ? lines.findIndex((l, i) => i > 0 && l.startsWith('---')) + 1
          : 0;
        const body = lines.slice(start).join('\n');
        const para = body.match(/(?:^|\n)(?!#|\s*```)[^\n]{20,}/m);
        if (para) {
          return para[0].trim();
        }
      }
    } catch { /* try next candidate */ }
  }

  return null;
}

// ── Skill detail (installed or marketplace) ───────────────────────────────────

export interface SkillDetailResult {
  name: string;
  description: string;
  installed: boolean;
  /** Full SKILL.md content — only present when `installed` is true. */
  content?: string;
  skillPath?: string;
  realPath?: string;
  isSymlink?: boolean;
  sourceName?: string;
  /** Marketplace fields — only present when `installed` is false. */
  slug?: string;
  skillId?: string;
  source?: string;
}

/**
 * Returns full detail for one skill, whether installed or not.
 * `identifier` is either an installed skill's name, or a marketplace slug in
 * "owner/repo/skill-id" form (as returned by `searchMarketplaceSkills`).
 */
export async function getSkillDetail(
  identifier: string,
  skillSources: SkillSource[] = [],
): Promise<SkillDetailResult> {
  const installed = await listInstalledSkills(skillSources);
  const match = installed.find((s) => s.name === identifier || path.basename(s.skillPath) === identifier);
  if (match) {
    return {
      name: match.name,
      description: match.description,
      installed: true,
      content: match.content,
      skillPath: match.skillPath,
      realPath: match.realPath,
      isSymlink: match.isSymlink,
      sourceName: match.sourceName,
    };
  }

  const parts = identifier.split('/');
  if (parts.length < 2) {
    throw new Error(
      `No installed skill named "${identifier}", and it does not look like a marketplace slug (expected "owner/repo/skill-id")`,
    );
  }
  const skillId = parts[parts.length - 1];
  const source = parts.slice(0, -1).join('/');
  const description = await getMarketplaceSkillDescription(identifier, source);

  return {
    name: skillId,
    description: description ?? '',
    installed: false,
    slug: identifier,
    skillId,
    source,
  };
}

// ── Sources ────────────────────────────────────────────────────────────────

export interface SkillSourceListItem {
  id: string;
  name: string;
  type: 'registry' | 'github' | 'local';
  repoUrl?: string;
  behindCount?: number;
  lastFetched?: number;
}

/** Lists all configured skill sources, plus the built-in skills.sh registry as a pseudo-source with id "registry". */
export function listSkillSources(skillSources: SkillSource[] = []): SkillSourceListItem[] {
  return [
    { id: 'registry', name: 'skills.sh', type: 'registry' },
    ...skillSources.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      repoUrl: s.repoUrl,
      behindCount: s.behindCount,
      lastFetched: s.lastFetched,
    })),
  ];
}

// ── Update checks / pulls (GitHub sources) ────────────────────────────────────

export interface SourceUpdateCheckResult {
  id: string;
  name: string;
  behindCount?: number;
  lastFetched?: number;
  error?: string;
}

/** Runs `git fetch` + counts commits behind origin/HEAD for one GitHub-type source. Returns `error` instead of throwing on failure. */
export async function checkSourceForUpdates(source: SkillSource): Promise<SourceUpdateCheckResult> {
  if (!source.clonePath) {
    return { id: source.id, name: source.name, error: 'No clone path configured for this source' };
  }
  try {
    // Note: `git fetch` has no `--timeout` flag (that was a pre-existing bug —
    // this call always failed with "unknown option" on real git). The
    // `timeout: 20_000` execSync option below already enforces a wall-clock
    // timeout by killing the process, so no git-side flag is needed.
    execSync(`git -C "${source.clonePath}" fetch --quiet`, {
      stdio: 'pipe',
      timeout: 20_000,
    });
    const countOutput = execSync(
      `git -C "${source.clonePath}" rev-list HEAD..origin/HEAD --count`,
      { stdio: 'pipe', timeout: 5_000 },
    );
    const count = parseInt(countOutput.toString().trim(), 10);
    return {
      id: source.id,
      name: source.name,
      behindCount: isNaN(count) ? 0 : count,
      lastFetched: Date.now(),
    };
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string } | undefined)?.stderr;
    const message = stderr && String(stderr).trim() ? String(stderr).trim() : (err instanceof Error ? err.message : String(err));
    return { id: source.id, name: source.name, error: message };
  }
}

/** Runs `checkSourceForUpdates` across every configured GitHub-type source with a clone path, in parallel. */
export async function checkAllSourcesForUpdates(skillSources: SkillSource[] = []): Promise<SourceUpdateCheckResult[]> {
  const githubSources = skillSources.filter((s) => s.type === 'github' && s.clonePath);
  return Promise.all(githubSources.map((source) => checkSourceForUpdates(source)));
}

/** Pulls the latest commits for a GitHub-type source's local clone. Throws on failure (bad path, git error, etc). */
export async function pullGithubSourceUpdates(source: SkillSource): Promise<{ behindCount: number; lastFetched: number }> {
  if (!source.clonePath) {
    throw new Error(`Source "${source.name}" has no clone path configured`);
  }
  execSync(`git -C "${source.clonePath}" pull`, { stdio: 'pipe', timeout: 60_000 });
  return { behindCount: 0, lastFetched: Date.now() };
}

/** Scans a GitHub source's configured skills directory for the skills it provides (used by the Installed-tab source tree). */
export interface SourceSkillInfo {
  id: string;
  name: string;
  description: string;
  skillDir: string;
}

export async function listGithubSourceSkills(source: SkillSource): Promise<SourceSkillInfo[]> {
  if (!source.clonePath) return [];
  const skillsDir = getSkillsDirForSource(source.clonePath);
  const skills: SourceSkillInfo[] = [];

  try {
    const entries = await fsp.readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillDir = path.join(skillsDir, entry.name);
      const skillMdPath = path.join(skillDir, 'SKILL.md');
      try {
        await fsp.access(skillMdPath);
      } catch {
        continue;
      }
      let content = '';
      try {
        content = await fsp.readFile(skillMdPath, 'utf-8');
      } catch { /* empty */ }
      const { name, description } = parseFrontmatter(content);
      skills.push({ id: entry.name, name: name || entry.name, description, skillDir });
    }
  } catch { /* ignore */ }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Install from marketplace ──────────────────────────────────────────────────

export interface InstallSkillParams {
  slug: string;
  skillId: string;
  name: string;
  source: string;
}

/**
 * Installs a skill from the marketplace by shallow-cloning its GitHub source
 * repo to a tmpdir, locating the skill's directory within it, and copying it
 * into `~/.claude/skills/<skillId>`.
 *
 * `onProgress`, if given, is called with human-readable progress messages
 * ("Cloning…", "Locating skill files…", "Copying files…") for UI callers —
 * purely informational, has no effect on the install itself.
 */
export async function installSkillFromMarketplace(
  params: InstallSkillParams,
  onProgress?: (message: string) => void,
): Promise<{ name: string; targetDir: string }> {
  if (!params.source) {
    throw new Error('No GitHub source available for this skill');
  }

  const tmpDir = path.join(os.tmpdir(), `ct-skill-${Date.now()}`);
  const skillsDir = path.join(os.homedir(), '.claude', 'skills');
  const targetDir = path.join(skillsDir, params.skillId);

  try {
    await fsp.mkdir(skillsDir, { recursive: true });

    if (fs.existsSync(targetDir)) {
      throw new Error(`A skill named "${params.skillId}" is already installed`);
    }

    onProgress?.(`Cloning ${params.source}…`);
    execSync(
      `git clone --depth 1 "https://github.com/${params.source}.git" "${tmpDir}"`,
      { stdio: 'pipe', timeout: 60_000 },
    );

    onProgress?.('Locating skill files…');
    const skillSrcDir = await findSkillDir(tmpDir, params.skillId, params.name, fs, path);
    if (!skillSrcDir) {
      throw new Error(`Skill "${params.skillId}" not found in ${params.source}`);
    }

    onProgress?.('Copying files…');
    await copySkillFiles(skillSrcDir, targetDir);

    // Remove .git and other dev-only artifacts from root-level installs
    const dotGit = path.join(targetDir, '.git');
    if (fs.existsSync(dotGit)) {
      await fsp.rm(dotGit, { recursive: true, force: true });
    }

    return { name: params.name, targetDir };
  } finally {
    // Clean up temp dir (best-effort)
    try {
      if (fs.existsSync(tmpDir)) {
        await fsp.rm(tmpDir, { recursive: true, force: true });
      }
    } catch { /* ignore */ }
  }
}

// ── Skill Install Helpers ────────────────────────────────────────────────────

/**
 * Copy a skill's source directory to the target install path.
 *
 * `dereference: true` is critical: some skill repos (e.g. nextlevelbuilder/ui-ux-pro-max-skill)
 * contain `data/` and `scripts/` as intra-repo symlinks. Without dereferencing, those symlinks
 * would be copied as-is, pointing into the now-deleted temp clone directory and leaving the
 * installed skill permanently broken.
 */
export async function copySkillFiles(src: string, dest: string): Promise<void> {
  const { cp } = await import('fs/promises');
  await cp(src, dest, { recursive: true, dereference: true });
}

// ── Skill Discovery ──────────────────────────────────────────────────────────

/** Find the directory inside a cloned repo that contains the target skill's SKILL.md. */
export async function findSkillDir(
  repoDir: string,
  skillId: string,
  name: string,
  fsModule: typeof import('fs'),
  pathModule: typeof import('path'),
): Promise<string | null> {
  // 1. Repo root is the skill itself
  if (fsModule.existsSync(pathModule.join(repoDir, 'SKILL.md'))) {
    return repoDir;
  }

  // 2. Scan for SKILL.md files up to 4 levels deep.
  //    Skip git/CI/dependency junk only — not all dotfile dirs, since some repos
  //    nest skills under `.claude/skills/<skill-id>/` (e.g. the Claude plugin layout).
  const SKIP = new Set(['.git', '.github', '.gitlab', '.vscode', '.idea', 'node_modules']);
  const candidates: string[] = [];
  const scan = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries: import('fs').Dirent[];
    try {
      entries = fsModule.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (SKIP.has(ent.name)) continue;
      if (!ent.isDirectory()) continue;
      const sub = pathModule.join(dir, ent.name);
      if (fsModule.existsSync(pathModule.join(sub, 'SKILL.md'))) {
        candidates.push(sub);
      } else {
        scan(sub, depth + 1);
      }
    }
  };
  scan(repoDir, 0);

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // 3. Multiple candidates: match by directory basename
  const byDir = candidates.find(
    (d) => pathModule.basename(d) === skillId || pathModule.basename(d) === name,
  );
  if (byDir) return byDir;

  // 4. Match by SKILL.md name frontmatter
  for (const dir of candidates) {
    try {
      const raw = fsModule.readFileSync(pathModule.join(dir, 'SKILL.md'), 'utf-8');
      const { name: skillName } = parseFrontmatter(raw);
      if (skillName === skillId || skillName === name) return dir;
    } catch { /* skip */ }
  }

  // 5. Fallback: first found
  return candidates[0] ?? null;
}

// ── Skill Import (folder / .skill archive) Helpers ────────────────────────────

/**
 * Slugify a skill's display name into an install-directory-safe id: lowercase,
 * runs of non-alphanumeric characters collapsed to a single hyphen, and
 * leading/trailing hyphens trimmed.
 *
 * Used for manually-imported skills (folder or .skill/.zip file), which have no
 * canonical registry `skillId` the way skills.sh browse results do.
 */
export function deriveSkillId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Extract a zip archive to `destDir` using the pure-JS `adm-zip` library (no
 * shelling out to `unzip`/`tar`/`ditto`).
 *
 * Even though adm-zip sanitizes entry paths internally before writing, this
 * wrapper adds an explicit zip-slip guard as defense-in-depth for user-supplied
 * archives: every entry's resolved absolute path is checked to stay under
 * `destDir` *before* any extraction happens. If any entry would escape, the
 * whole extraction is aborted (nothing is written).
 */
export async function extractZipToDir(zipPath: string, destDir: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const AdmZip = require('adm-zip') as typeof import('adm-zip');

  const zip = new AdmZip(zipPath);
  const resolvedDest = path.resolve(destDir);

  for (const entry of zip.getEntries()) {
    const resolvedEntry = path.resolve(resolvedDest, entry.entryName);
    if (resolvedEntry !== resolvedDest && !resolvedEntry.startsWith(resolvedDest + path.sep)) {
      throw new Error(`Zip entry "${entry.entryName}" would extract outside the destination directory`);
    }
  }

  await zip.extractAllToAsync(destDir, true, false);
}

/**
 * Shared core of both manual-import flows (folder picker and .skill/.zip file
 * picker). `sourceDir` is a directory already on disk (either the user-picked
 * folder, or a tmpdir a zip was already extracted into) that is expected to
 * contain a SKILL.md somewhere inside it.
 */
export async function importSkillFromPath(
  sourceDir: string,
  skillsDir: string,
  fsModule: typeof import('fs'),
  pathModule: typeof import('path'),
  fallbackName?: string,
): Promise<{ id: string; name: string; targetDir: string }> {
  const locatedDir = await findSkillDir(sourceDir, '', '', fsModule, pathModule);
  if (!locatedDir) {
    throw new Error('No SKILL.md found in the selected folder/file');
  }

  let name = fallbackName ?? pathModule.basename(locatedDir);
  try {
    const raw = fsModule.readFileSync(pathModule.join(locatedDir, 'SKILL.md'), 'utf-8');
    const { name: frontmatterName } = parseFrontmatter(raw);
    if (frontmatterName) name = frontmatterName;
  } catch { /* fall back to fallbackName / dir basename */ }

  const id = deriveSkillId(name);
  const targetDir = pathModule.join(skillsDir, id);

  if (fsModule.existsSync(targetDir)) {
    throw new Error(`A skill named "${id}" is already installed`);
  }

  await fsModule.promises.mkdir(skillsDir, { recursive: true });
  await copySkillFiles(locatedDir, targetDir);

  return { id, name, targetDir };
}
