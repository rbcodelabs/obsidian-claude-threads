/**
 * visualizeDocument.ts
 *
 * Wraps a Codex `visualize` HTML *fragment* into a complete, self-contained,
 * sandbox-safe document.
 *
 * The file a marker points at has no doctype, `<html>`, `<head>` or `<body>` —
 * it starts straight at a `<div>`. Displaying it raw gives half-styled markup,
 * so a wrap step is mandatory everywhere the fragment is shown.
 *
 * Three things this module exists to get right:
 *
 * 1. **Its own `<meta>` CSP.** `about:srcdoc` inherits the *parent's* policy
 *    container, and the host window's CSP only constrains `style-src`. Without
 *    an explicit meta tag the fragment would run with unrestricted `script-src`
 *    and `connect-src`. The policy strings are ported from the Codex plugin's
 *    own renderer so the CDN allowlist matches what the model was told it has.
 * 2. **Literal theme tokens.** CSS custom properties do not cross an iframe
 *    boundary, and `color-scheme: light dark` inside a sandboxed opaque origin
 *    resolves against the *OS*, not the host theme — so a dark-theme user on a
 *    light-mode Mac would get a white slab. The host resolves its variables
 *    with `getComputedStyle` and we emit the results as literal values.
 * 3. **Storage shims.** In an opaque origin `localStorage` and `sessionStorage`
 *    *throw* `SecurityError` on access; they do not return null. Fragments that
 *    persist UI state would die on line one without an in-memory stand-in.
 *
 * Purity contract: no `fs`, no `path`, no `os`, no Obsidian imports, no DOM.
 * Everything here is string building so it can be snapshot-tested.
 */

/** Origins the Codex `visualize` skill promises the model it can load from. */
const RESOURCE_SOURCES = [
  'blob:',
  'data:',
  'https://cdnjs.cloudflare.com',
  'https://cdn.jsdelivr.net',
  'https://esm.sh',
  'https://fonts.bunny.net',
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
  'https://unpkg.com',
].join(' ');

/**
 * Policy for the frame that actually executes the fragment. Ported verbatim
 * from the Codex plugin's renderer, including the CDN allowlist, so a fragment
 * built against the documented contract behaves identically here.
 */
