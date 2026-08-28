import { describe, it, expect } from 'vitest';
import {
  buildInlineDocument,
  buildPopoutDocument,
  buildPreamble,
  escapeAttribute,
  escapeText,
  FRAME_CSP,
  SHELL_CSP,
  TOKEN_SOURCES,
  VISUALIZE_STYLESHEET,
  VISUALIZE_MESSAGE_SOURCE,
} from '../../src/visualizeDocument';

const TOKENS: Record<string, string> = {
  '--background': 'rgb(30, 30, 30)',
  '--foreground': 'rgb(220, 221, 222)',
  '--primary': 'rgb(88, 101, 242)',
};

const FRAGMENT = '<div id="demo"><h1>Demo</h1></div>';

describe('CSP policies', () => {
  it('locks the frame down to the documented CDN allowlist', () => {
    expect(FRAME_CSP).toContain("default-src 'none'");
    expect(FRAME_CSP).toContain("frame-src 'none'");
    expect(FRAME_CSP).toContain("object-src 'none'");
    expect(FRAME_CSP).toContain("base-uri 'none'");
    expect(FRAME_CSP).toContain("form-action 'none'");
    expect(FRAME_CSP).toContain('connect-src blob: data:');
    for (const origin of [
      'https://cdnjs.cloudflare.com',
      'https://cdn.jsdelivr.net',
      'https://esm.sh',
      'https://fonts.bunny.net',
      'https://fonts.googleapis.com',
      'https://fonts.gstatic.com',
      'https://unpkg.com',
    ]) {
      expect(FRAME_CSP).toContain(origin);
    }
  });

  it('never grants the frame arbitrary network access', () => {
    const connect = FRAME_CSP.split('; ').find((d) => d.startsWith('connect-src'));
    expect(connect).toBe('connect-src blob: data:');
  });

  it('differs from the shell policy only in frame-src', () => {
    expect(SHELL_CSP).toBe(FRAME_CSP.replace("frame-src 'none'", "frame-src 'self'"));
  });
});

describe('buildPreamble', () => {
  it('shadows both storage objects, which throw in an opaque origin', () => {
    const preamble = buildPreamble(false);
    expect(preamble).toContain("['localStorage', 'sessionStorage']");
    expect(preamble).toContain('Object.defineProperty(window, name');
    expect(preamble).toContain('memoryStorage()');
  });

  it('installs a frozen, inert window.openai that only posts to the parent', () => {
    const preamble = buildPreamble(false);
    expect(preamble).toContain('Object.freeze(');
    expect(preamble).toContain('sendFollowUpMessage');
    expect(preamble).toContain("post({ type: 'followUp'");
  });

  it('measures document.body, never documentElement', () => {
    const preamble = buildPreamble(true);
    expect(preamble).toContain('document.body.scrollHeight');
    expect(preamble).not.toContain('documentElement');
  });

  it('re-reports late so async CDN draws are not clipped', () => {
    expect(buildPreamble(true)).toContain('[120, 400, 1200, 3000]');
  });

  it('omits the height protocol when it has no embedder', () => {
    const preamble = buildPreamble(false);
    expect(preamble).not.toContain('scrollHeight');
    expect(preamble).not.toContain('ResizeObserver');
  });

  it('tags every message with the shared source string', () => {
    expect(buildPreamble(true)).toContain(JSON.stringify(VISUALIZE_MESSAGE_SOURCE));
  });

  it('never contains a script end tag that would break out of its <script> host', () => {
    expect(buildPreamble(true).toLowerCase()).not.toContain('</script');
  });
});

