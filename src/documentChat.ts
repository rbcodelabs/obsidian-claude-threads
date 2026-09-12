/**
 * "Chat about this document" — pure helpers shared by all three entry points
 * (file-explorer context menu, editor context menu, command palette).
 *
 * The seeded draft deliberately uses the composer's own `@[[basename]]` mention
 * syntax, so the mention resolver that already runs at dispatch time inlines the
 * file's content. One mention format, one resolver, no second code path.
 *
 * No Obsidian/Node imports — kept pure so it can be unit tested directly.
 */

/** Menu label and command name, in one place so all three entry points match. */
export const DOCUMENT_CHAT_LABEL = 'Chat about this document';

/**
 * Whether to offer the action on a given file.
 *
 * The mention resolver looks a mention up against `vault.getMarkdownFiles()`,
 * so a mention pointing at a PDF or an image would silently resolve to nothing.
 * Gating on markdown keeps the menu item honest. Folders (no `extension`) and
 * null both fall through to `false`.
 */
export function isChattableDocument(file: { extension?: string } | null | undefined): boolean {
  return (file?.extension ?? '').toLowerCase() === 'md';
}

/** Format a mention exactly as DispatchInput's `@` autocomplete does. */
export function documentMention(basename: string): string {
  return `@[[${basename}]]`;
}

/**
 * Build the composer draft for a document chat.
 *
 * Appends rather than clobbers, so an in-progress draft survives. Re-running on
 * a document the draft already mentions is a no-op (beyond a trailing space) —
 * triggering the menu item twice must not inline the same file twice.
 */
export function seedDocumentChatDraft(draft: string | null | undefined, basename: string): string {
  const mention = documentMention(basename);
  const existing = (draft ?? '').replace(/\s+$/, '');
  if (!existing) return `${mention} `;
  if (existing.includes(mention)) return `${existing} `;
  return `${existing} ${mention} `;
}
