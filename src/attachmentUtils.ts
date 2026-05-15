/**
 * Pure utility functions for file and text attachments.
 * Kept separate so they can be unit-tested without a DOM environment.
 */

/** Maximum file size (bytes) accepted for text file attachments. */
export const MAX_ATTACHMENT_BYTES = 500_000;

/**
 * Combine typed user text with a text-file attachment into the final prompt
 * body sent to Claude. The attachment is wrapped in a triple-backtick fence
 * so Claude reads it as a code block with the filename on the first line.
 *
 * Returns a single space when both inputs are empty (keeps the SDK happy).
 */
export function buildMessageWithAttachment(
  text: string,
  attachment: string | null,
): string {
  if (!attachment) return text || ' ';
  const fenced = `\`\`\`\n${attachment}\n\`\`\``;
  return text ? `${text}\n\n${fenced}` : fenced;
}

/**
 * Derive a human-readable thread title for a dispatch.
 * Priority: typed text → attachment filename (first line) → image count → fallback.
 */
export function deriveDispatchTitle(
  text: string,
  attachment: string | null,
  imageCount: number,
): string {
  const candidate = text.trim() || (attachment ? attachment.split('\n')[0].trim() : '');
  if (candidate) return candidate.slice(0, 50);
  if (imageCount > 0) return `Image task (${imageCount} image${imageCount > 1 ? 's' : ''})`;
  return 'New Thread';
}
