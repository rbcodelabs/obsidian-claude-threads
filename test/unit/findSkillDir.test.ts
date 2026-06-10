import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { findSkillDir } from '../../src/SkillsManagerView';

/**
 * Regression suite for the Skills Manager install path resolver. The original
 * implementation skipped every directory whose name started with a dot, so
 * skills nested under `.claude/skills/<id>/SKILL.md` (the Claude plugin
 * marketplace layout) could not be found.
 */
describe('findSkillDir', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'find-skill-dir-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeSkill(relDir: string, frontmatterName = 'sample-skill'): string {
    const abs = path.join(tmpRoot, relDir);
    fs.mkdirSync(abs, { recursive: true });
    fs.writeFileSync(
      path.join(abs, 'SKILL.md'),
      `---\nname: ${frontmatterName}\ndescription: test\n---\n# Sample\n`,
      'utf-8',
    );
    return abs;
  }

  it('returns the repo root when SKILL.md is at the top level', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'SKILL.md'), '---\nname: root\n---\n', 'utf-8');
    const result = await findSkillDir(tmpRoot, 'root', 'root', fs, path);
    expect(result).toBe(tmpRoot);
  });

  it('finds a skill nested under .claude/skills/<id>/ (Claude plugin layout)', async () => {
    // Regression: the old code skipped every entry starting with "." so this
    // layout returned 0 candidates and the installer aborted with "not found".
    const skillDir = makeSkill('.claude/skills/ui-ux-pro-max');
    const result = await findSkillDir(tmpRoot, 'ui-ux-pro-max', 'UI UX Pro Max', fs, path);
    expect(result).toBe(skillDir);
  });

  it('finds a skill nested under skills/<id>/ (flat layout)', async () => {
    const skillDir = makeSkill('skills/foo');
    const result = await findSkillDir(tmpRoot, 'foo', 'Foo', fs, path);
    expect(result).toBe(skillDir);
  });

  it('still skips .git, .github, and node_modules to avoid false positives', async () => {
    // Plant a decoy SKILL.md in each junk dir; the real skill lives elsewhere.
    makeSkill('.git/something', 'decoy-git');
    makeSkill('.github/workflows/sub', 'decoy-gh');
    makeSkill('node_modules/some-pkg', 'decoy-modules');
    const realDir = makeSkill('skills/my-skill', 'my-skill');
    const result = await findSkillDir(tmpRoot, 'my-skill', 'My Skill', fs, path);
    expect(result).toBe(realDir);
  });

  it('picks the candidate whose basename matches skillId when several exist', async () => {
    makeSkill('skills/other-one', 'other-one');
    const wantedDir = makeSkill('skills/wanted', 'wanted');
    makeSkill('skills/third', 'third');
    const result = await findSkillDir(tmpRoot, 'wanted', 'Wanted', fs, path);
    expect(result).toBe(wantedDir);
  });

  it('falls back to frontmatter name match when no basename matches', async () => {
    makeSkill('a/dir-one', 'unrelated');
    makeSkill('b/dir-two', 'target-name');
    const result = await findSkillDir(tmpRoot, 'target-name', 'Target', fs, path);
    expect(result).toBe(path.join(tmpRoot, 'b/dir-two'));
  });

  it('returns null when no SKILL.md exists anywhere in the repo', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'src', 'index.ts'), '// nothing here', 'utf-8');
    const result = await findSkillDir(tmpRoot, 'anything', 'Anything', fs, path);
    expect(result).toBeNull();
  });
});