export const FRAME_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${RESOURCE_SOURCES}`,
  `style-src 'unsafe-inline' ${RESOURCE_SOURCES}`,
  `img-src ${RESOURCE_SOURCES}`,
  `font-src ${RESOURCE_SOURCES}`,
  `media-src ${RESOURCE_SOURCES}`,
  'worker-src blob:',
  'connect-src blob: data:',
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/**
 * Policy for the outer shell of the pop-out document. A srcdoc frame inherits
 * the shell's policy container, so the shell must permit everything the inner
 * frame may load, plus `frame-src 'self'` to host the inner frame at all.
 */
export const SHELL_CSP = FRAME_CSP.replace("frame-src 'none'", "frame-src 'self'");

export type VisualizeTheme = 'dark' | 'light';

/**
 * Host CSS variables read for each contract token, in priority order. The
 * first one that resolves to a non-empty value wins; `fallback` is used when
 * none do (headless snapshot tests, or a theme that omits an optional var).
 *
 * The token names on the left are the ones the Codex skill tells the model are
 * available. Mapping them onto Obsidian's own variables is what makes a
 * fragment look native here instead of importing OpenAI's greys.
 */
export const TOKEN_SOURCES: ReadonlyArray<{ token: string; from: string[]; fallback: string }> = [
  { token: '--background', from: ['--background-primary'], fallback: '#ffffff' },
  { token: '--foreground', from: ['--text-normal'], fallback: '#1a1a1a' },
  { token: '--card', from: ['--background-secondary'], fallback: '#f5f6f8' },
  { token: '--card-foreground', from: ['--text-normal'], fallback: '#1a1a1a' },
  { token: '--popover', from: ['--background-secondary-alt', '--background-secondary'], fallback: '#f5f6f8' },
  { token: '--popover-foreground', from: ['--text-normal'], fallback: '#1a1a1a' },
  { token: '--primary', from: ['--interactive-accent'], fallback: '#5865f2' },
  { token: '--primary-foreground', from: ['--text-on-accent'], fallback: '#ffffff' },
  { token: '--secondary', from: ['--background-modifier-hover', '--background-secondary'], fallback: '#e9eaee' },
  { token: '--secondary-foreground', from: ['--text-normal'], fallback: '#1a1a1a' },
  { token: '--muted', from: ['--background-modifier-border'], fallback: '#dcdde1' },
  { token: '--muted-foreground', from: ['--text-muted'], fallback: '#6b6f76' },
  { token: '--accent', from: ['--background-modifier-hover', '--background-secondary'], fallback: '#e9eaee' },
  { token: '--accent-foreground', from: ['--text-normal'], fallback: '#1a1a1a' },
  { token: '--destructive', from: ['--color-red'], fallback: '#e05252' },
  { token: '--border', from: ['--background-modifier-border'], fallback: '#dcdde1' },
  { token: '--input', from: ['--background-modifier-form-field', '--background-primary'], fallback: '#ffffff' },
  { token: '--ring', from: ['--interactive-accent'], fallback: '#5865f2' },
  { token: '--blue', from: ['--color-blue'], fallback: '#527ae0' },
  { token: '--orange', from: ['--color-orange'], fallback: '#e08c52' },
  { token: '--green', from: ['--color-green'], fallback: '#4caf50' },
  { token: '--red', from: ['--color-red'], fallback: '#e05252' },
  { token: '--purple', from: ['--color-purple'], fallback: '#a352e0' },
  { token: '--yellow', from: ['--color-yellow'], fallback: '#e0c452' },
  // Series colours: 1 is the "one measure / active state" slot, so it tracks the
  // host accent. 2-6 are a stable, deliberately ordered ramp — the skill
  // contract requires the mapping to stay stable across renders.
  { token: '--viz-series-1', from: ['--interactive-accent'], fallback: '#5865f2' },
  { token: '--viz-series-2', from: ['--color-green'], fallback: '#4caf50' },
  { token: '--viz-series-3', from: ['--color-orange'], fallback: '#e08c52' },
  { token: '--viz-series-4', from: ['--color-purple'], fallback: '#a352e0' },
  { token: '--viz-series-5', from: ['--color-red'], fallback: '#e05252' },
  { token: '--viz-series-6', from: ['--color-yellow'], fallback: '#e0c452' },
  { token: '--viz-font', from: ['--font-interface'], fallback: 'ui-sans-serif, system-ui, sans-serif' },
  { token: '--viz-font-mono', from: ['--font-monospace'], fallback: 'ui-monospace, SFMono-Regular, monospace' },
];

/**
 * Our implementation of the utility-class contract the Codex skill documents.
 *
 * Written from that contract rather than reusing the plugin's own stylesheet:
 * that asset is proprietary, its version directory is a brittle glob, most
 * users of this plugin have no Codex install at all, and it hardcodes OpenAI's
 * greys — which look wrong inside an Obsidian theme no matter how correct the
 * markup is. Everything below resolves through the tokens above instead.
 *
 * Known deviation: the upstream kit positions `[data-tooltip]` with floating-ui
 * loaded from a CDN. We use a CSS-only tooltip so the card renders offline and
 * deterministically; it does not flip on collision.
 */
export const VISUALIZE_STYLESHEET = `
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
html, body { margin: 0; padding: 0; }
body {
  /* flow-root, not the default: it suppresses margin collapsing so
     document.body.scrollHeight is the real content height. The auto-height
     protocol measures body and nothing else. */
  display: flow-root;
  background: var(--background);
  color: var(--foreground);
  font-family: var(--viz-font);
  font-size: 14px;
  font-weight: 400;
  line-height: 1.5;
}
h1, h2, h3 { margin: 0 0 8px; font-weight: 500; line-height: 1.3; }
h1 { font-size: 20px; }
h2 { font-size: 17px; }
h3 { font-size: 15px; }
p { margin: 0 0 8px; }
a { color: var(--primary); }
:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
svg { max-width: 100%; }