describe('escaping helpers', () => {
  it('escapes every attribute-breaking character', () => {
    expect(escapeAttribute(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('escapes text content', () => {
    expect(escapeText('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;');
  });
});

describe('buildInlineDocument', () => {
  const doc = buildInlineDocument({ fragment: FRAGMENT, theme: 'dark', tokens: TOKENS, title: 'Demo' });

  it('produces a complete document around a bare fragment', () => {
    expect(doc.startsWith('<!doctype html>')).toBe(true);
    expect(doc).toContain('<body>');
    expect(doc).toContain(FRAGMENT);
  });

  it('always ships its own CSP meta tag', () => {
    // about:srcdoc inherits the host policy container, which only sets
    // style-src — without this tag the fragment gets unrestricted script-src.
    expect(doc).toContain(`<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(FRAME_CSP)}">`);
  });

  it('mirrors the host theme onto the root element', () => {
    expect(doc).toContain('<html lang="en" data-theme="dark">');
    expect(buildInlineDocument({ fragment: '', theme: 'light', tokens: TOKENS })).toContain('data-theme="light"');
  });

  it('emits literal token values, never var() references', () => {
    expect(doc).toContain('--background:rgb(30, 30, 30)');
    expect(doc).toContain('--foreground:rgb(220, 221, 222)');
    expect(doc).not.toContain('var(--background-primary)');
  });

  it('falls back to a bundled value for every unresolved token', () => {
    const bare = buildInlineDocument({ fragment: '', theme: 'light', tokens: {} });
    for (const { token, fallback } of TOKEN_SOURCES) {
      expect(bare).toContain(`${token}:${fallback}`);
    }
  });

  it('never nests a second frame', () => {
    // A nested frame would make height messages arrive from a grandchild
    // window and fail the event.source === iframe.contentWindow check.
    expect(doc).not.toContain('<iframe');
  });

  it('inlines the stylesheet and the height-reporting preamble', () => {
    expect(doc).toContain(VISUALIZE_STYLESHEET);
    expect(doc).toContain('document.body.scrollHeight');
  });

  it('escapes the title', () => {
    const evil = buildInlineDocument({ fragment: '', theme: 'dark', tokens: {}, title: '</title><script>x()</script>' });
    expect(evil).toContain('<title>&lt;/title&gt;&lt;script&gt;x()&lt;/script&gt;</title>');
  });

  it('is stable for the same inputs', () => {
    expect(buildInlineDocument({ fragment: FRAGMENT, theme: 'dark', tokens: TOKENS, title: 'Demo' })).toBe(doc);
  });
});

describe('buildPopoutDocument', () => {
  const doc = buildPopoutDocument({ fragment: FRAGMENT, theme: 'dark', tokens: TOKENS, title: 'Demo' });

  it('nests a sandboxed frame inside a shell', () => {
    // The pop-out loads as a top-level file:// page, so the inner frame is the
    // only isolation boundary the fragment has.
    expect(doc).toContain('<iframe sandbox="allow-scripts" referrerpolicy="no-referrer"');
    expect(doc).toContain(`content="${escapeAttribute(SHELL_CSP)}"`);
  });

  it('never grants the inner frame same-origin or modal privileges', () => {
    expect(doc).not.toContain('allow-same-origin');
    expect(doc).not.toContain('allow-modals');
  });

  it('carries the frame CSP into the escaped inner document', () => {
    expect(doc).toContain(escapeAttribute(escapeAttribute(FRAME_CSP)));
  });

  it('escapes the inner document so it cannot break out of srcdoc', () => {
    const evil = buildPopoutDocument({ fragment: '<p title="a">x</p>', theme: 'dark', tokens: {} });
    const srcdoc = /srcdoc="([^"]*)"/.exec(evil);
    expect(srcdoc).not.toBeNull();
    expect(srcdoc![1]).toContain('&lt;p title=&quot;a&quot;&gt;');
  });

  it('omits the height protocol, which has no embedder to talk to', () => {
    // The literal string also appears in a stylesheet comment, so assert on the
    // protocol's own payload instead.
    expect(doc).not.toContain("type: 'height'");
    expect(doc).not.toContain('ResizeObserver');
  });

  it('paints the shell with the resolved host background', () => {
    expect(doc).toContain('background:rgb(30, 30, 30)');
  });
});
