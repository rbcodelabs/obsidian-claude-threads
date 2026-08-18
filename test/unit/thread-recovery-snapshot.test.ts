import { describe, expect, it } from 'vitest';
import type { Thread } from '../../src/types';
import {
  decodeThreadRecoverySnapshot,
  encodeThreadRecoverySnapshot,
} from '../../src/threadRecoverySnapshot';

function canonicalThread(): Thread {
  return {
    id: 'codex-thread',
    sessionId: 'codex-session-42',
    agentHarness: 'codex',
    title: 'Canonical thread',
    cwd: '/repo',
    status: 'waiting',
    createdAt: 1,
    updatedAt: 2,
    managerNotes: 'private orchestrator state',
    messages: [
      {
        id: 'user-1',
        role: 'user',
        content: 'Original user message',
        timestamp: 10,
        images: [{ name: 'diagram.png', mediaType: 'image/png', path: 'attachments/diagram.png' }],
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Canonical assistant response',
        timestamp: 11,
        cost: 0.25,
        summary: 'A response',
        toolCalls: [{ name: 'Read', summary: 'Read: src/main.ts', status: 'success', durationMs: 12 }],
      },
    ],
  };
}

describe('versioned thread recovery snapshots', () => {
  it('round-trips Codex identity and the complete canonical thread projection', () => {
    const thread = canonicalThread();

    expect(decodeThreadRecoverySnapshot(encodeThreadRecoverySnapshot(thread))).toEqual(thread);
  });

  it('rejects an unsupported snapshot version instead of guessing at its shape', () => {
    const encoded = JSON.stringify({ version: 999, thread: canonicalThread() });

    expect(decodeThreadRecoverySnapshot(encoded)).toBeNull();
  });

  it('rejects malformed and structurally invalid snapshots', () => {
    const invalid = JSON.stringify({ version: 1, thread: { id: 'missing-everything-else' } });

    expect(decodeThreadRecoverySnapshot('not-json!')).toBeNull();
    expect(decodeThreadRecoverySnapshot(invalid)).toBeNull();
  });
});