/* — Surfaces — */
.card {
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--card);
  color: var(--card-foreground);
}
.viz-stat { display: flex; flex-direction: column; gap: 2px; }
.viz-stat-value { font-size: 22px; font-weight: 500; font-variant-numeric: tabular-nums; line-height: 1.15; }
.viz-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.viz-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.viz-controls { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px 12px; margin-bottom: 12px; }
.viz-badge {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 1px 8px; border-radius: 999px;
  background: color-mix(in srgb, var(--viz-series-1) 16%, transparent);
  color: var(--foreground); font-size: 12px; white-space: nowrap;
}
.progress { overflow: hidden; height: 8px; border-radius: 999px; background: color-mix(in srgb, var(--muted-foreground) 22%, transparent); }
.progress-bar { height: 100%; border-radius: inherit; background: var(--viz-series-1); }

/* — Controls — */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 30px; padding: 4px 12px;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--secondary); color: var(--secondary-foreground);
  font: inherit; font-size: 13px; text-decoration: none; cursor: pointer;
}
.btn:hover { border-color: var(--ring); }
.btn[aria-pressed="true"], .btn.is-active { border-color: var(--ring); background: color-mix(in srgb, var(--primary) 16%, var(--secondary)); }
.btn:disabled { opacity: .5; cursor: default; }
.btn-primary { border-color: transparent; background: var(--primary); color: var(--primary-foreground); }
.btn-ghost { border-color: transparent; background: transparent; color: var(--muted-foreground); }
.btn-block { width: 100%; }
.viz-tile {
  flex-direction: column; align-items: flex-start; gap: 2px;
  width: 100%; height: 100%; padding: 10px; text-align: left;
  background: color-mix(in srgb, var(--viz-series-1) 10%, transparent);
  border-color: transparent;
}
.viz-tile[aria-pressed="true"], .viz-tile.is-active { box-shadow: inset 0 0 0 2px var(--ring); background: color-mix(in srgb, var(--viz-series-1) 10%, transparent); }
.form-label { display: block; margin-bottom: 3px; color: var(--muted-foreground); font-size: 12px; }
.form-control, .form-select {
  min-height: 30px; padding: 4px 8px;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--input); color: var(--foreground); font: inherit; font-size: 13px;
}
.form-control-color { width: 40px; padding: 2px; }
.form-range { width: 100%; accent-color: var(--primary); }
.form-check { display: inline-flex; align-items: center; gap: 6px; }
.form-check-input { accent-color: var(--primary); }
.form-switch .form-check-input { width: 30px; height: 17px; }
.form-check-label { font-size: 13px; }

