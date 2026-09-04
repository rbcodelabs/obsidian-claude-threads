import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const skill = fs.readFileSync(
  path.resolve(process.cwd(), 'resources/skills/thread-orchestrator/SKILL.md'),
  'utf8',
);
const normalizedSkill = skill.replace(/\s+/g, ' ');

describe('thread-orchestrator skill contract', () => {
  it('requires goal intake before proposals for an untracked thread', () => {
    expect(skill).toContain('Unreviewed → Extracting goal → Awaiting goal clarification → Goal confirmed → Active orchestration → Concluded');
    expect(skill).toMatch(/no `managerNotes`[\s\S]*goal intake/i);
    expect(skill).toMatch(/Do not (?:stage|create)[\s\S]*execution[\s\S]*inspection[\s\S]*verification[\s\S]*until[\s\S]*goal/i);
    expect(skill).toMatch(/Do not repeat[\s\S]*unanswered[\s\S]*question/i);
  });

  it('defines the complete v2 notes contract with updatedAt as its cursor', () => {
    for (const field of [
      'Orchestrator state: v2',
      'Project outcome:',
      'Goal status:',
      'Thread outcome:',
      'Done when:',
      'Constraints:',
      'Last reviewed update:',
      'Last substantive change:',
      'Last intervention:',
      'Decision unlocked:',
      'Disposition:',
      'Status:',
    ]) {
      expect(skill).toContain(field);
    }
    expect(skill).toContain('Last reviewed update: <thread.updatedAt copied exactly>');
    expect(skill).toContain('user-stated | user-confirmed | inferred | awaiting-user');
    expect(skill).toContain('intake | advance | needs-decision | concluded | no-action');
  });

  it('gates interventions and bounds repeated verification', () => {
    for (const requirement of [
      'Outcome link',
      'Substantive new evidence',
      'Decision or progress enabled',
      'Action class',
      'Stopping condition',
    ]) {
      expect(skill).toContain(requirement);
    }
    expect(normalizedSkill).toMatch(/one additional orchestrator-requested verification pass/i);
    expect(skill).toMatch(/Passing[\s\S]*required checks[\s\S]*presumptively terminal/i);
  });

  it('keeps targeted events, reconciliation heartbeats, and direct requests distinct', () => {
    expect(skill).toMatch(/Event ping[\s\S]*only[\s\S]*named/i);
    expect(normalizedSkill).toMatch(/Event ping.*updatedAt.*manager notes cursor/i);
    expect(skill).toMatch(/Heartbeat[\s\S]*reconcil/i);
    expect(skill).toMatch(/Direct message[\s\S]*without[\s\S]*unrelated/i);
    expect(normalizedSkill).toMatch(/updatedAt.*unchanged.*no reads, writes, questions, or proposals/i);
  });
});
