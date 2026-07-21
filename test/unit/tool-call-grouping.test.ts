import { describe, it, expect } from 'vitest';
import { getActivityKind, groupToolCalls, type ActivityKind } from '../../src/toolNameUtils';
import type { ToolCallRecord } from '../../src/types';

function tool(name: string, extra: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return { name, summary: '', timestamp: 1000, ...extra };
}

// ─── getActivityKind ───────────────────────────────────────────────────────

describe('getActivityKind', () => {
  const cases: Array<[string, ActivityKind]> = [
    ['Bash', 'exploring'],
    ['Read', 'exploring'],
    ['Grep', 'exploring'],
    ['Glob', 'exploring'],
    ['Edit', 'editing'],
    ['Write', 'editing'],
    ['NotebookEdit', 'editing'],
    ['TaskCreate', 'planning'],
    ['TaskUpdate', 'planning'],
    ['ExitPlanMode', 'planning'],
    ['EnterPlanMode', 'planning'],
    ['WebFetch', 'researching'],
    ['WebSearch', 'researching'],
    ['ToolSearch', 'searching'],
    ['Agent', 'searching'],
    ['Skill', 'working'],
    ['TodoWrite', 'working'],
  ];

  it.each(cases)('classifies %s as %s', (name, expected) => {
    expect(getActivityKind(name)).toBe(expected);
  });

  it('classifies an MCP-prefixed tool name using the underlying bare name', () => {
    expect(getActivityKind('mcp__obsidian__Bash')).toBe('exploring');
  });

  it('falls back to "working" for an unknown tool name', () => {
    expect(getActivityKind('SomeRandomFutureTool')).toBe('working');
  });
});

// ─── groupToolCalls ────────────────────────────────────────────────────────

describe('groupToolCalls', () => {
  it('returns [] for an empty array', () => {
    expect(groupToolCalls([])).toEqual([]);
  });

  it('keeps a single isolated call as a "single" entry (no same-kind neighbor)', () => {
    const tools = [tool('Bash')];
    const result = groupToolCalls(tools);
    expect(result).toEqual([{ kind: 'single', tool: tools[0] }]);
  });

  it('groups a run of 2+ same-kind calls into one "group" entry with the correct count', () => {
    const tools = [tool('Read'), tool('Read')];
    const result = groupToolCalls(tools);
    expect(result).toEqual([{ kind: 'group', activityKind: 'exploring', tools }]);
  });

  // NOTE: Bash and Read are BOTH classified as 'exploring' (see getActivityKind
  // above), so Read,Read,Bash would merge into a single 3-item exploring group,
  // not split around Bash. WebFetch ('researching') is used here in place of
  // Bash to actually exercise a group/single/group split across three buckets.
  it('handles a mixed run: Read,Read,WebFetch,Edit,Edit -> [group(exploring,2), single(WebFetch), group(editing,2)]', () => {
    const tools = [tool('Read'), tool('Read'), tool('WebFetch'), tool('Edit'), tool('Edit')];
    const result = groupToolCalls(tools);
    expect(result).toEqual([
      { kind: 'group', activityKind: 'exploring', tools: [tools[0], tools[1]] },
      { kind: 'single', tool: tools[2] },
      { kind: 'group', activityKind: 'editing', tools: [tools[3], tools[4]] },
    ]);
  });

  it('merges a run spanning multiple tool names within the same activity kind (Read,Read,Bash all exploring)', () => {
    const tools = [tool('Read'), tool('Read'), tool('Bash')];
    const result = groupToolCalls(tools);
    expect(result).toEqual([{ kind: 'group', activityKind: 'exploring', tools }]);
  });

  it('leaves every call as "single" when kinds fully alternate', () => {
    const tools = [tool('Bash'), tool('Edit'), tool('Bash'), tool('Edit')];
    const result = groupToolCalls(tools);
    expect(result).toEqual([
      { kind: 'single', tool: tools[0] },
      { kind: 'single', tool: tools[1] },
      { kind: 'single', tool: tools[2] },
      { kind: 'single', tool: tools[3] },
    ]);
  });

  it('groups a longer run of 3+ same-kind calls into one group', () => {
    const tools = [tool('Read'), tool('Read'), tool('Read')];
    const result = groupToolCalls(tools);
    expect(result).toEqual([{ kind: 'group', activityKind: 'exploring', tools }]);
  });
});
