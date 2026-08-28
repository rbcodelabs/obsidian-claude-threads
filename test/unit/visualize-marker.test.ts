import { describe, it, expect } from 'vitest';
import {
  extractVisualizeMarkers,
  scanBalancedObject,
  validateMarkerPayload,
  basename,
  MAX_TITLE_LENGTH,
  VISUALIZE_SLOT_CLASS,
} from '../../src/visualizeMarker';

describe('scanBalancedObject', () => {
  it('returns the index past the matching brace', () => {
    expect(scanBalancedObject('{"a":1}', 0)).toBe(7);
  });

  it('ignores braces inside strings', () => {
    const src = '{"title":"a {b} c"}';
    expect(scanBalancedObject(src, 0)).toBe(src.length);
  });

  it('ignores escaped quotes', () => {
    const src = '{"title":"say \\"hi\\" {"}';
    expect(scanBalancedObject(src, 0)).toBe(src.length);
  });

  it('handles nested objects', () => {
    const src = '{"a":{"b":{"c":1}}}';
    expect(scanBalancedObject(src, 0)).toBe(src.length);
  });

  it('returns -1 when the object never closes', () => {
    expect(scanBalancedObject('{"path":"/a', 0)).toBe(-1);
  });

  it('returns -1 when the start index is not a brace', () => {
    expect(scanBalancedObject('x{"a":1}', 0)).toBe(-1);
  });
});

describe('validateMarkerPayload', () => {
  it('accepts an absolute posix path', () => {
    expect(validateMarkerPayload({ path: '/tmp/a.html' })).toEqual({ path: '/tmp/a.html' });
  });

  it('accepts a windows drive path', () => {
    expect(validateMarkerPayload({ path: 'C:\\viz\\a.html' })).toEqual({ path: 'C:\\viz\\a.html' });
  });

  it('rejects a relative path', () => {
    expect(validateMarkerPayload({ path: 'a.html' })).toBeNull();
  });

  it('rejects a missing or non-string path', () => {
    expect(validateMarkerPayload({})).toBeNull();
    expect(validateMarkerPayload({ path: 42 })).toBeNull();
  });

  it('rejects non-objects', () => {
    expect(validateMarkerPayload(null)).toBeNull();
    expect(validateMarkerPayload('/tmp/a.html')).toBeNull();
    expect(validateMarkerPayload([{ path: '/tmp/a.html' }])).toBeNull();
  });

  it('keeps mode only when it is exactly "wide"', () => {
    expect(validateMarkerPayload({ path: '/a.html', mode: 'wide' })).toEqual({ path: '/a.html', mode: 'wide' });
    expect(validateMarkerPayload({ path: '/a.html', mode: 'tall' })).toEqual({ path: '/a.html' });
    expect(validateMarkerPayload({ path: '/a.html', mode: 5 })).toEqual({ path: '/a.html' });
  });

  it('truncates a long title and drops an empty one', () => {
    const long = 'x'.repeat(400);
    expect(validateMarkerPayload({ path: '/a.html', title: long })?.title).toHaveLength(MAX_TITLE_LENGTH);
    expect(validateMarkerPayload({ path: '/a.html', title: '   ' })?.title).toBeUndefined();
    expect(validateMarkerPayload({ path: '/a.html', title: 7 })?.title).toBeUndefined();
  });
});

describe('basename', () => {
  it('handles posix, windows and trailing separators', () => {
    expect(basename('/a/b/c.html')).toBe('c.html');
    expect(basename('C:\\a\\b\\c.html')).toBe('c.html');
    expect(basename('/a/b/')).toBe('b');
    expect(basename('c.html')).toBe('c.html');
  });
});