/* — Tables — */
.table { width: 100%; border-collapse: collapse; font-size: 13px; }
.table th, .table td { padding: 7px 10px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
.table th { color: var(--muted-foreground); font-weight: 500; }
.table tr:last-child td { border-bottom: 0; }
.table-sm th, .table-sm td { padding: 4px 8px; }
.table-responsive { overflow-x: auto; }
.table .text-end { text-align: right; font-variant-numeric: tabular-nums; }
.table .text-center { text-align: center; }
.text-end { text-align: right; }
.text-center { text-align: center; }
.text-nowrap { white-space: nowrap; }

/* — Text — */
.text-small { font-size: 12px; }
.text-muted { color: var(--muted-foreground); }
.text-destructive { color: var(--destructive); }
code, pre { font-family: var(--viz-font-mono); font-size: 12px; }
code { padding: 1px 4px; border-radius: 4px; background: color-mix(in srgb, var(--muted-foreground) 15%, transparent); }
pre { overflow-x: auto; padding: 10px; border-radius: 8px; background: var(--card); }
pre code { padding: 0; background: none; }
.sr-only {
  position: absolute; overflow: hidden; clip-path: inset(50%);
  width: 1px; height: 1px; margin: -1px; padding: 0; white-space: nowrap;
}

/* — Tooltips (CSS-only stand-in for the upstream floating-ui kit) — */
[data-tooltip] { position: relative; }
[data-tooltip]:hover::after, [data-tooltip]:focus-visible::after {
  content: attr(data-tooltip);
  position: absolute; bottom: calc(100% + 5px); left: 50%; z-index: 20;
  transform: translateX(-50%);
  padding: 3px 7px; border-radius: 6px;
  background: var(--popover); color: var(--popover-foreground);
  box-shadow: 0 2px 8px rgb(0 0 0 / .28);
  font-size: 12px; white-space: nowrap; pointer-events: none;
}
[data-tooltip-placement="bottom"]:hover::after { top: calc(100% + 5px); bottom: auto; }
[data-tooltip-placement="right"]:hover::after { top: 50%; bottom: auto; left: calc(100% + 5px); transform: translateY(-50%); }
[data-tooltip-placement="left"]:hover::after { top: 50%; right: calc(100% + 5px); bottom: auto; left: auto; transform: translateY(-50%); }
`.trim();

/** Message envelope the frame posts to its embedder. */
export const VISUALIZE_MESSAGE_SOURCE = 'ct-visualize';

/**
 * Injected before the fragment. Deliberately tiny and dependency-free — it runs
 * inside an opaque origin with `default-src 'none'`, so anything it needs must
 * already be in the document.
 *
 * `reportHeight` is only true for the inline card; the pop-out fills its own
 * viewport and has no embedder to talk to.
 */
export function buildPreamble(reportHeight: boolean): string {
  const heightProtocol = reportHeight
    ? `
  var last = -1, pending = 0;
  function measure() {
    pending = 0;
    if (!document.body) return;
    var h = Math.ceil(Math.max(document.body.scrollHeight, document.body.getBoundingClientRect().height));
    if (h === last) return;
    last = h;
    post({ type: 'height', height: h });
  }
  function schedule() { if (pending) return; pending = requestAnimationFrame(measure); }
  function start() {
    try { new ResizeObserver(schedule).observe(document.body); } catch (e) {}
    try { new MutationObserver(schedule).observe(document.body, { subtree: true, childList: true, attributes: true }); } catch (e) {}
    schedule();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
  window.addEventListener('load', schedule);
  // Async CDN modules and chart libraries settle well after load, and a late
  // draw that is never re-measured leaves the card clipped.
  [120, 400, 1200, 3000].forEach(function (t) { setTimeout(schedule, t); });`
    : '';

  return `(function () {
  function post(msg) {
    try { msg.source = ${JSON.stringify(VISUALIZE_MESSAGE_SOURCE)}; parent.postMessage(msg, '*'); } catch (e) {}
  }
  // In an opaque origin these THROW SecurityError rather than returning null,
  // so they are shadowed with an in-memory store before the fragment runs.
  function memoryStorage() {
    var map = new Map();
    return {
      get length() { return map.size; },
      key: function (i) { var k = Array.from(map.keys())[i]; return k === undefined ? null : k; },
      getItem: function (k) { k = String(k); return map.has(k) ? map.get(k) : null; },
      setItem: function (k, v) { map.set(String(k), String(v)); },
      removeItem: function (k) { map.delete(String(k)); },
      clear: function () { map.clear(); }
    };
  }
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    try { Object.defineProperty(window, name, { value: memoryStorage(), configurable: true }); } catch (e) {}
  });
  // Inert on purpose. A fragment can ask to push a follow-up prompt; the host
  // surfaces a notice and drops it rather than typing model-authored text into
  // the composer, which would be a prompt-injection channel.
  try {
    Object.defineProperty(window, 'openai', {
      value: Object.freeze({
        sendFollowUpMessage: function (payload) {
          var prompt = payload && typeof payload === 'object' ? payload.prompt : payload;
          post({ type: 'followUp', prompt: String(prompt === undefined ? '' : prompt).slice(0, 2000) });
          return Promise.resolve();
        }
      }),
      configurable: false
    });
  } catch (e) {}${heightProtocol}
})();`;
}

/** Escape a string for use inside a double-quoted HTML attribute. */
export function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape a string for use in HTML text content. */
export function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function tokenBlock(tokens: Readonly<Record<string, string>>): string {
  // Literal values, not var() references: custom properties do not cross the
  // iframe boundary, so the host must resolve them and hand over the results.
  const decls = TOKEN_SOURCES.map(({ token, fallback }) => `${token}:${tokens[token] ?? fallback}`).join(';');
  return `:root{${decls}}`;
}

export interface BuildVisualizeDocumentOptions {
  /** Raw fragment markup, inserted verbatim. Containment is the sandbox + CSP. */
  fragment: string;
  /** Host theme, mirrored onto `<html data-theme>` for fragments that branch on it. */
  theme: VisualizeTheme;
  /** Resolved host colours, keyed by the token names in {@link TOKEN_SOURCES}. */
  tokens: Readonly<Record<string, string>>;
  /** Document title. Defaults to a neutral label. */
  title?: string;
}

/**
 * Build the flat document rendered inside the inline card's iframe.
 *
 * Flat, not nested: the Codex renderer wraps its output in a second sandboxed
 * frame because that output is a standalone page that needs its own isolation
 * boundary. Inline, *our* iframe already is that boundary, and a nested frame
 * would break the `event.source === iframe.contentWindow` height check, since
 * the message would arrive from a grandchild window.
 */
export function buildInlineDocument(options: BuildVisualizeDocumentOptions): string {
  const title = escapeText(options.title ?? 'Visualization');
  return `<!doctype html>
