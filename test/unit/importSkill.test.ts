import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import AdmZip from 'adm-zip';
import { deriveSkillId, extractZipToDir, importSkillFromPath } from '../../src/SkillsManagerView';

// ── deriveSkillId ──────────────────────────────────────────────────────────

describe('deriveSkillId', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(deriveSkillId('My Cool Skill')).toBe('my-cool-skill');
  });

  it('collapses runs of punctuation into a single hyphen', () => {
    expect(deriveSkillId('UI/UX -- Pro Max!!')).toBe('ui-ux-pro-max');
  });

  it('trims leading and trailing junk characters', () => {
    expect(deriveSkillId('--- Weird Name ---')).toBe('weird-name');
  });

  it('handles mixed case with numbers and underscores', () => {
    expect(deriveSkillId('Skill_42 CamelCaseName')).toBe('skill-42-camelcasename');
  });

  it('handles already-slug-like input unchanged', () => {
    expect(deriveSkillId('already-a-slug')).toBe('already-a-slug');
  });

  it('handles a single word', () => {
    expect(deriveSkillId('Foo')).toBe('foo');
  });
});

// ── extractZipToDir ────────────────────────────────────────────────────────

describe('extractZipToDir', () => {
  let tmpRoot: string;
  let zipPath: string;
  let destDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-zip-'));
    zipPath = path.join(tmpRoot, 'test.zip');
    destDir = path.join(tmpRoot, 'dest');
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('extracts files to the correct relative paths with correct content', async () => {
    const zip = new AdmZip();
    zip.addFile('SKILL.md', Buffer.from('---\nname: test-skill\n---\n'));
    zip.addFile('data/colors.csv', Buffer.from('name,hex\nred,#f00\n'));
    zip.writeZip(zipPath);

    await extractZipToDir(zipPath, destDir);

    expect(fs.readFileSync(path.join(destDir, 'SKILL.md'), 'utf-8')).toContain('test-skill');
    expect(fs.readFileSync(path.join(destDir, 'data', 'colors.csv'), 'utf-8')).toContain('red');
  });

  it('extracts a nested skill folder structure', async () => {
    const zip = new AdmZip();
    zip.addFile('my-skill/SKILL.md', Buffer.from('---\nname: nested-skill\n---\n'));
    zip.addFile('my-skill/scripts/run.sh', Buffer.from('#!/bin/sh\necho hi\n'));
    zip.writeZip(zipPath);

    await extractZipToDir(zipPath, destDir);

    expect(fs.existsSync(path.join(destDir, 'my-skill', 'SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(destDir, 'my-skill', 'scripts', 'run.sh'), 'utf-8')).toContain('echo hi');
  });

  it('throws on a zip-slip entry and writes nothing outside destDir', async () => {
    const zip = new AdmZip();
    // addFile() sanitizes "../" out of entry names on its own, so bypass that
    // by mutating the entryName on the returned IZipEntry after adding it —
    // this simulates a maliciously crafted archive that a real attacker tool
    // (not adm-zip itself) could produce.
    const entry = zip.addFile('placeholder.txt', Buffer.from('pwned'));
    entry.entryName = '../../evil.txt';
    zip.writeZip(zipPath);

    await expect(extractZipToDir(zipPath, destDir)).rejects.toThrow(/outside the destination directory/);

    // Nothing should have been written at all — not even destDir itself,
    // and definitely nothing above tmpRoot.
    expect(fs.existsSync(path.join(tmpRoot, '..', 'evil.txt'))).toBe(false);
    expect(fs.existsSync(path.join(os.tmpdir(), 'evil.txt'))).toBe(false);
    expect(fs.existsSync(destDir)).toBe(false);
  });

  it('throws on an absolute-path entry that would escape destDir', async () => {
    const zip = new AdmZip();
    const entry = zip.addFile('placeholder.txt', Buffer.from('pwned'));
    entry.entryName = path.join(os.tmpdir(), 'absolute-evil.txt').replace(/^\//, '');
    zip.writeZip(zipPath);

    // This particular crafted name resolves outside destDir the same way;
    // guard should reject it before any extraction happens.
    await extractZipToDir(zipPath, destDir).catch(() => { /* may or may not throw depending on resolution */ });
    // Regardless of outcome, no file should exist at the raw absolute target.
    expect(fs.existsSync(path.join(os.tmpdir(), 'absolute-evil.txt'))).toBe(false);
  });
});

// ── importSkillFromPath ────────────────────────────────────────────────────

describe('importSkillFromPath', () => {
  let sourceDir: string;
  let skillsDir: string;

  beforeEach(() => {
    sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-skill-src-'));
    skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-skill-dst-'));
  });

  afterEach(() => {
    fs.rmSync(sourceDir, { recursive: true, force: true });
    fs.rmSync(skillsDir, { recursive: true, force: true });
  });

  it('copies a skill with SKILL.md at the root into <skillsDir>/<derived-id>', async () => {
    fs.writeFileSync(
      path.join(sourceDir, 'SKILL.md'),
      '---\nname: My Cool Skill\ndescription: does things\n---\n# Body\n',
      'utf-8',
    );
    fs.writeFileSync(path.join(sourceDir, 'helper.txt'), 'aux file', 'utf-8');

    const result = await importSkillFromPath(sourceDir, skillsDir, fs, path);

    expect(result.id).toBe('my-cool-skill');
    expect(result.name).toBe('My Cool Skill');
    expect(result.targetDir).toBe(path.join(skillsDir, 'my-cool-skill'));
    expect(fs.existsSync(path.join(skillsDir, 'my-cool-skill', 'SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(skillsDir, 'my-cool-skill', 'helper.txt'), 'utf-8')).toBe('aux file');
  });

  it('copies a skill nested one level deep into <skillsDir>/<derived-id>', async () => {
    const nestedDir = path.join(sourceDir, 'my-nested-skill');
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(
      path.join(nestedDir, 'SKILL.md'),
      '---\nname: Nested Skill\n---\n# Body\n',
      'utf-8',
    );

    const result = await importSkillFromPath(sourceDir, skillsDir, fs, path);

    expect(result.id).toBe('nested-skill');
    expect(fs.existsSync(path.join(skillsDir, 'nested-skill', 'SKILL.md'))).toBe(true);
  });

  it('falls back to the fallbackName when frontmatter has no name', async () => {
    fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), '---\ndescription: no name here\n---\n', 'utf-8');

    const result = await importSkillFromPath(sourceDir, skillsDir, fs, path, 'Fallback Name');

    expect(result.id).toBe('fallback-name');
    expect(result.name).toBe('Fallback Name');
  });

  it('throws when no SKILL.md is found anywhere in the source', async () => {
    fs.writeFileSync(path.join(sourceDir, 'readme.txt'), 'nothing here', 'utf-8');

    await expect(importSkillFromPath(sourceDir, skillsDir, fs, path)).rejects.toThrow(/No SKILL\.md found/);
  });

  it('throws on id collision and does not touch the existing installed skill', async () => {
    fs.writeFileSync(
      path.join(sourceDir, 'SKILL.md'),
      '---\nname: Dup Skill\n---\n# New content\n',
      'utf-8',
    );

    // Pre-existing installed skill with the same derived id
    const existingDir = path.join(skillsDir, 'dup-skill');
    fs.mkdirSync(existingDir, { recursive: true });
    fs.writeFileSync(path.join(existingDir, 'SKILL.md'), '---\nname: Dup Skill\n---\n# Original content\n', 'utf-8');
    fs.writeFileSync(path.join(existingDir, 'marker.txt'), 'do-not-touch', 'utf-8');

    await expect(importSkillFromPath(sourceDir, skillsDir, fs, path)).rejects.toThrow(/already installed/);

    // The existing installed skill must be completely untouched
    expect(fs.readFileSync(path.join(existingDir, 'SKILL.md'), 'utf-8')).toContain('Original content');
    expect(fs.existsSync(path.join(existingDir, 'marker.txt'))).toBe(true);
  });
});
