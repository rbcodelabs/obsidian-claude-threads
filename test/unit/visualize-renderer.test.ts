/**
 * @vitest-environment jsdom
 *
 * jsdom has no IntersectionObserver, so the manager falls back to eager
 * mounting here. That is deliberate: it keeps the anchor-swap, height-protocol,
 * and error paths testable without simulating a scroller.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  VisualizeMountManager,
  checkFragmentPath,
  loadFragment,
  popoutFileName,
  themeCacheKey,
  hashString,
  resolveVisualizeTokens,
  toFileUrl,
  INITIAL_HEIGHT,
  MIN_HEIGHT,
  MAX_HEIGHT,
  MAX_FRAGMENT_BYTES,
  type VisualizeFs,
  type VisualizeHost,
} from '../../src/visualizeRenderer';
import { extractVisualizeMarkers, type VisualizeMarker } from '../../src/visualizeMarker';
import { VISUALIZE_MESSAGE_SOURCE } from '../../src/visualizeDocument';

const FRAGMENT = '<div id="demo"><h1>Demo</h1></div>';

function makeFs(overrides: Partial<VisualizeFs> = {}): VisualizeFs {
  return {
    stat: async () => ({ isFile: () => true, size: FRAGMENT.length, mtimeMs: 1000 }),
    readFile: async () => FRAGMENT,
    mkdir: async () => undefined,
    writeFile: async () => undefined,
    tmpDir: () => '/tmp',
    ...overrides,
  };
}

interface Harness {
  manager: VisualizeMountManager;
  scroller: HTMLElement;
  host: VisualizeHost;
  opened: string[];
  notices: string[];
  written: Array<{ target: string; data: string }>;
}

function makeHarness(fsOverrides: Partial<VisualizeFs> = {}, leafHeight = 900): Harness {
  const scroller = document.createElement('div');
  document.body.appendChild(scroller);
  const opened: string[] = [];
  const notices: string[] = [];
  const written: Array<{ target: string; data: string }> = [];
  const fs = makeFs({
    writeFile: async (target: string, data: string) => {
      written.push({ target, data });
    },
    ...fsOverrides,
  });
  const host: VisualizeHost = {
    fs,
    resolveTokens: () => ({ '--background': 'rgb(1, 2, 3)' }),
    theme: () => 'dark',
    openUrl: (url) => opened.push(url),
    notify: (msg) => notices.push(msg),
    leafHeight: () => leafHeight,
  };
  const manager = new VisualizeMountManager(scroller, host);
  manager.attach();
  return { manager, scroller, host, opened, notices, written };
}

/** Render markdown-ish source through the scanner and hydrate the result. */
function hydrateSource(h: Harness, src: string, interactive = true): HTMLElement {
  const { text, markers } = extractVisualizeMarkers(src);
  const el = document.createElement('div');
  el.innerHTML = text
    .split('\n\n')
    .map((block) => `<p>${block}</p>`)
    .join('');
  h.scroller.appendChild(el);
  h.manager.hydrate(el, markers, { interactive });
  return el;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('toFileUrl', () => {
  it('builds a posix file URL', () => {
    expect(toFileUrl('/tmp/a.html')).toBe('file:///tmp/a.html');
  });

  it('normalises windows separators and adds the third slash', () => {
    expect(toFileUrl('C:\\viz\\a.html')).toBe('file:///C:/viz/a.html');
  });
});

describe('checkFragmentPath', () => {
  it('accepts absolute html paths', () => {
    expect(checkFragmentPath('/tmp/a.html')).toBeNull();
    expect(checkFragmentPath('/tmp/a.HTM')).toBeNull();
  });

  it('rejects relative paths', () => {
    expect(checkFragmentPath('a.html')).toMatch(/absolute/);
  });

  it('rejects non-html extensions', () => {
    expect(checkFragmentPath('/tmp/a.svg')).toMatch(/\.html/);
    expect(checkFragmentPath('/tmp/a')).toMatch(/\.html/);
  });
});

describe('popoutFileName', () => {
  it('is stable for a given path', () => {
    expect(popoutFileName('/tmp/chart.html')).toBe(popoutFileName('/tmp/chart.html'));
  });

  it('differs for different paths with the same basename', () => {
    expect(popoutFileName('/a/chart.html')).not.toBe(popoutFileName('/b/chart.html'));
  });

  it('strips characters that are unsafe in a filename', () => {
    expect(popoutFileName('/tmp/a b/../we:ird?.html')).toMatch(/^[A-Za-z0-9._-]+\.html$/);
  });
});

describe('loadFragment', () => {
  it('returns the fragment and a change stamp', async () => {
    const load = await loadFragment(makeFs(), '/tmp/a.html');
    expect(load.fragment).toBe(FRAGMENT);
    expect(load.stamp).toBe(`1000:${FRAGMENT.length}`);
    expect(load.error).toBeUndefined();
  });

  it('rejects a bad path without touching the disk', async () => {
    const stat = vi.fn();
    const load = await loadFragment(makeFs({ stat: stat as never }), 'relative.html');
    expect(load.error).toMatch(/absolute/);
    expect(stat).not.toHaveBeenCalled();
  });

  it('reports a missing file', async () => {
    const load = await loadFragment(
      makeFs({ stat: async () => { throw new Error('ENOENT'); } }),
      '/tmp/a.html',
    );
    expect(load.error).toMatch(/not found/);
  });

  it('rejects a directory', async () => {
    const load = await loadFragment(
      makeFs({ stat: async () => ({ isFile: () => false, size: 0, mtimeMs: 0 }) }),
      '/tmp/a.html',
    );
    expect(load.error).toMatch(/not a file/);
  });

  it('enforces the 2 MB cap', async () => {
    const load = await loadFragment(
      makeFs({ stat: async () => ({ isFile: () => true, size: MAX_FRAGMENT_BYTES + 1, mtimeMs: 0 }) }),
      '/tmp/a.html',
    );
    expect(load.error).toMatch(/too large/);
  });

  it('reports an unreadable file', async () => {
    const load = await loadFragment(
      makeFs({ readFile: async () => { throw new Error('EACCES'); } }),
      '/tmp/a.html',
    );
    expect(load.error).toMatch(/could not be read/);
  });
});

describe('hydrate', () => {
  it('replaces the anchor placeholder with a card', () => {
    const h = makeHarness();
    const el = hydrateSource(h, 'visualize{"path":"/tmp/a.html"}');
    expect(el.querySelector('a.ct-visualize-slot')).toBeNull();
    expect(el.querySelector('.ct-visualize-card')).not.toBeNull();
    expect(h.manager.cardCount).toBe(1);
  });

  it('unwraps the paragraph the anchor was parsed into', () => {
    const h = makeHarness();
    const el = hydrateSource(h, 'visualize{"path":"/tmp/a.html"}');
    expect(el.querySelector('p')).toBeNull();
    expect(el.firstElementChild?.className).toContain('ct-visualize-card');
  });

  it('leaves surrounding prose intact', () => {
    const h = makeHarness();
    const el = hydrateSource(h, 'Before.\n\nvisualize{"path":"/tmp/a.html"}\n\nAfter.');
    expect(el.textContent).toContain('Before.');
    expect(el.textContent).toContain('After.');
  });

  it('marks a wide marker so the breakout rule applies', () => {
    const h = makeHarness();
    const el = hydrateSource(h, 'visualize{"path":"/tmp/a.html","mode":"wide"}');
    expect(el.querySelector('.ct-visualize-card')?.classList.contains('ct-visualize-wide')).toBe(true);
  });

  it('shows the title and exposes the resolved path in the tooltip', () => {
    const h = makeHarness();
    const el = hydrateSource(h, 'visualize{"path":"/tmp/a.html","title":"Revenue"}');
    const title = el.querySelector('.ct-visualize-title') as HTMLElement;
    expect(title.textContent).toBe('Revenue');
    expect(title.title).toBe('/tmp/a.html');
  });

  it('falls back to the file name when no title is given', () => {
    const h = makeHarness();
    const el = hydrateSource(h, 'visualize{"path":"/tmp/chart.html"}');
    expect(el.querySelector('.ct-visualize-title')?.textContent).toBe('chart.html');
  });

  it('handles several markers in one message', () => {
    const h = makeHarness();
    const el = hydrateSource(h, 'visualize{"path":"/a.html"}\n\nmid\n\nvisualize{"path":"/b.html"}');
    expect(el.querySelectorAll('.ct-visualize-card')).toHaveLength(2);
    expect(h.manager.cardCount).toBe(2);
  });

  it('renders inert chrome with no iframe and no pop-out when not interactive', async () => {
    const h = makeHarness();
    const el = hydrateSource(h, 'visualize{"path":"/tmp/a.html"}', false);
    await Promise.resolve();
    const card = el.querySelector('.ct-visualize-card')!;
    expect(card.classList.contains('ct-visualize-static')).toBe(true);
    expect(card.querySelector('iframe')).toBeNull();
    expect(card.querySelector('.ct-visualize-action')).toBeNull();
    expect(h.manager.cardCount).toBe(0);
  });

  it('drops cards whose row was replaced, instead of growing the map on every render', async () => {
    const h = makeHarness();
    const flush = () => new Promise((r) => setTimeout(r, 0));

    const first = hydrateSource(h, 'visualize{"path":"/tmp/a.html"}');
    await flush();
    expect(h.manager.cardCount).toBe(1);

    // What renderMessages() does on a thread switch: the old row is discarded
    // wholesale and a fresh one is built for the same content.
    first.remove();
    hydrateSource(h, 'visualize{"path":"/tmp/a.html"}');
    await flush();

    // Without pruning this is 2, and climbs by one on every switch.
    expect(h.manager.cardCount).toBe(1);
  });

  it('tears down the iframe of a card that left the document', async () => {
    const h = makeHarness();
    const flush = () => new Promise((r) => setTimeout(r, 0));

    const first = hydrateSource(h, 'visualize{"path":"/tmp/a.html"}');
    await flush();
    const staleFrame = first.querySelector('iframe');
    expect(staleFrame).not.toBeNull();

    first.remove();
    hydrateSource(h, 'visualize{"path":"/tmp/a.html"}');
    await flush();

    // The detached row must not still be holding a live frame — that frame has
    // its own scripts, timers and CDN requests running.
    expect(first.querySelector('iframe')).toBeNull();
  });

  it('drops an orphan slot whose marker index does not exist', () => {
    const h = makeHarness();
    const el = document.createElement('div');
    el.innerHTML = '<p><a class="ct-visualize-slot" data-ct-viz="7" href="#">x</a></p>';
    h.scroller.appendChild(el);
    h.manager.hydrate(el, [{ index: 0, path: '/a.html' }], { interactive: true });
    expect(el.querySelector('a.ct-visualize-slot')).toBeNull();
    expect(el.querySelector('.ct-visualize-card')).toBeNull();
  });
});

describe('iframe mounting', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('mounts with allow-scripts and nothing else', async () => {
    const h = makeHarness();
    const el = hydrateSource(h, 'visualize{"path":"/tmp/a.html"}');
    await flush();
    const iframe = el.querySelector('iframe')!;
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-modals');
    expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('wraps the fragment in a full document with its own CSP', async () => {
    const h = makeHarness();
    const el = hydrateSource(h, 'visualize{"path":"/tmp/a.html"}');
    await flush();
    const srcdoc = el.querySelector('iframe')!.getAttribute('srcdoc')!;
    expect(srcdoc.startsWith('<!doctype html>')).toBe(true);
    expect(srcdoc).toContain('http-equiv="Content-Security-Policy"');
    expect(srcdoc).toContain(FRAGMENT);
    expect(srcdoc).toContain('--background:rgb(1, 2, 3)');
  });

  it('starts at the initial height', async () => {
    const h = makeHarness();
    const el = hydrateSource(h, 'visualize{"path":"/tmp/a.html"}');
    await flush();
    expect((el.querySelector('.ct-visualize-body') as HTMLElement).style.height).toBe(`${INITIAL_HEIGHT}px`);
  });

  it('reads each distinct file once and reuses the built document', async () => {
    const readFile = vi.fn(async () => FRAGMENT);
    const h = makeHarness({ readFile });
    hydrateSource(h, 'visualize{"path":"/tmp/a.html"}');
    await flush();
    hydrateSource(h, 'visualize{"path":"/tmp/a.html"}');
    await flush();
    // The file is re-read (it may have changed), but the built document is
    // served from cache — same path, same stamp, same theme.
    expect(readFile).toHaveBeenCalledTimes(2);
    const frames = Array.from(document.querySelectorAll('iframe'));
    expect(frames).toHaveLength(2);
    expect(frames[0].getAttribute('srcdoc')).toBe(frames[1].getAttribute('srcdoc'));
  });

  it('shows an error chip and no iframe when the file is missing', async () => {
    const h = makeHarness({ stat: async () => { throw new Error('ENOENT'); } });
    const el = hydrateSource(h, 'visualize{"path":"/tmp/gone.html"}');
    await flush();
    expect(el.querySelector('.ct-visualize-error')?.textContent).toMatch(/not found/);
    expect(el.querySelector('iframe')).toBeNull();
  });

  it('shows an error chip when the fragment exceeds the size cap', async () => {
    const h = makeHarness({ stat: async () => ({ isFile: () => true, size: MAX_FRAGMENT_BYTES + 1, mtimeMs: 0 }) });
    const el = hydrateSource(h, 'visualize{"path":"/tmp/big.html"}');
    await flush();
    expect(el.querySelector('.ct-visualize-error')?.textContent).toMatch(/too large/);
  });
});

describe('height protocol', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  function postFrom(source: Window | null, payload: Record<string, unknown>): void {
    const event = new MessageEvent('message', { data: payload });
    // jsdom does not let MessageEvent.source be set through the constructor.
    Object.defineProperty(event, 'source', { value: source });
    window.dispatchEvent(event);
  }

  it('applies a height reported by the frame that owns the card', async () => {
    const h = makeHarness();
    const el = hydrateSource(h, 'visualize{"path":"/tmp/a.html"}');
    await flush();
    const iframe = el.querySelector('iframe')!;
    postFrom(iframe.contentWindow, { source: VISUALIZE_MESSAGE_SOURCE, type: 'height', height: 480 });
    expect((el.querySelector('.ct-visualize-body') as HTMLElement).style.height).toBe('480px');
  });

  it('ignores a height message from a window that owns no card', async () => {
    const h = makeHarness();
    const el = hydrateSource(h, 'visualize{"path":"/tmp/a.html"}');
    await flush();
    const impostor = document.createElement('iframe');
    document.body.appendChild(impostor);
    postFrom(impostor.contentWindow, { source: VISUALIZE_MESSAGE_SOURCE, type: 'height', height: 999 });
    expect((el.querySelector('.ct-visualize-body') as HTMLElement).style.height).toBe(`${INITIAL_HEIGHT}px`);
  });

  it('ignores a message that is not ours', async () => {
    const h = makeHarness();
    const el = hydrateSource(h, 'visualize{"path":"/tmp/a.html"}');
    await flush();
    const iframe = el.querySelector('iframe')!;
    postFrom(iframe.contentWindow, { source: 'something-else', type: 'height', height: 999 });
    postFrom(iframe.contentWindow, { type: 'height', height: 999 });
    postFrom(iframe.contentWindow, 'height:999' as unknown as Record<string, unknown>);
    expect((el.querySelector('.ct-visualize-body') as HTMLElement).style.height).toBe(`${INITIAL_HEIGHT}px`);
  });

  it('clamps to the floor', async () => {
    const h = makeHarness();
    const el = hydrateSource(h, 'visualize{"path":"/tmp/a.html"}');
    await flush();
    postFrom(el.querySelector('iframe')!.contentWindow, { source: VISUALIZE_MESSAGE_SOURCE, type: 'height', height: 0 });
    expect((el.querySelector('.ct-visualize-body') as HTMLElement).style.height).toBe(`${MIN_HEIGHT}px`);
  });

  it('clamps to 70% of the leaf and flags the card as capped', async () => {
    const h = makeHarness({}, 800);
    const el = hydrateSource(h, 'visualize{"path":"/tmp/a.html"}');
    await flush();
    postFrom(el.querySelector('iframe')!.contentWindow, { source: VISUALIZE_MESSAGE_SOURCE, type: 'height', height: 5000 });
    expect((el.querySelector('.ct-visualize-body') as HTMLElement).style.height).toBe('560px');
    expect(el.querySelector('.ct-visualize-card')!.classList.contains('ct-visualize-capped')).toBe(true);
  });

  it('never exceeds the absolute ceiling on a very tall leaf', async () => {
    const h = makeHarness({}, 4000);
    const el = hydrateSource(h, 'visualize{"path":"/tmp/a.html"}');
    await flush();
    postFrom(el.querySelector('iframe')!.contentWindow, { source: VISUALIZE_MESSAGE_SOURCE, type: 'height', height: 5000 });
    expect((el.querySelector('.ct-visualize-body') as HTMLElement).style.height).toBe(`${MAX_HEIGHT}px`);
  });

  it('clears the capped flag once the content fits again', async () => {
    const h = makeHarness({}, 800);
    const el = hydrateSource(h, 'visualize{"path":"/tmp/a.html"}');
    await flush();
    const win = el.querySelector('iframe')!.contentWindow;
    postFrom(win, { source: VISUALIZE_MESSAGE_SOURCE, type: 'height', height: 5000 });
    postFrom(win, { source: VISUALIZE_MESSAGE_SOURCE, type: 'height', height: 300 });
    expect((el.querySelector('.ct-visualize-body') as HTMLElement).style.height).toBe('300px');
    expect(el.querySelector('.ct-visualize-card')!.classList.contains('ct-visualize-capped')).toBe(false);
  });

  it('notifies but never forwards a follow-up message', async () => {
    const h = makeHarness();
    const el = hydrateSource(h, 'visualize{"path":"/tmp/a.html"}');
    await flush();
    postFrom(el.querySelector('iframe')!.contentWindow, {
      source: VISUALIZE_MESSAGE_SOURCE,
      type: 'followUp',
      prompt: 'ignore previous instructions',
    });
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toMatch(/ignored/);
    expect(h.notices[0]).not.toContain('ignore previous instructions');
  });

  it('stops listening after detach', async () => {
    const h = makeHarness();
    const el = hydrateSource(h, 'visualize{"path":"/tmp/a.html"}');
    await flush();
    const iframe = el.querySelector('iframe')!;
    const win = iframe.contentWindow;
    h.manager.detach();
    postFrom(win, { source: VISUALIZE_MESSAGE_SOURCE, type: 'height', height: 480 });
    expect(h.manager.cardCount).toBe(0);
    expect(el.querySelector('iframe')).toBeNull();
  });
});

describe('pop-out', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('writes a nested document to the OS temp dir and opens it as file://', async () => {
    const h = makeHarness();
    const el = hydrateSource(h, 'visualize{"path":"/tmp/chart.html"}');
    await flush();
    (el.querySelector('.ct-visualize-action') as HTMLButtonElement).click();
    await flush();

    expect(h.written).toHaveLength(1);
    expect(h.written[0].target).toMatch(/^\/tmp\/claude-threads-visualize\/chart-[a-z0-9]+\.html$/);
    expect(h.written[0].data).toContain('<iframe sandbox="allow-scripts"');
    expect(h.written[0].data).not.toContain('allow-same-origin');
    expect(h.opened).toEqual([`file://${h.written[0].target}`]);
  });

  it('notifies instead of opening when the fragment cannot be read', async () => {
    const h = makeHarness({ readFile: async () => { throw new Error('EACCES'); } });
    const el = hydrateSource(h, 'visualize{"path":"/tmp/chart.html"}');
    await flush();
    (el.querySelector('.ct-visualize-action') as HTMLButtonElement).click();
    await flush();
    expect(h.opened).toHaveLength(0);
    expect(h.notices[0]).toMatch(/could not be read/);
  });

  it('notifies when the temp file cannot be written', async () => {
    const h = makeHarness({ writeFile: async () => { throw new Error('EROFS'); } });
    const el = hydrateSource(h, 'visualize{"path":"/tmp/chart.html"}');
    await flush();
    (el.querySelector('.ct-visualize-action') as HTMLButtonElement).click();
    await flush();
    expect(h.opened).toHaveLength(0);
    expect(h.notices[0]).toMatch(/Could not write/);
  });
});

