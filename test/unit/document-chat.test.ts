/**
 * document-chat.test.ts
 * @vitest-environment jsdom
 *
 * Covers "Chat about this document":
 *   1. The pure helpers in src/documentChat.ts (eligibility, mention format,
 *      draft seeding).
 *   2. The seeded draft is in the SAME `@[[basename]]` format the dispatch
 *      mention resolver looks for — if either side drifts, the seeded mention
 *      would silently reach Claude as literal text with no file content.
 *   3. DispatchInput.setValueAndFocus parks the caret AFTER the mention.
 *   4. Source guard: all three entry points stay registered in main.ts.
 */

import '../setup/obsidian-dom'; // Polyfill Obsidian's HTMLElement extensions for jsdom

import { vi, describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// DispatchInput pulls in fs (skill discovery) and the STT controller; stub both
// the same way DispatchInput.test.ts does so mount() works headlessly.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      readdirSync: () => [],
      statSync: () => ({ isDirectory: () => false }),
      existsSync: () => false,
      readFileSync: actual.readFileSync,
    },
    readdirSync: () => [],
    statSync: () => ({ isDirectory: () => false }),
    existsSync: () => false,
  };
});

vi.mock('../../src/stt', () => {
  function SttController() {
    return {
      attachPttToTextarea: vi.fn(() => () => {}),
      createMicButton: vi.fn(() => document.createElement('button')),
      destroy: vi.fn(),
    };
  }
  return { SttController };
});

import {
  DOCUMENT_CHAT_LABEL,
  documentMention,
  isChattableDocument,
  seedDocumentChatDraft,
} from '../../src/documentChat';
import { DispatchInput } from '../../src/DispatchInput';
import { App } from 'obsidian';

// The exact regex the dispatch handlers use to resolve mentions.
const RESOLVER_REGEX = /@\[\[([^\]]+)\]\]/g;

describe('isChattableDocument', () => {
  it('accepts markdown files', () => {
    expect(isChattableDocument({ extension: 'md' })).toBe(true);
  });

  it('is case-insensitive on the extension', () => {
    expect(isChattableDocument({ extension: 'MD' })).toBe(true);
  });

  it('rejects non-markdown files the mention resolver cannot read', () => {
    expect(isChattableDocument({ extension: 'pdf' })).toBe(false);
    expect(isChattableDocument({ extension: 'png' })).toBe(false);
    expect(isChattableDocument({ extension: 'canvas' })).toBe(false);
  });

  it('rejects folders (no extension) and null', () => {
    expect(isChattableDocument({})).toBe(false);
    expect(isChattableDocument(null)).toBe(false);
    expect(isChattableDocument(undefined)).toBe(false);
  });
});

describe('seeded draft format', () => {
  it('uses the composer @[[basename]] mention style', () => {
    expect(documentMention('Weekly Review')).toBe('@[[Weekly Review]]');
    expect(seedDocumentChatDraft('', 'Weekly Review')).toBe('@[[Weekly Review]] ');
  });

  it('produces a mention the dispatch resolver actually matches', () => {
    const seeded = seedDocumentChatDraft('', 'Weekly Review');
    const matches = [...seeded.matchAll(RESOLVER_REGEX)].map(m => m[1]);
    expect(matches).toEqual(['Weekly Review']);
  });

  it('resolves basenames containing spaces, dots and dashes', () => {
    const seeded = seedDocumentChatDraft('', '2026-09-11 Notes v1.2');
    const matches = [...seeded.matchAll(RESOLVER_REGEX)].map(m => m[1]);
    expect(matches).toEqual(['2026-09-11 Notes v1.2']);
  });

  it('appends to an existing draft instead of clobbering it', () => {
    expect(seedDocumentChatDraft('compare against', 'Spec')).toBe('compare against @[[Spec]] ');
  });

  it('treats a whitespace-only draft as empty', () => {
    expect(seedDocumentChatDraft('   \n', 'Spec')).toBe('@[[Spec]] ');
  });

  it('does not inline the same document twice when triggered repeatedly', () => {
    const once = seedDocumentChatDraft('', 'Spec');
    const twice = seedDocumentChatDraft(once, 'Spec');
    expect([...twice.matchAll(RESOLVER_REGEX)]).toHaveLength(1);
    expect(twice).toBe('@[[Spec]] ');
  });

  it('still adds a second, different document', () => {
    const first = seedDocumentChatDraft('', 'Spec');
    const both = seedDocumentChatDraft(first, 'Design');
    expect([...both.matchAll(RESOLVER_REGEX)].map(m => m[1])).toEqual(['Spec', 'Design']);
  });
});

describe('DispatchInput.setValueAndFocus', () => {
  it('sets the draft, focuses the textarea, and parks the caret at the end', () => {
    const di = new DispatchInput({ app: new App(), onSend: vi.fn() });
    const root = document.createElement('div');
    document.body.appendChild(root);
    di.mount(root);

    const textarea = root.querySelector('textarea')!;
    // Simulate a stale caret position at the start of the field.
    textarea.value = 'old draft';
    textarea.setSelectionRange(0, 0);

    di.setValueAndFocus('@[[Spec]] ');

    expect(textarea.value).toBe('@[[Spec]] ');
    expect(document.activeElement).toBe(textarea);
    // Caret sits after the mention so the user types their question, not before it.
    expect(textarea.selectionStart).toBe('@[[Spec]] '.length);
    expect(textarea.selectionEnd).toBe('@[[Spec]] '.length);
  });
});

describe('main.ts entry-point registration', () => {
  const mainSrc = readFileSync(resolve(__dirname, '../../src/main.ts'), 'utf8');

  it('registers the file-explorer context menu handler', () => {
    expect(mainSrc).toMatch(/workspace\.on\('file-menu'/);
  });

  it('registers the editor context menu handler', () => {
    expect(mainSrc).toMatch(/workspace\.on\('editor-menu'/);
  });

  it('registers a command-palette command gated on an active document', () => {
    expect(mainSrc).toMatch(/id: 'chat-about-active-document'/);
    expect(mainSrc).toMatch(/checkCallback/);
  });

  it('routes both context menus through the shared menu-item helper', () => {
    // Both menu registrations must reach addDocumentChatMenuItem, which is the
    // only place the label/icon is set — otherwise the two menus could drift.
    const menuHandlers = mainSrc.match(/this\.addDocumentChatMenuItem\(menu, file\)/g) ?? [];
    expect(menuHandlers).toHaveLength(2);
    expect(mainSrc).toMatch(/addDocumentChatMenuItem\(menu: Menu, file: TFile\)[\s\S]{0,200}setTitle\(DOCUMENT_CHAT_LABEL\)/);
  });

  it('names the command with the same shared label', () => {
    expect(mainSrc).toMatch(/id: 'chat-about-active-document',\s*\n\s*name: DOCUMENT_CHAT_LABEL,/);
    expect(DOCUMENT_CHAT_LABEL).toBe('Chat about this document');
  });
});
