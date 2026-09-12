import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
vi.mock('obsidian', () => ({ requestUrl: vi.fn() }));
import { listInstalledSkills, getSkillDetail, uninstallSkillByName, buildSkillPlugins, codexSkillRoots } from '../../src/skillManager';
import { computeSkillRoots } from '../../src/skillPaths';

const dirs: string[] = [];
function fixture() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'local-integration-'));
  dirs.push(vault);
  const roots = { ...computeSkillRoots(vault, '.obsidian/plugins/test', vault), localRoot: path.join(vault, 'Skills') };
  for (const root of [roots.pluginRoot, roots.localRoot]) {
    fs.mkdirSync(path.join(root, 'example'), { recursive: true });
    fs.writeFileSync(path.join(root, 'example', 'SKILL.md'), '---\nname: example\ndescription: An example\n---\nInstructions');
  }
  return { roots, vault };
}
afterEach(() => dirs.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true })));
describe('authored skills alongside installed packages', () => {
  it('lists both copies with distinct origins and qualified identifiers', async () => {
    const { roots } = fixture();
    const skills = await listInstalledSkills([], roots);
    expect(skills).toEqual(expect.arrayContaining([expect.objectContaining({ origin: 'local', identifier: 'local:example', isEditable: true, isRemovable: true })]));
    expect((await getSkillDetail('local:example', [], roots)).skillPath).toBe(path.join(roots.localRoot, 'example'));
  });
  it('refuses ambiguous removal and permits explicit authored removal', async () => {
    const { roots } = fixture();
    await expect(uninstallSkillByName('example', [], roots)).rejects.toThrow(/ambiguous/i);
    await uninstallSkillByName('local:example', [], roots);
    expect(fs.existsSync(path.join(roots.pluginRoot, 'example'))).toBe(true);
    expect(fs.existsSync(path.join(roots.localRoot, 'example'))).toBe(false);
  });
  it('registers authored skills separately while preserving installed namespace', () => {
    const { roots } = fixture();
    const plugins = buildSkillPlugins({ pluginSkillsRoot: roots.pluginRoot, localSkillsRoot: roots.localRoot });
    expect(plugins).toHaveLength(2);
    const manifests = plugins.map(p => JSON.parse(fs.readFileSync(path.join(p.path, '.claude-plugin/plugin.json'), 'utf8')));
    expect(manifests.map(m => m.name)).toEqual(['vault', 'local']);
    expect(codexSkillRoots([], undefined, roots.pluginRoot, roots.localRoot)).toContain(roots.localRoot);
  });
  it('does not overwrite a user manifest or follow a manifest-directory symlink', () => {
    const { roots, vault } = fixture();
    const manifestDir = path.join(roots.localRoot, '.claude-plugin');
    fs.mkdirSync(manifestDir);
    fs.writeFileSync(path.join(manifestDir, 'plugin.json'), '{"name":"custom"}');
    expect(() => buildSkillPlugins({ localSkillsRoot: roots.localRoot })).toThrow(/manifest/i);
    expect(fs.readFileSync(path.join(manifestDir, 'plugin.json'), 'utf8')).toBe('{"name":"custom"}');
    fs.rmSync(manifestDir, { recursive: true });
    const outside = path.join(vault, 'outside'); fs.mkdirSync(outside);
    fs.symlinkSync(outside, manifestDir);
    expect(() => buildSkillPlugins({ localSkillsRoot: roots.localRoot })).toThrow(/symlink/i);
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
