import { describe, it, expect } from 'vitest';
import { getActivityKind, groupToolCalls, liveToolGroupKey, mergeAdjacentToolOnlyMessages, type ActivityKind } from '../../src/toolNameUtils';
import type { ChatMessage, ToolCallRecord } from '../../src/types';

function tool(name: string, extra: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return { name, summary: '', timestamp: 1000, ...extra };
}

function toolOnlyMsg(id: string, toolName: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    timestamp: 1000,
    toolCalls: [tool(toolName, { toolUseId: id })],
    ...extra,
  };
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

// ─── mergeAdjacentToolOnlyMessages ─────────────────────────────────────────
// Regression coverage for the tool-call-fragmentation bug: a commit fixing
// silent data loss in ThreadSession.pumpMessages now persists every tool-only
// SDK assistant message as its own ChatMessage, so a Read → Edit → Bash chain
// produces one separate persisted message per step. This helper re-merges
// adjacent tool-only rows back into one for rendering, without ever touching
// thread.messages itself.

describe('mergeAdjacentToolOnlyMessages', () => {
  it('returns [] for an empty array', () => {
    expect(mergeAdjacentToolOnlyMessages([])).toEqual([]);
  });

  it('returns a single tool-only assistant message as-is (reference equality)', () => {
    const msg = toolOnlyMsg('m1', 'Read');
    const result = mergeAdjacentToolOnlyMessages([msg]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(msg);
  });

  it('merges two consecutive tool-only assistant messages into one row with concatenated toolCalls', () => {
    const m1 = toolOnlyMsg('m1', 'Read');
    const m2 = toolOnlyMsg('m2', 'Edit');
    const result = mergeAdjacentToolOnlyMessages([m1, m2]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('m1');
    expect(result[0].timestamp).toBe(m1.timestamp);
    expect(result[0].role).toBe('assistant');
    expect(result[0].content).toBe('');
    expect(result[0].toolCalls).toEqual([...m1.toolCalls!, ...m2.toolCalls!]);
  });

  it('concatenates toolResultImages in order, skipping messages with none, across 3+ merged messages', () => {
    const m1 = toolOnlyMsg('m1', 'Read');
    const m2 = toolOnlyMsg('m2', 'Read', {
      toolResultImages: [{ mediaType: 'image/png', data: 'aaa' }],
    });
    const m3 = toolOnlyMsg('m3', 'Bash');
    const result = mergeAdjacentToolOnlyMessages([m1, m2, m3]);
    expect(result).toHaveLength(1);
    expect(result[0].toolResultImages).toEqual(m2.toolResultImages);
    expect(result[0].toolCalls).toEqual([
      ...m1.toolCalls!,
      ...m2.toolCalls!,
      ...m3.toolCalls!,
    ]);
  });

  it('takes the last non-undefined cost value found in the run', () => {
    const m1 = toolOnlyMsg('m1', 'Read');
    const m2 = toolOnlyMsg('m2', 'Edit');
    const m3 = toolOnlyMsg('m3', 'Bash', { cost: 0.0042 });
    const result = mergeAdjacentToolOnlyMessages([m1, m2, m3]);
    expect(result).toHaveLength(1);
    expect(result[0].cost).toBe(0.0042);
  });

  it('breaks a run at a narrated message that itself carries tool calls', () => {
    const m1 = toolOnlyMsg('m1', 'Read');
    const m2 = toolOnlyMsg('m2', 'Edit');
    const m3 = toolOnlyMsg('m3', 'Bash', { content: 'Here is what I found.' });
    const m4 = toolOnlyMsg('m4', 'Grep');
    const result = mergeAdjacentToolOnlyMessages([m1, m2, m3, m4]);
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('m1');
    expect(result[0].toolCalls).toEqual([...m1.toolCalls!, ...m2.toolCalls!]);
    expect(result[1]).toBe(m3);
    expect(result[2]).toBe(m4);
  });

  it('breaks a run at a user message', () => {
    const m1 = toolOnlyMsg('m1', 'Read');
    const m2 = toolOnlyMsg('m2', 'Edit');
    const userMsg: ChatMessage = { id: 'u1', role: 'user', content: 'go on', timestamp: 1000 };
    const m3 = toolOnlyMsg('m3', 'Bash');
    const m4 = toolOnlyMsg('m4', 'Grep');
    const result = mergeAdjacentToolOnlyMessages([m1, m2, userMsg, m3, m4]);
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('m1');
    expect(result[1]).toBe(userMsg);
    expect(result[2].id).toBe('m3');
  });

  it('breaks a run at a role: compact divider the same way', () => {
    const m1 = toolOnlyMsg('m1', 'Read');
    const m2 = toolOnlyMsg('m2', 'Edit');
    const compactMsg: ChatMessage = { id: 'c1', role: 'compact', content: '', timestamp: 1000 };
    const m3 = toolOnlyMsg('m3', 'Bash');
    const m4 = toolOnlyMsg('m4', 'Grep');
    const result = mergeAdjacentToolOnlyMessages([m1, m2, compactMsg, m3, m4]);
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('m1');
    expect(result[1]).toBe(compactMsg);
    expect(result[2].id).toBe('m3');
  });

  it('passes through all messages unmerged when kinds fully alternate with no adjacency', () => {
    const m1 = toolOnlyMsg('m1', 'Read');
    const m2: ChatMessage = { id: 'm2', role: 'assistant', content: 'narration', timestamp: 1000 };
    const m3 = toolOnlyMsg('m3', 'Bash');
    const m4: ChatMessage = { id: 'm4', role: 'assistant', content: 'more narration', timestamp: 1000 };
    const result = mergeAdjacentToolOnlyMessages([m1, m2, m3, m4]);
    expect(result).toHaveLength(4);
    expect(result[0]).toBe(m1);
    expect(result[1]).toBe(m2);
    expect(result[2]).toBe(m3);
    expect(result[3]).toBe(m4);
  });
});