<html lang="en" data-theme="${options.theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(FRAME_CSP)}">
<title>${title}</title>
<style>${tokenBlock(options.tokens)}
${VISUALIZE_STYLESHEET}
body{padding:12px}</style>
<script>${buildPreamble(true)}</script>
</head>
<body>
${options.fragment}
</body>
</html>
`;
}

/**
 * Build the pop-out document, opened as a top-level `file://` page in the host
 * Web Viewer.
 *
 * This one keeps the Codex renderer's nesting: with no ambient sandbox around
 * it, the inner `sandbox="allow-scripts"` frame is the only thing standing
 * between the fragment's scripts and a same-origin `file://` document that
 * could read the user's disk.
 */
export function buildPopoutDocument(options: BuildVisualizeDocumentOptions): string {
  const title = escapeText(options.title ?? 'Visualization');
  const inner = `<!doctype html>
<html lang="en" data-theme="${options.theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(FRAME_CSP)}">
<title>${title}</title>
<style>${tokenBlock(options.tokens)}
${VISUALIZE_STYLESHEET}
body{padding:16px}</style>
<script>${buildPreamble(false)}</script>
</head>
<body>
${options.fragment}
</body>
</html>
`;
  const shellBackground = options.tokens['--background'] ?? '#ffffff';
  return `<!doctype html>
<html lang="en" data-theme="${options.theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(SHELL_CSP)}">
<title>${title}</title>
<style>html,body{margin:0;background:${shellBackground}}iframe{display:block;width:100%;height:100vh;border:0}</style>
</head>
<body>
<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" title="${escapeAttribute(options.title ?? 'Visualization')}" srcdoc="${escapeAttribute(inner)}"></iframe>
</body>
</html>
`;
}