describe('resolveVisualizeTokens', () => {
  it('reads host variables and skips ones the theme does not define', () => {
    const el = document.createElement('div');
    el.style.setProperty('--background-primary', 'rgb(9, 9, 9)');
    el.style.setProperty('--text-normal', 'rgb(8, 8, 8)');
    document.body.appendChild(el);
    const tokens = resolveVisualizeTokens(el);
    expect(tokens['--background']).toBe('rgb(9, 9, 9)');
    expect(tokens['--foreground']).toBe('rgb(8, 8, 8)');
    expect(tokens['--purple']).toBeUndefined();
  });

  it('falls back through the candidate list in order', () => {
    const el = document.createElement('div');
    // --background-secondary-alt is absent, so --popover falls through.
    el.style.setProperty('--background-secondary', 'rgb(7, 7, 7)');
    document.body.appendChild(el);
    expect(resolveVisualizeTokens(el)['--popover']).toBe('rgb(7, 7, 7)');
  });
});

describe('marker plumbing end to end', () => {
  it('carries mode and title from raw text through to the card', () => {
    const h = makeHarness();
    const markers: VisualizeMarker[] = extractVisualizeMarkers(
      'visualize{"path":"/tmp/a.html","mode":"wide","title":"Q3"}',
    ).markers;
    const el = document.createElement('div');
    el.innerHTML = '<p><a class="ct-visualize-slot" data-ct-viz="0" href="#">Q3</a></p>';
    h.scroller.appendChild(el);
    h.manager.hydrate(el, markers, { interactive: true });
    const card = el.querySelector('.ct-visualize-card')!;
    expect(card.classList.contains('ct-visualize-wide')).toBe(true);
    expect(card.querySelector('.ct-visualize-title')?.textContent).toBe('Q3');
  });
});

