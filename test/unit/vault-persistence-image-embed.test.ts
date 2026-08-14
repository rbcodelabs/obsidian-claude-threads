import { describe, it, expect } from 'vitest';
import { VaultPersistence } from '../../src/VaultPersistence';
import type { Thread, ChatMessage } from '../../src/types';

// ---------------------------------------------------------------------------
// Minimal vault mock that captures the content written by saveThread(), so we
// can assert the rendered markdown embeds externalized images. Mirrors the
// saveThread() call sequence: ensureFolder -> getAbstractFileByPath(file) ->
// create(file, content).
// ---------------------------------------------------------------------------
function makeApp() {
  const created: Record<string, string> = {};
  return {
    app: {
      vault: {
        getAbstractFileByPath: () => null,
        createFolder: async () => {},
        create: async (path: string, content: string) => {
          created[path] = content;
        },
        modify: async () => {},
      },
      metadataCache: { getFileCache: () => null },
    },
    created,
  };
}

function makeThread(messages: ChatMessage[]): Thread {
  return {
    id: 't1',
    title: 'Embed Test',
    cwd: '/tmp',
    messages,
    createdAt: Date.parse('2026-01-01T00:00:00.000Z'),
    updatedAt: Date.parse('2026-01-01T00:00:00.000Z'),
    status: 'archived',
  };
}

describe('VaultPersistence note image embeds', () => {
  it('renders ![[path]] embeds for externalized images in the saved note', async () => {
    const { app, created } = makeApp();
    const vp = new VaultPersistence(app as any, 'Claude');

    const thread = makeThread([
      {
        id: 'm1',
        role: 'user',
        content: 'here is a screenshot',
        timestamp: 1,
        images: [{ mediaType: 'image/png', name: 'shot.png', path: 'Claude/attachments/t1/m1-0.png' }],
      },
      {
        id: 'm2',
        role: 'assistant',
        content: 'I read the file',
        timestamp: 2,
        toolResultImages: [{ mediaType: 'image/png', path: 'Claude/attachments/t1/m2-0.png' }],
      },
    ]);

    await vp.saveThread(thread);

    const written = Object.values(created)[0];
    expect(written).toBeDefined();
    expect(written).toContain('![[Claude/attachments/t1/m1-0.png]]');
    expect(written).toContain('![[Claude/attachments/t1/m2-0.png]]');
  });

  it('emits no embed and no base64 for an image that is not yet externalized', async () => {
    const { app, created } = makeApp();
    const vp = new VaultPersistence(app as any, 'Claude');

    const thread = makeThread([
      {
        id: 'm1',
        role: 'user',
        content: 'inline only',
        timestamp: 1,
        images: [{ mediaType: 'image/png', name: 'shot.png', base64: 'QUJDRA==' }],
      },
    ]);

    await vp.saveThread(thread);

    const written = Object.values(created)[0];
    expect(written).toBeDefined();
    expect(written).not.toContain('![[');
    expect(written).not.toContain('QUJDRA=='); // base64 never leaks into the note
  });
});
