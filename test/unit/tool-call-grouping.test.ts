import { describe, it, expect } from 'vitest';
import { getActivityKind, groupToolCalls, liveToolGroupKey, type ActivityKind } from '../../src/toolNameUtils';
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

  // A tool call the live view hasn't gotten a result for yet still has
  // status: 'pending' (stamped by ClaudeSession the instant tool_use fires).
  // groupToolCalls only buckets on activity kind, not status, so a pending
  // call in the middle of an otherwise-resolved run must still merge into the
  // same group — this is what lets a live run keep collapsing as new pending
  // calls are appended mid-turn, not just after they all resolve.
  it('treats a "pending" call as groupable alongside "success"/"error" calls of the same kind', () => {
    const tools = [
      tool('Read', { toolUseId: 't1', status: 'success' }),
      tool('Read', { toolUseId: 't2', status: 'success' }),
      tool('Bash', { toolUseId: 't3', status: 'pending' }),
    ];
    const result = groupToolCalls(tools);
    expect(result).toEqual([{ kind: 'group', activityKind: 'exploring', tools }]);
  });

  it('groups two still-pending calls of the same kind together', () => {
    const tools = [
      tool('Edit', { toolUseId: 't1', status: 'pending' }),
      tool('Edit', { toolUseId: 't2', status: 'pending' }),
    ];
    const result = groupToolCalls(tools);
    expect(result).toEqual([{ kind: 'group', activityKind: 'editing', tools }]);
  });
});

// ─── liveToolGroupKey ──────────────────────────────────────────────────────
// Stable identity for a LIVE group's expand/collapse state across rebuilds —
// see the function's doc comment in toolNameUtils.ts for the full rationale.
// The key must stay the same as a run is extended at the tail (so a group
// the user expands mid-turn doesn't snap back closed on the next event), and
// must change once a genuinely different run starts (a kind-interrupting
// call, or — after that call — a new run of the original kind resuming).

describe('liveToolGroupKey', () => {
  it('is derived from the FIRST call in the run, not the last', () => {
    const tools = [
      tool('Read', { toolUseId: 't1', status: 'success' }),
      tool('Read', { toolUseId: 't2', status: 'pending' }),
    ];
    expect(liveToolGroupKey(tools)).toBe('t1:exploring');
  });

  it('stays the same key when more same-kind calls are appended to the run', () => {
    const before = [
      tool('Read', { toolUseId: 't1', status: 'success' }),
      tool('Read', { toolUseId: 't2', status: 'pending' }),
    ];
    const after = [
      ...before,
      tool('Bash', { toolUseId: 't3', status: 'pending' }),
      tool('Grep', { toolUseId: 't4', status: 'pending' }),
    ];
    expect(liveToolGroupKey(after)).toBe(liveToolGroupKey(before));
  });

  it('produces a different key for a run that starts with a different first call (kind-interrupting call started a new run)', () => {
    // Simulates: Read,Read (group A, key = t1:exploring) then Edit (single,
    // breaks the run) then Edit,Edit (group B — a NEW exploring-adjacent run
    // of a different kind, first call t3). Group B's key must not collide
    // with group A's.
    const groupA = [
      tool('Read', { toolUseId: 't1' }),
      tool('Read', { toolUseId: 't2' }),
    ];
    const groupB = [
      tool('Edit', { toolUseId: 't3' }),
      tool('Edit', { toolUseId: 't4' }),
    ];
    expect(liveToolGroupKey(groupA)).not.toBe(liveToolGroupKey(groupB));
    expect(liveToolGroupKey(groupA)).toBe('t1:exploring');
    expect(liveToolGroupKey(groupB)).toBe('t3:editing');
  });

  it('falls back to timestamp when the first call has no toolUseId', () => {
    const tools = [tool('Read', { toolUseId: undefined, timestamp: 5000 })];
    expect(liveToolGroupKey(tools)).toBe('5000:exploring');
  });
});
