/**
 * Pure parsing/derivation logic for the status-line footer. No Obsidian or
 * Node dependencies so it is trivially unit-testable.
 *
 * The configured statusLineCommand may emit either:
 *  - a JSON array of StatusTag objects (or `{ "tags": [...] }`), or
 *  - legacy Claude Code plaintext (segments split on 2+ spaces).
 *
 * `parseStatusLine` normalizes both into StatusTag[] so the renderer has one path.
 */
import type { StatusTag } from './types';

const PR_URL_RE = /\/pull\/\d+/;

/** Lucide icon for a tag: explicit `icon` wins, else resolved from `kind`. */
export function resolveTagIcon(tag: StatusTag): string {
  if (tag.icon) return tag.icon;
  switch (tag.kind) {
    case 'pr': return 'git-pull-request';
    case 'branch': return 'git-branch';
    case 'dev': return 'globe';
    case 'aws': return (tag.tone === 'warn' || tag.tone === 'error') ? 'cloud-off' : 'cloud';
    default: return 'tag';
  }
}

/**
 * Derive a thread's PR url from its tags: the first kind:'pr' tag with a url,
 * else the first tag whose url looks like a GitHub pull request.
 */
export function derivePrUrl(tags: StatusTag[]): string | undefined {
  const prTag = tags.find((t) => t.kind === 'pr' && !!t.url);
  if (prTag?.url) return prTag.url;
  const urlTag = tags.find((t) => !!t.url && PR_URL_RE.test(t.url));
  return urlTag?.url;
}

/** Coerce an arbitrary parsed JSON value into a clean StatusTag, or null. */
function coerceTag(raw: unknown): StatusTag | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.label !== 'string' || o.label.trim() === '') return null;
  const tag: StatusTag = { label: o.label };
  if (typeof o.url === 'string') tag.url = o.url;
  if (typeof o.icon === 'string') tag.icon = o.icon;
  if (o.tone === 'normal' || o.tone === 'warn' || o.tone === 'error') tag.tone = o.tone;
  if (typeof o.kind === 'string') tag.kind = o.kind;
  return tag;
}

/** Map one legacy plaintext segment to a StatusTag using the historical heuristics. */
function legacySegmentToTag(seg: string): StatusTag {
  if (/^https?:\/\//.test(seg)) {
    return { label: seg, url: seg, icon: 'globe', kind: 'dev' };
  }
  if (/^PR #\d+/.test(seg)) {
    return { label: seg, icon: 'git-pull-request', kind: 'pr' };
  }
  if (/AWS/.test(seg)) {
    const expired = seg.includes('expired');
    return {
      label: seg,
      icon: expired ? 'cloud-off' : 'cloud',
      tone: expired ? 'warn' : 'normal',
      kind: 'aws',
    };
  }
  return { label: seg, icon: 'git-branch', kind: 'branch' };
}

/** Parse legacy plaintext: split on 2+ spaces, each segment a pill. */
function parsePlaintext(text: string): StatusTag[] {
  return text
    .split(/ {2,}/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(legacySegmentToTag);
}

/**
 * Parse statusLineCommand stdout into StatusTag[].
 *
 * - Empty → [].
 * - Starts with `[` or `{` → try JSON (array, or `{ tags: [...] }`). On a parse
 *   error or shape mismatch, fall back to plaintext (a `[`-leading non-JSON line
 *   should not blank the footer).
 * - Otherwise → legacy plaintext.
 */
export function parseStatusLine(stdout: string): StatusTag[] {
  const text = (stdout ?? '').trim();
  if (!text) return [];

  const first = text[0];
  if (first === '[' || first === '{') {
    try {
      const parsed: unknown = JSON.parse(text);
      const arr = Array.isArray(parsed)
        ? parsed
        : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { tags?: unknown }).tags))
          ? (parsed as { tags: unknown[] }).tags
          : null;
      if (arr) {
        return arr.map(coerceTag).filter((t): t is StatusTag => t !== null);
      }
      // Parsed but not a recognized shape → fall through to plaintext.
    } catch {
      // Not valid JSON → fall through to plaintext.
    }
  }

  return parsePlaintext(text);
}