describe('extractVisualizeMarkers', () => {
  it('returns the source untouched when there is no marker', () => {
    const src = 'Just some prose.\n\nMore prose.';
    expect(extractVisualizeMarkers(src)).toEqual({ text: src, markers: [] });
  });

  it('replaces a marker line with an anchor placeholder', () => {
    const { text, markers } = extractVisualizeMarkers(
      'Here it is.\n\nvisualize{"path":"/tmp/chart.html"}\n\nDone.',
    );
    expect(markers).toEqual([{ index: 0, path: '/tmp/chart.html' }]);
    expect(text).toContain(`<a class="${VISUALIZE_SLOT_CLASS}" data-ct-viz="0" href="#">chart.html</a>`);
    expect(text).not.toContain('visualize{');
    expect(text.startsWith('Here it is.\n\n')).toBe(true);
    expect(text.endsWith('\n\nDone.')).toBe(true);
  });

  it('captures mode and title and uses the title as the anchor label', () => {
    const { text, markers } = extractVisualizeMarkers(
      'visualize{"path":"/tmp/a.html","mode":"wide","title":"Revenue by region"}',
    );
    expect(markers).toEqual([
      { index: 0, path: '/tmp/a.html', mode: 'wide', title: 'Revenue by region' },
    ]);
    expect(text).toContain('>Revenue by region</a>');
  });

  it('escapes HTML in the anchor label', () => {
    const { text } = extractVisualizeMarkers('visualize{"path":"/tmp/a.html","title":"<img> & \\"x\\""}');
    expect(text).toContain('&lt;img&gt; &amp; &quot;x&quot;');
    expect(text).not.toContain('<img>');
  });

  it('numbers multiple markers in document order', () => {
    const { markers } = extractVisualizeMarkers(
      ['visualize{"path":"/a.html"}', 'text', 'visualize{"path":"/b.html"}'].join('\n'),
    );
    expect(markers.map((m) => [m.index, m.path])).toEqual([
      [0, '/a.html'],
      [1, '/b.html'],
    ]);
  });

  it('allows up to three leading spaces but not four', () => {
    expect(extractVisualizeMarkers('   visualize{"path":"/a.html"}').markers).toHaveLength(1);
    expect(extractVisualizeMarkers('    visualize{"path":"/a.html"}').markers).toHaveLength(0);
  });

  it('preserves CRLF line endings', () => {
    const { text } = extractVisualizeMarkers('a\r\nvisualize{"path":"/a.html"}\r\nb');
    expect(text).toBe(`a\r\n<a class="${VISUALIZE_SLOT_CLASS}" data-ct-viz="0" href="#">a.html</a>\r\nb`);
  });

  // ── Fenced code blocks ────────────────────────────────────────────────────

  it('ignores a marker inside a backtick fence', () => {
    const src = ['```text', 'visualize{"path":"/a.html"}', '```'].join('\n');
    expect(extractVisualizeMarkers(src)).toEqual({ text: src, markers: [] });
  });

  it('ignores a marker inside a tilde fence', () => {
    const src = ['~~~', 'visualize{"path":"/a.html"}', '~~~'].join('\n');
    expect(extractVisualizeMarkers(src).markers).toHaveLength(0);
  });

  it('does not close a long fence with a shorter one', () => {
    const src = ['````', '```', 'visualize{"path":"/a.html"}', '````'].join('\n');
    expect(extractVisualizeMarkers(src).markers).toHaveLength(0);
  });

  it('does not close a backtick fence with tildes', () => {
    const src = ['```', '~~~', 'visualize{"path":"/a.html"}', '```'].join('\n');
    expect(extractVisualizeMarkers(src).markers).toHaveLength(0);
  });

  it('picks up a marker after a fence has closed', () => {
    const src = ['```text', 'visualize{"path":"/a.html"}', '```', '', 'visualize{"path":"/b.html"}'].join('\n');
    const { markers } = extractVisualizeMarkers(src);
    expect(markers).toEqual([{ index: 0, path: '/b.html' }]);
  });

  it('ignores a marker in a 4-space indented code block', () => {
    const src = ['Example:', '', '    visualize{"path":"/a.html"}'].join('\n');
    expect(extractVisualizeMarkers(src).markers).toHaveLength(0);
  });

  it('ignores a marker inside inline code', () => {
    const src = 'Emit `visualize{"path":"/a.html"}` on its own line.';
    expect(extractVisualizeMarkers(src)).toEqual({ text: src, markers: [] });
  });

  // ── Malformed input ───────────────────────────────────────────────────────

  it('leaves malformed JSON as literal text when settled', () => {
    const src = 'visualize{"path": /a.html}';
    expect(extractVisualizeMarkers(src)).toEqual({ text: src, markers: [] });
  });

  it('leaves an unterminated object as literal text when settled', () => {
    const src = 'visualize{"path":"/a.html"';
    expect(extractVisualizeMarkers(src)).toEqual({ text: src, markers: [] });
  });

  it('leaves a relative path as literal text', () => {
    const src = 'visualize{"path":"chart.html"}';
    expect(extractVisualizeMarkers(src)).toEqual({ text: src, markers: [] });
  });

  it('rejects a line with trailing prose after the object', () => {
    const src = 'visualize{"path":"/a.html"} and then some';
    expect(extractVisualizeMarkers(src)).toEqual({ text: src, markers: [] });
  });

  it('accepts trailing whitespace after the object', () => {
    expect(extractVisualizeMarkers('visualize{"path":"/a.html"}   ').markers).toHaveLength(1);
  });

  // ── Streaming ─────────────────────────────────────────────────────────────

  it('suppresses a trailing partial marker while streaming', () => {
    const src = 'Here it is.\n\nvisualize{"path":"/tmp/ch';
    const { text, markers } = extractVisualizeMarkers(src, { streaming: true });
    expect(markers).toHaveLength(0);
    expect(text).toBe('Here it is.\n\n');
  });

  it('suppresses the bare token while streaming', () => {
    const { text } = extractVisualizeMarkers('Here it is.\n\nvisualize', { streaming: true });
    expect(text).toBe('Here it is.\n\n');
  });

  it('does not suppress ordinary prose that starts with the word', () => {
    const src = 'Here it is.\n\nvisualize this for me';
    expect(extractVisualizeMarkers(src, { streaming: true }).text).toBe(src);
  });

  it('only suppresses the final line, not an earlier malformed one', () => {
    const src = 'visualize{"path":"/tmp/a\nmore text';
    expect(extractVisualizeMarkers(src, { streaming: true }).text).toBe(src);
  });

  it('renders a complete marker even while streaming', () => {
    const { markers } = extractVisualizeMarkers('visualize{"path":"/a.html"}\n', { streaming: true });
    expect(markers).toHaveLength(1);
  });

  it('leaves a malformed marker visible once settled', () => {
    const src = 'visualize{"path":"/tmp/ch';
    expect(extractVisualizeMarkers(src, { streaming: false }).text).toBe(src);
  });
});
