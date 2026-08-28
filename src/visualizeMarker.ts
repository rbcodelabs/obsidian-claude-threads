/**
 * visualizeMarker.ts
 *
 * Scanner for the inline-visualization content reference emitted by OpenAI's
 * Codex `visualize` plugin. The model puts the marker on its own line in its
 * final response, where the visual should appear:
 *
 *     visualize{"path":"/abs/path/to/thing.html"}
 *     visualize{"path":"/abs/path/to/thing.html","mode":"wide","title":"…"}
 *
 * It is not a tool call, so nothing in the harness layer sees it. This module
 * rewrites each valid marker line into an anchor placeholder *before* the text
 * reaches `marked`, so the markdown is parsed exactly once and list numbering,
 * reference links, and footnotes that span a marker keep working. The renderer
 * swaps those anchors for cards after `sanitizeHTMLToDom`.
 *
 * Purity contract: no `fs`, no `path`, no `os`, no Obsidian imports. This module
 * is reachable from MobileView, which is loaded at bundle-init on every
 * platform (see test/unit/bundle-safety.test.ts).
 */

/** Placeholder class the renderer looks for after markdown parsing. */
export const VISUALIZE_SLOT_CLASS = 'ct-visualize-slot';

/** Data attribute carrying the marker's index into the returned `markers` array. */
export const VISUALIZE_SLOT_ATTR = 'data-ct-viz';

/** Maximum accepted `title` length; longer titles are truncated, not rejected. */
export const MAX_TITLE_LENGTH = 250;

export interface VisualizeMarker {
  /** Index into the `markers` array, mirrored in the anchor's data attribute. */
  index: number;
  /** Absolute, executor-side path to the HTML fragment. */
  path: string;
  /** Present only when the model asked for the wide surface. */
  mode?: 'wide';
  /** Optional display title, truncated to {@link MAX_TITLE_LENGTH}. */
  title?: string;
}

export interface ExtractVisualizeOptions {
  /**
   * True while the assistant message is still streaming. Only then is a
   * trailing, not-yet-complete marker line suppressed, so the user never
   * watches raw JSON type itself out. When the message has settled, malformed
   * markers are deliberately left visible so bad model output is diagnosable.
   */
  streaming?: boolean;
}

export interface ExtractVisualizeResult {
  /** The source text with valid marker lines replaced by anchor placeholders. */
  text: string;
  /** Markers in document order. Empty when the source contains none. */
  markers: VisualizeMarker[];
}

/** Absolute POSIX path, or a Windows drive path. Relative paths are rejected. */
const ABSOLUTE_PATH_RE = /^([A-Za-z]:[\\/]|\/)/;

/**
 * A candidate marker line: `visualize{` at the very start of the line, allowing
 * the 0-3 leading spaces CommonMark permits before a block. Anchoring to the
 * line start is what makes the inline-code case (`` `visualize{…}` ``) safe for
 * free: it can never be at column 0 of its own line.
 */
