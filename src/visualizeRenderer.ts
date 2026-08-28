/**
 * visualizeRenderer.ts
 *
 * Turns the anchor placeholders left behind by `visualizeMarker.ts` into live,
 * sandboxed visualization cards inside an assistant message bubble.
 *
 * Desktop only. All filesystem access goes through the injected
 * {@link VisualizeFs} seam — this module must never import `fs`, `path`, or
 * `os` at the top level. Obsidian Mobile's `require()` returns null for Node
 * built-ins, so a top-level import here would crash the plugin on load for
 * every mobile user (guarded by test/unit/bundle-safety.test.ts).
 */
import { setIcon, setTooltip } from 'obsidian';
import {
  VISUALIZE_SLOT_ATTR,
  VISUALIZE_SLOT_CLASS,
  basename,
  type VisualizeMarker,
} from './visualizeMarker';
import {
  TOKEN_SOURCES,
  VISUALIZE_MESSAGE_SOURCE,
  buildInlineDocument,
  buildPopoutDocument,
  type VisualizeTheme,
} from './visualizeDocument';

/** Hard ceiling on fragment size. Anything larger is a mistake, not a chart. */
export const MAX_FRAGMENT_BYTES = 2 * 1024 * 1024;

/** Height used before the frame has reported anything. */
export const INITIAL_HEIGHT = 320;
/** Floor, so a frame that reports 0 (hidden, or still parsing) never collapses. */
export const MIN_HEIGHT = 180;
/** Absolute ceiling, further clamped to 70% of the leaf so a card never fills the pane. */
export const MAX_HEIGHT = 720;

/** Distance outside the scroller at which a card mounts, and beyond which it unmounts. */
const MOUNT_MARGIN_PX = 400;
const UNMOUNT_MARGIN_PX = 1600;

/** Minimal `fs/promises` surface, injected so this module stays Node-free. */
export interface VisualizeFs {
  stat(target: string): Promise<{ isFile(): boolean; size: number; mtimeMs: number }>;
  readFile(target: string, encoding: 'utf8'): Promise<string>;
  mkdir(target: string, options: { recursive: true }): Promise<unknown>;
  writeFile(target: string, data: string, encoding: 'utf8'): Promise<unknown>;
  /** Absolute path of the OS temp directory (`os.tmpdir()`). */
  tmpDir(): string;
}

export interface VisualizeHost {
  fs: VisualizeFs;
  /** Resolve the host's CSS variables to literal values for the current theme. */
  resolveTokens(): Record<string, string>;
  /** Current host theme. */
  theme(): VisualizeTheme;
  /** Open a URL, preferring the in-app Web Viewer. */
  openUrl(url: string): void;
  /** Surface a transient message to the user. */
  notify(message: string): void;
  /** Pixel height of the containing workspace leaf, for the max-height clamp. */
  leafHeight(): number;
}

interface MountedCard {
  marker: VisualizeMarker;
  cardEl: HTMLElement;
  bodyEl: HTMLElement;
  iframe: HTMLIFrameElement | null;
  /** Last height the frame reported, retained across unmounts so layout is stable. */
  height: number;
  /** Generation counter; a stale async load must never touch a remounted card. */
  generation: number;
  loading: boolean;
}

/** A `file://` URL for an absolute filesystem path, without importing `path`. */
export function toFileUrl(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, '/');
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;
}

/**
 * Reject anything that is not plausibly a visualization fragment before we
 * touch the disk. Returns an error message, or null when the path is usable.
 */
export function checkFragmentPath(target: string): string | null {
  if (!/^([A-Za-z]:[\\/]|\/)/.test(target)) return 'Visualization path must be absolute.';
  if (!/\.html?$/i.test(target)) return 'Visualization must be an .html file.';
  return null;
}

/**
 * djb2. A hash, not a crypto digest: it only has to distinguish cache entries
 * and temp filenames, and `crypto` is a Node built-in this module cannot import.
 */
