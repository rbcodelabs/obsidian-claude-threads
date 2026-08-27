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

/** What `renderStatusFooter` should actually draw, after git-diff-bar dedupe. */
export interface FooterPlan {
  /** Script tags to render, minus any the git diff bar already covers. */
  tags: StatusTag[];
  /** Whether to render the synthesized leading PR pill from the sticky prUrl. */
  showPrPill: boolean;
  /** True when nothing at all would render from tags/prUrl (footer hides). */
  empty: boolean;
}

/**
 * Decide the footer's contents, given the live status tags, the thread's sticky
 * prUrl, and whether the native git diff bar is currently on screen.
 *
 * The git diff bar already shows branch, diff stat, and a PR button labelled
 * with the PR number, so while it's visible a footer 'pr'/'branch' pill would
 * just restate the row below it. Suppress both the script-provided tags of
 * those kinds and the synthesized sticky-prUrl pill in that case. When the bar
 * is hidden (PR merged and back on the base branch, non-git cwd, detached HEAD)
 * the suppression lifts, so the footer remains the fallback surface for the PR.
 *
 * `empty` deliberately reflects what was actually kept, not the raw inputs — a
 * prUrl that got deduped away must not hold an otherwise-empty footer open.
 */
export function planFooter(opts: {
  tags: StatusTag[];
  prUrl?: string;
  barShowsGitInfo: boolean;
}): FooterPlan {
  const { prUrl, barShowsGitInfo } = opts;
  const tags = barShowsGitInfo
    ? opts.tags.filter((t) => t.kind !== 'pr' && t.kind !== 'branch')
    : opts.tags;
  const hasPrTag = tags.some((t) => t.kind === 'pr' && !!t.url);
  const showPrPill = !!prUrl && !hasPrTag && !barShowsGitInfo;
  return { tags, showPrPill, empty: !showPrPill && tags.length === 0 };
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