const MARKER_LINE_RE = /^ {0,3}visualize\{/;

/**
 * A trailing line that is the bare token with no object yet (streaming only).
 * Deliberately exact: `visualize this for me` is ordinary prose and must never
 * be swallowed. Lines that have already reached `visualize{` are handled by
 * {@link MARKER_LINE_RE}.
 */
const PARTIAL_MARKER_RE = /^ {0,3}visualize\s*$/;

/** Opening or closing fence: 3+ backticks or tildes, indented at most 3 spaces. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * A line that is indented 4+ columns. Such a line can never be a marker (the
 * `{0,3}` bound already excludes it) and is skipped for fence bookkeeping too,
 * so a fence delimiter quoted inside an indented code block cannot flip the
 * fence state. This is a deliberate approximation of CommonMark's indented-code
 * rules: markers are always emitted at column 0, so the only thing that matters
 * is that we never *mistake* indented content for markup.
 */
const INDENTED_RE = /^(?: {4,}|\t)/;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Scan a brace-balanced JSON object starting at `start` (which must index a
 * `{`), respecting string literals and backslash escapes. Returns the index
 * just past the matching `}`, or -1 when the object never closes.
 *
 * Regex is deliberately not used here: a JSON value may legitimately contain
 * braces inside a string (`{"title":"a {b} c"}`), and a regex cannot count.
 */
export function scanBalancedObject(source: string, start: number): number {
  if (source[start] !== '{') return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Validate a parsed marker payload. Returns null when the payload is not a
 * usable marker, in which case the line is left as literal text.
 */
export function validateMarkerPayload(value: unknown): Omit<VisualizeMarker, 'index'> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const path = raw.path;
  if (typeof path !== 'string' || !ABSOLUTE_PATH_RE.test(path)) return null;

  const marker: Omit<VisualizeMarker, 'index'> = { path };
  if (raw.mode === 'wide') marker.mode = 'wide';
  if (typeof raw.title === 'string') {
    const title = raw.title.trim();
    if (title) marker.title = title.slice(0, MAX_TITLE_LENGTH);
  }
  return marker;
}

/** The anchor placeholder substituted for a valid marker line. */
export function slotAnchorHtml(marker: VisualizeMarker): string {
  // Fallback text matters: if a host sanitizer ever strips the data attribute
  // and the swap never happens, the reader sees a label rather than nothing.
  const label = escapeHtml(marker.title ?? basename(marker.path));
  return `<a class="${VISUALIZE_SLOT_CLASS}" ${VISUALIZE_SLOT_ATTR}="${marker.index}" href="#">${label}</a>`;
}

/** Last path segment of a POSIX or Windows path. Local to keep this module `path`-free. */
export function basename(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+$/, '');
  const cut = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return cut === -1 ? normalized : normalized.slice(cut + 1);
}

/**
 * Rewrite every valid `visualize{…}` marker line in `src` into an anchor
 * placeholder and return the markers found, in document order.
 *
 * Markers inside fenced code blocks are ignored: `SKILL.md` documents the
 * marker syntax inside ```` ```text ```` fences, and models quote their own
 * docs constantly.
 */
export function extractVisualizeMarkers(
  src: string,
  options: ExtractVisualizeOptions = {},
): ExtractVisualizeResult {
  if (!src.includes('visualize')) return { text: src, markers: [] };

  const lines = src.split('\n');
  const markers: VisualizeMarker[] = [];
  let changed = false;
  let fenceChar: string | null = null;
  let fenceLength = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Keep CRLF intact: operate on the line without its carriage return, and
    // re-attach it if the line is left untouched.
    const hasCr = line.endsWith('\r');
    const body = hasCr ? line.slice(0, -1) : line;

    if (INDENTED_RE.test(body)) continue;

    const fence = FENCE_RE.exec(body);
    if (fence) {
      const delim = fence[1];
      const char = delim[0];
      if (fenceChar === null) {
        fenceChar = char;
        fenceLength = delim.length;
      } else if (char === fenceChar && delim.length >= fenceLength && !body.slice(fence[0].length).trim()) {
        fenceChar = null;
        fenceLength = 0;
      }
      continue;
    }
    if (fenceChar !== null) continue;

    if (!MARKER_LINE_RE.test(body)) {
      if (options.streaming && i === lines.length - 1 && PARTIAL_MARKER_RE.test(body)) {
        // The bare token, with the object still arriving.
        lines[i] = '';
        changed = true;
      }
      continue;
    }

    const braceAt = body.indexOf('{');
    const end = scanBalancedObject(body, braceAt);
    const isLastLine = i === lines.length - 1;

    if (end === -1) {
      // Unterminated object. Mid-stream this is simply a marker still arriving.
      if (options.streaming && isLastLine) {
        lines[i] = '';
        changed = true;
      }
      continue;
    }
    // Anything other than whitespace after the object means this is prose that
    // merely starts with the token, not a content reference.
    if (body.slice(end).trim()) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(body.slice(braceAt, end));
    } catch {
      if (options.streaming && isLastLine) {
        lines[i] = '';
        changed = true;
      }
      continue;
    }

    const validated = validateMarkerPayload(parsed);
    if (!validated) continue;

    const marker: VisualizeMarker = { index: markers.length, ...validated };
    markers.push(marker);
    lines[i] = slotAnchorHtml(marker) + (hasCr ? '\r' : '');
    changed = true;
  }

  return changed ? { text: lines.join('\n'), markers } : { text: src, markers };
}
