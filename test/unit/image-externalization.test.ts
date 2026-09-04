import { describe, it, expect } from 'vitest';
import {
  extForMediaType,
  buildAttachmentPath,
  serializeThreadForSave,
  collectPendingImageExternalizations,
  imageEmbedMarkdown,
} from '../../src/imageExternalization';
import type { Thread, ChatMessage } from '../../src/types';

// ---------------------------------------------------------------------------
// Test helpers: build minimal domain objects. Pure functions under test never
// touch Obsidian, so no mock/runtime is needed.
// ---------------------------------------------------------------------------

function makeThread(overrides: Partial<Thread> & Pick<Thread, 'messages'>): Thread {
  return {
    id: 't1',
    title: 'Test',
    cwd: '/tmp',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function userImageMsg(id: string, images: ChatMessage['images']): ChatMessage {
  return { id, role: 'user', content: 'hi', timestamp: 1, images };
}

function toolImageMsg(id: string, toolResultImages: ChatMessage['toolResultImages']): ChatMessage {
  return { id, role: 'assistant', content: 'ok', timestamp: 1, toolResultImages };
}

// ---------------------------------------------------------------------------
// extForMediaType
// ---------------------------------------------------------------------------

describe('extForMediaType', () => {
  it('maps the known image media types', () => {
    expect(extForMediaType('image/jpeg')).toBe('jpg');
    expect(extForMediaType('image/png')).toBe('png');
    expect(extForMediaType('image/gif')).toBe('gif');
    expect(extForMediaType('image/webp')).toBe('webp');
  });

  it('derives a plain alphanumeric subtype for unknown types', () => {
    expect(extForMediaType('image/bmp')).toBe('bmp');
  });

  it('falls back to bin for a non-alphanumeric subtype', () => {
    expect(extForMediaType('image/svg+xml')).toBe('bin');
  });
});

// ---------------------------------------------------------------------------
// buildAttachmentPath
// ---------------------------------------------------------------------------

describe('buildAttachmentPath', () => {
  it('builds a per-thread, per-message-index path under attachments/', () => {
    expect(buildAttachmentPath('Claude', 'thread-1', 'msg-9', 0, 'image/png')).toBe(
      'Claude/attachments/thread-1/msg-9-0.png',
    );
  });

  it('uses the given vault folder', () => {
    expect(buildAttachmentPath('Work/Acme', 'tid', 'mid', 2, 'image/jpeg')).toBe(
      'Work/Acme/attachments/tid/mid-2.jpg',
    );
  });

  it('defaults to the Agent Threads folder when none is given', () => {
    expect(buildAttachmentPath('', 'tid', 'mid', 1, 'image/gif')).toBe(
      'Agent Threads/attachments/tid/mid-1.gif',
    );
  });
});

// ---------------------------------------------------------------------------
// serializeThreadForSave: the byte-removal step
// ---------------------------------------------------------------------------

describe('serializeThreadForSave', () => {
  it('drops base64 from a path-backed user image in the serialized copy but keeps it live', () => {
    const msg = userImageMsg('m1', [
      { base64: 'AAAA', mediaType: 'image/png', name: 'a.png', path: 'Claude/attachments/t1/m1-0.png' },
    ]);
    const thread = makeThread({ messages: [msg] });

    const out = serializeThreadForSave(thread);

    // Serialized copy has no base64 (bytes removed from data.json) but keeps path.
    expect(out.messages[0].images![0].base64).toBeUndefined();
    expect(out.messages[0].images![0].path).toBe('Claude/attachments/t1/m1-0.png');
    expect(out.messages[0].images![0].name).toBe('a.png');

    // Live in-memory object is untouched.
    expect(thread.messages[0].images![0].base64).toBe('AAAA');
    // And it is a genuine copy, not the same object.
    expect(out.messages[0]).not.toBe(thread.messages[0]);
    expect(out).not.toBe(thread);
  });

  it('drops data from a path-backed tool-result image in the serialized copy but keeps it live', () => {
    const msg = toolImageMsg('m2', [
      { mediaType: 'image/png', data: 'BBBB', path: 'Claude/attachments/t1/m2-0.png' },
    ]);
    const thread = makeThread({ messages: [msg] });

    const out = serializeThreadForSave(thread);

    expect(out.messages[0].toolResultImages![0].data).toBeUndefined();
    expect(out.messages[0].toolResultImages![0].path).toBe('Claude/attachments/t1/m2-0.png');
    expect(thread.messages[0].toolResultImages![0].data).toBe('BBBB');
  });

  it('keeps base64 when the image has no path yet (write still in flight)', () => {
    const msg = userImageMsg('m1', [{ base64: 'AAAA', mediaType: 'image/png', name: 'a.png' }]);
    const thread = makeThread({ messages: [msg] });

    const out = serializeThreadForSave(thread);

    // No path → base64 must survive this pass (externalizes next save).
    expect(out.messages[0].images![0].base64).toBe('AAAA');
    // Nothing to strip and no statusTags → identity preserved (no needless clone).
    expect(out).toBe(thread);
  });

  it('strips ephemeral statusTags like the prior serialize step did', () => {
    const thread = makeThread({
      messages: [],
      statusTags: [{ label: 'PR #1' }],
    });

    const out = serializeThreadForSave(thread);

    expect(out.statusTags).toBeUndefined();
    expect(thread.statusTags).toBeDefined(); // live object untouched
    expect(out).not.toBe(thread);
  });

  it('only clones messages that actually need stripping', () => {
    const clean = userImageMsg('clean', [{ base64: 'x', mediaType: 'image/png', name: 'x.png' }]);
    const dirty = userImageMsg('dirty', [
      { base64: 'y', mediaType: 'image/png', name: 'y.png', path: 'Claude/attachments/t1/dirty-0.png' },
    ]);
    const thread = makeThread({ messages: [clean, dirty] });

    const out = serializeThreadForSave(thread);

    // The message with no path is passed through by reference.
    expect(out.messages[0]).toBe(clean);
    // The path-backed message is a stripped copy.
    expect(out.messages[1]).not.toBe(dirty);
    expect(out.messages[1].images![0].base64).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// collectPendingImageExternalizations: the backfill walk / predicate
// ---------------------------------------------------------------------------

describe('collectPendingImageExternalizations', () => {
  it('collects user + tool-result images that have bytes but no path', () => {
    const threads: Thread[] = [
      makeThread({
        id: 'tA',
        messages: [
          userImageMsg('u1', [{ base64: 'AAA', mediaType: 'image/png', name: 'a.png' }]),
          toolImageMsg('a1', [{ mediaType: 'image/jpeg', data: 'BBB' }]),
        ],
      }),
    ];

    const pending = collectPendingImageExternalizations(threads);

    expect(pending).toHaveLength(2);
    expect(pending[0]).toMatchObject({ threadId: 'tA', messageId: 'u1', index: 0, mediaType: 'image/png', base64: 'AAA' });
    expect(pending[1]).toMatchObject({ threadId: 'tA', messageId: 'a1', index: 0, mediaType: 'image/jpeg', base64: 'BBB' });
  });

  it('skips images that already have a path (idempotent re-run)', () => {
    const threads: Thread[] = [
      makeThread({
        messages: [
          userImageMsg('u1', [
            { base64: 'AAA', mediaType: 'image/png', name: 'a.png', path: 'Claude/attachments/t1/u1-0.png' },
          ]),
          toolImageMsg('a1', [{ mediaType: 'image/png', data: 'BBB', path: 'Claude/attachments/t1/a1-0.png' }]),
        ],
      }),
    ];

    expect(collectPendingImageExternalizations(threads)).toHaveLength(0);
  });

  it('setPath writes the resolved path back onto the source ref', () => {
    const msg = userImageMsg('u1', [{ base64: 'AAA', mediaType: 'image/png', name: 'a.png' }]);
    const threads = [makeThread({ messages: [msg] })];

    const [pending] = collectPendingImageExternalizations(threads);
    pending.setPath('Claude/attachments/t1/u1-0.png');

    // The live message ref now carries the path, so the next serialize strips base64.
    expect(msg.images![0].path).toBe('Claude/attachments/t1/u1-0.png');
    expect(serializeThreadForSave(threads[0]).messages[0].images![0].base64).toBeUndefined();
  });

  it('preserves index for multiple images on one message', () => {
    const threads = [
      makeThread({
        messages: [
          userImageMsg('u1', [
            { base64: 'A', mediaType: 'image/png', name: '0.png' },
            { base64: 'B', mediaType: 'image/png', name: '1.png' },
          ]),
        ],
      }),
    ];

    const pending = collectPendingImageExternalizations(threads);
    expect(pending.map((p) => p.index)).toEqual([0, 1]);
    expect(pending.map((p) => p.base64)).toEqual(['A', 'B']);
  });
});

describe('imageEmbedMarkdown', () => {
  it('renders an Obsidian embed for a path-backed user image', () => {
    const msg: Pick<ChatMessage, 'images' | 'toolResultImages'> = {
      images: [{ mediaType: 'image/png', name: 'a.png', path: 'Claude/attachments/t1/m1-0.png' }],
    };
    expect(imageEmbedMarkdown(msg)).toBe('![[Claude/attachments/t1/m1-0.png]]');
  });

  it('renders an embed for a path-backed tool-result image', () => {
    const msg: Pick<ChatMessage, 'images' | 'toolResultImages'> = {
      toolResultImages: [{ mediaType: 'image/png', path: 'Claude/attachments/t1/m2-0.png' }],
    };
    expect(imageEmbedMarkdown(msg)).toBe('![[Claude/attachments/t1/m2-0.png]]');
  });

  it('emits NO embed for a base64-only image (not yet externalized)', () => {
    const msg: Pick<ChatMessage, 'images' | 'toolResultImages'> = {
      images: [{ mediaType: 'image/png', name: 'a.png', base64: 'AAAA' }],
      toolResultImages: [{ mediaType: 'image/png', data: 'BBBB' }],
    };
    expect(imageEmbedMarkdown(msg)).toBe('');
  });

  it('embeds only path-backed images and skips base64-only ones in the same message', () => {
    const msg: Pick<ChatMessage, 'images' | 'toolResultImages'> = {
      images: [
        { mediaType: 'image/png', name: 'a.png', path: 'Claude/attachments/t1/m1-0.png' },
        { mediaType: 'image/png', name: 'b.png', base64: 'CCCC' },
      ],
      toolResultImages: [{ mediaType: 'image/png', path: 'Claude/attachments/t1/m1-1.png' }],
    };
    expect(imageEmbedMarkdown(msg)).toBe(
      '![[Claude/attachments/t1/m1-0.png]]\n![[Claude/attachments/t1/m1-1.png]]',
    );
  });

  it('returns empty string when the message has no images', () => {
    expect(imageEmbedMarkdown({})).toBe('');
  });
});