describe('themeCacheKey', () => {
  it('is stable for the same theme and tokens', () => {
    const t = { '--background': 'rgb(1, 1, 1)', '--primary': 'rgb(2, 2, 2)' };
    expect(themeCacheKey('dark', t)).toBe(themeCacheKey('dark', { ...t }));
  });

  it('differs when the polarity differs', () => {
    const t = { '--background': 'rgb(1, 1, 1)' };
    expect(themeCacheKey('dark', t)).not.toBe(themeCacheKey('light', t));
  });

  it('differs between two themes of the same polarity', () => {
    // Two dark themes with different accents must not share a built document.
    expect(themeCacheKey('dark', { '--primary': 'rgb(88, 101, 242)' })).not.toBe(
      themeCacheKey('dark', { '--primary': 'rgb(240, 80, 120)' }),
    );
  });

  it('ignores keys outside the token contract', () => {
    expect(themeCacheKey('dark', { '--background': 'x', '--not-a-token': 'a' })).toBe(
      themeCacheKey('dark', { '--background': 'x', '--not-a-token': 'b' }),
    );
  });
});

describe('document cache invalidation', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('rebuilds the document when the host theme changes', async () => {
    let background = 'rgb(30, 30, 30)';
    let theme: 'dark' | 'light' = 'dark';
    const scroller = document.createElement('div');
    document.body.appendChild(scroller);
    const manager = new VisualizeMountManager(scroller, {
      fs: makeFs(),
      resolveTokens: () => ({ '--background': background }),
      theme: () => theme,
      openUrl: () => {},
      notify: () => {},
      leafHeight: () => 900,
    });
    manager.attach();

    const mount = async () => {
      const el = document.createElement('div');
      el.innerHTML = '<p><a class="ct-visualize-slot" data-ct-viz="0" href="#">a</a></p>';
      scroller.appendChild(el);
      manager.hydrate(el, [{ index: 0, path: '/tmp/a.html' }], { interactive: true });
      await flush();
      return el.querySelector('iframe')!.getAttribute('srcdoc')!;
    };

    const dark = await mount();
    expect(dark).toContain('--background:rgb(30, 30, 30)');

    theme = 'light';
    background = 'rgb(255, 255, 255)';
    const light = await mount();
    expect(light).toContain('--background:rgb(255, 255, 255)');
    expect(light).toContain('data-theme="light"');
  });

  it('rebuilds when the file changes on disk even though the theme has not', async () => {
    let body = '<div>v1</div>';
    let mtime = 1000;
    const scroller = document.createElement('div');
    document.body.appendChild(scroller);
    const manager = new VisualizeMountManager(scroller, {
      fs: makeFs({
        stat: async () => ({ isFile: () => true, size: body.length, mtimeMs: mtime }),
        readFile: async () => body,
      }),
      resolveTokens: () => ({}),
      theme: () => 'dark',
      openUrl: () => {},
      notify: () => {},
      leafHeight: () => 900,
    });
    manager.attach();

    const mount = async () => {
      const el = document.createElement('div');
      el.innerHTML = '<p><a class="ct-visualize-slot" data-ct-viz="0" href="#">a</a></p>';
      scroller.appendChild(el);
      manager.hydrate(el, [{ index: 0, path: '/tmp/a.html' }], { interactive: true });
      await flush();
      return el.querySelector('iframe')!.getAttribute('srcdoc')!;
    };

    expect(await mount()).toContain('<div>v1</div>');
    body = '<div>v2</div>';
    mtime = 2000;
    expect(await mount()).toContain('<div>v2</div>');
  });
});

describe('hashString', () => {
  it('is deterministic and differs for different inputs', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
  });
});