export function hashString(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

/** Stable, filesystem-safe name for a pop-out file derived from its source path. */
export function popoutFileName(target: string): string {
  const slug = basename(target).replace(/\.html?$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 48);
  return `${slug || 'visualization'}-${hashString(target)}.html`;
}

/**
 * Cache identity for a built document's appearance.
 *
 * Hashes the resolved values, not just `'dark'`/`'light'`: two dark themes have
 * different accents, and keying on polarity alone would serve one theme's
 * document to the other until the fragment file happened to change on disk.
 */
export function themeCacheKey(theme: VisualizeTheme, tokens: Readonly<Record<string, string>>): string {
  const stable = TOKEN_SOURCES.map(({ token }) => `${token}=${tokens[token] ?? ''}`).join(';');
  return `${theme}:${hashString(stable)}`;
}

export interface FragmentLoad {
  fragment?: string;
  error?: string;
  /** Cache key component: changes whenever the file changes on disk. */
  stamp?: string;
}

/** Read and validate a fragment file. Never throws. */
export async function loadFragment(fs: VisualizeFs, target: string): Promise<FragmentLoad> {
  const pathError = checkFragmentPath(target);
  if (pathError) return { error: pathError };
  let stat: { isFile(): boolean; size: number; mtimeMs: number };
  try {
    stat = await fs.stat(target);
  } catch {
    return { error: 'Visualization file not found.' };
  }
  if (!stat.isFile()) return { error: 'Visualization path is not a file.' };
  if (stat.size > MAX_FRAGMENT_BYTES) {
    return { error: `Visualization is too large (${Math.round(stat.size / 1024)} KB, limit 2 MB).` };
  }
  try {
    return { fragment: await fs.readFile(target, 'utf8'), stamp: `${stat.mtimeMs}:${stat.size}` };
  } catch {
    return { error: 'Visualization file could not be read.' };
  }
}

/**
 * Owns every visualization card in one view: a single IntersectionObserver, a
 * single `message` listener, and a document cache shared across cards.
 *
 * One of each, not one per card. `renderMessages()` empties and rebuilds every
 * row on each thread switch, and the compressed view renders eagerly into a
 * hidden container — so a per-card observer would mean a thread with ten
 * visuals re-parsing ten documents and re-issuing every CDN request on every
 * switch, with the hidden ones all reporting height 0.
 */
export class VisualizeMountManager {
  private cards = new Map<HTMLElement, MountedCard>();
  private observer: IntersectionObserver | null = null;
  private messageHandler: ((event: MessageEvent) => void) | null = null;
  /** Built documents keyed by path + on-disk stamp + theme, so a remount is one setAttribute. */
  private docCache = new Map<string, string>();
  private attached = false;

  constructor(
    private readonly scrollerEl: HTMLElement,
    private readonly host: VisualizeHost,
  ) {}

  /** Wire up the observer and the message listener. Idempotent. */
  attach(): void {
    if (this.attached) return;
    this.attached = true;

    const view = this.scrollerEl.ownerDocument?.defaultView;
    if (view) {
      this.messageHandler = (event: MessageEvent) => this.onFrameMessage(event);
      view.addEventListener('message', this.messageHandler);
    }

    // jsdom has no IntersectionObserver; without it every card mounts eagerly,
    // which is correct-but-unoptimised rather than broken.
    if (typeof IntersectionObserver === 'undefined') return;
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const card = this.cards.get(entry.target as HTMLElement);
          if (!card) continue;
          if (entry.isIntersecting) void this.mount(card);
          else if (this.isFarOffscreen(entry)) this.unmount(card);
        }
      },
      { root: this.scrollerEl, rootMargin: `${MOUNT_MARGIN_PX}px 0px` },
    );
  }

  /** Tear everything down. Safe to call more than once. */
  detach(): void {
    this.attached = false;
    this.observer?.disconnect();
    this.observer = null;
    const view = this.scrollerEl.ownerDocument?.defaultView;
    if (view && this.messageHandler) view.removeEventListener('message', this.messageHandler);
    this.messageHandler = null;
    for (const card of this.cards.values()) this.unmount(card);
    this.cards.clear();
    this.docCache.clear();
  }

  /**
   * Replace every `<a class="ct-visualize-slot">` under `root` with a card.
   *
   * `interactive: false` renders inert chrome with no iframe. Used while a
   * message is still streaming (mounting a frame per token would thrash) and
   * anywhere an iframe is not wanted.
   */
  hydrate(root: HTMLElement, markers: VisualizeMarker[], options: { interactive: boolean }): void {
    if (markers.length === 0) return;
    const slots = root.querySelectorAll<HTMLAnchorElement>(`a.${VISUALIZE_SLOT_CLASS}[${VISUALIZE_SLOT_ATTR}]`);
    for (const slot of Array.from(slots)) {
      const index = Number(slot.getAttribute(VISUALIZE_SLOT_ATTR));
      const marker = markers[index];
      if (!marker) {
        slot.remove();
        continue;
      }
      const card = this.buildCard(marker, options.interactive);
      // A lone anchor lands inside its own <p>; unwrapping keeps the card out
      // of a paragraph box (and out of that paragraph's margins).
      const parent = slot.parentElement;
      const target = parent && parent.tagName === 'P' && (parent.textContent ?? '').trim() === (slot.textContent ?? '').trim()
        ? parent
        : slot;
      target.replaceWith(card);
    }
  }

  /** Number of cards currently tracked. Exposed for tests. */
  get cardCount(): number {
    return this.cards.size;
  }

  // ── Card construction ──────────────────────────────────────────────────────

  private buildCard(marker: VisualizeMarker, interactive: boolean): HTMLElement {
    const doc = this.scrollerEl.ownerDocument ?? document;
    const cardEl = doc.createElement('div');
    cardEl.className = 'ct-visualize-card';
    if (marker.mode === 'wide') cardEl.classList.add('ct-visualize-wide');
    if (!interactive) cardEl.classList.add('ct-visualize-static');

    const header = doc.createElement('div');
    header.className = 'ct-visualize-header';
    const icon = doc.createElement('span');
    icon.className = 'ct-visualize-icon';
    setIcon(icon, 'bar-chart-3');
    header.appendChild(icon);

    const titleEl = doc.createElement('span');
    titleEl.className = 'ct-visualize-title';
    titleEl.textContent = marker.title ?? basename(marker.path);
    // The resolved path lives in the tooltip so it is inspectable without
    // taking horizontal space away from the visual itself.
    titleEl.title = marker.path;
    setTooltip(titleEl, marker.path);
    header.appendChild(titleEl);

    if (interactive) {
      const popout = doc.createElement('button');
      popout.className = 'ct-visualize-action';
      popout.type = 'button';
      popout.title = 'Open full size';
      setTooltip(popout, 'Open full size');
      setIcon(popout, 'maximize-2');
      popout.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void this.openPopout(marker);
      });
      header.appendChild(popout);
    }
    cardEl.appendChild(header);

    const bodyEl = doc.createElement('div');
    bodyEl.className = 'ct-visualize-body';
    bodyEl.style.height = `${INITIAL_HEIGHT}px`;
    cardEl.appendChild(bodyEl);

    if (!interactive) {
      bodyEl.style.height = '';
      bodyEl.classList.add('ct-visualize-placeholder');
      bodyEl.textContent = 'Visualization';
      return cardEl;
    }

    const card: MountedCard = {
      marker,
      cardEl,
      bodyEl,
      iframe: null,
      height: INITIAL_HEIGHT,
      generation: 0,
      loading: false,
    };
    this.cards.set(cardEl, card);
    if (this.observer) this.observer.observe(cardEl);
    else void this.mount(card);
    return cardEl;
  }

  // ── Mount / unmount ────────────────────────────────────────────────────────

  private isFarOffscreen(entry: IntersectionObserverEntry): boolean {
    const rootRect = entry.rootBounds;
    if (!rootRect) return false;
    const rect = entry.boundingClientRect;
    return rect.bottom < rootRect.top - UNMOUNT_MARGIN_PX || rect.top > rootRect.bottom + UNMOUNT_MARGIN_PX;
  }

  private async mount(card: MountedCard): Promise<void> {
    if (card.iframe || card.loading) return;
    card.loading = true;
    const generation = ++card.generation;

    const theme = this.host.theme();
    const tokens = this.host.resolveTokens();
    const themeKey = themeCacheKey(theme, tokens);
    const load = await loadFragment(this.host.fs, card.marker.path);
    // The view may have been rebuilt (thread switch) while the read was pending.
    if (generation !== card.generation || !this.cards.has(card.cardEl)) {
      card.loading = false;
      return;
    }

    if (load.error || load.fragment === undefined) {
      card.loading = false;
      this.showError(card, load.error ?? 'Visualization could not be loaded.');
      return;
    }

    const cacheKey = `${card.marker.path}|${load.stamp}|${themeKey}`;
    let html = this.docCache.get(cacheKey);
    if (html === undefined) {
      html = buildInlineDocument({
        fragment: load.fragment,
        theme,
        tokens,
        title: card.marker.title ?? basename(card.marker.path),
      });
      this.docCache.set(cacheKey, html);
    }

    this.clearError(card);
    const doc = this.scrollerEl.ownerDocument ?? document;
    const iframe = doc.createElement('iframe');
    iframe.className = 'ct-visualize-frame';
    // allow-scripts and nothing else. With allow-same-origin a srcdoc frame
    // inherits app://obsidian.md and can reach parent.app.vault and every
    // plugin secret in memory; allow-modals is a UI-hang vector.
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.setAttribute('loading', 'lazy');
    iframe.setAttribute('title', card.marker.title ?? basename(card.marker.path));
    iframe.setAttribute('srcdoc', html);
    card.bodyEl.appendChild(iframe);
    card.iframe = iframe;
    this.applyHeight(card, card.height);
    card.loading = false;
  }

  private unmount(card: MountedCard): void {
    card.generation++;
    card.loading = false;
    if (!card.iframe) return;
    card.iframe.remove();
    card.iframe = null;
    // Keep the measured height so scroll position does not jump when a card
    // leaves and re-enters the viewport.
    card.bodyEl.style.height = `${card.height}px`;
  }

  // ── Height protocol ────────────────────────────────────────────────────────

  /** Upper bound for this view right now: never more than 70% of the leaf. */
  private maxHeight(): number {
    const leaf = this.host.leafHeight();
    const proportional = leaf > 0 ? Math.round(leaf * 0.7) : MAX_HEIGHT;
    return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, proportional));
  }

  private applyHeight(card: MountedCard, requested: number): void {
    const cap = this.maxHeight();
    const height = Math.max(MIN_HEIGHT, Math.min(cap, requested));
    card.height = height;
    card.bodyEl.style.height = `${height}px`;
    // At the cap the content is cut off. Fade the seam and point at the pop-out
    // rather than nesting a second scrollbar inside the message list.
    card.cardEl.classList.toggle('ct-visualize-capped', requested > cap);
  }

  private onFrameMessage(event: MessageEvent): void {
    const data = event.data as { source?: string; type?: string; height?: number; prompt?: string } | null;
    if (!data || typeof data !== 'object' || data.source !== VISUALIZE_MESSAGE_SOURCE) return;

    // event.origin is the literal string "null" for every opaque frame, so it
    // proves nothing. Identity of the sending window is the only usable check.
    let owner: MountedCard | null = null;
    for (const card of this.cards.values()) {
      if (card.iframe && event.source === card.iframe.contentWindow) {
        owner = card;
        break;
      }
    }
    if (!owner) return;

    if (data.type === 'height' && typeof data.height === 'number' && Number.isFinite(data.height)) {
      this.applyHeight(owner, Math.ceil(data.height));
      return;
    }
    if (data.type === 'followUp') {
      // Deliberately not wired into the composer: model-authored text arriving
      // from inside a sandboxed frame is a prompt-injection channel.
      this.host.notify('This visualization tried to send a follow-up message. It was ignored.');
    }
  }

  // ── Errors ─────────────────────────────────────────────────────────────────

  private showError(card: MountedCard, message: string): void {
    this.clearError(card);
    const doc = this.scrollerEl.ownerDocument ?? document;
    const chip = doc.createElement('div');
    chip.className = 'ct-visualize-error';
    chip.textContent = message;
    card.cardEl.insertBefore(chip, card.bodyEl);
    card.bodyEl.style.height = '';
    card.bodyEl.classList.add('ct-visualize-placeholder');
    card.bodyEl.textContent = card.marker.path;
  }

  private clearError(card: MountedCard): void {
    card.cardEl.querySelector('.ct-visualize-error')?.remove();
    card.bodyEl.classList.remove('ct-visualize-placeholder');
    card.bodyEl.textContent = '';
  }

  // ── Pop-out ────────────────────────────────────────────────────────────────

  /**
   * Write the nested pop-out document to the OS temp directory and open it in
   * the host Web Viewer.
   *
   * Temp rather than the vault: verified against Geode's and Obsidian's Web
   * Viewer, both of which hand `state.url` straight to an Electron `<webview>`
   * with no scheme allowlist and no vault scoping, so an out-of-vault
   * `file://` URL loads. Keeping it out of the vault means nothing to index
   * and nothing to purge.
   */
  private async openPopout(marker: VisualizeMarker): Promise<void> {
    const load = await loadFragment(this.host.fs, marker.path);
    if (load.error || load.fragment === undefined) {
      this.host.notify(load.error ?? 'Visualization could not be loaded.');
      return;
    }
    const html = buildPopoutDocument({
      fragment: load.fragment,
      theme: this.host.theme(),
      tokens: this.host.resolveTokens(),
      title: marker.title ?? basename(marker.path),
    });
    const dir = `${this.host.fs.tmpDir().replace(/[\\/]+$/, '')}/claude-threads-visualize`;
    const target = `${dir}/${popoutFileName(marker.path)}`;
    try {
      await this.host.fs.mkdir(dir, { recursive: true });
      await this.host.fs.writeFile(target, html, 'utf8');
    } catch {
      this.host.notify('Could not write the visualization for full-size viewing.');
      return;
    }
    this.host.openUrl(toFileUrl(target));
  }
}

/**
 * Read the host's CSS variables off `sourceEl` and return literal values for
 * every token in the fragment contract. Custom properties do not cross an
 * iframe boundary, so this resolution has to happen on the host side.
 */
export function resolveVisualizeTokens(sourceEl: HTMLElement): Record<string, string> {
  const view = sourceEl.ownerDocument?.defaultView;
  const tokens: Record<string, string> = {};
  if (!view || typeof view.getComputedStyle !== 'function') return tokens;
  const style = view.getComputedStyle(sourceEl);
  for (const { token, from } of TOKEN_SOURCES) {
    for (const source of from) {
      const value = style.getPropertyValue(source).trim();
      if (value) {
        tokens[token] = value;
        break;
      }
    }
  }
  return tokens;
}
