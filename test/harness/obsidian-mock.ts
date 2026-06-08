/**
 * Obsidian API mock for the Playwright harness.
 * Must be imported first — sets up HTMLElement.prototype extensions.
 */

// ─── HTMLElement.prototype extensions ────────────────────────────────────────

interface CreateElOptions {
  cls?: string;
  text?: string;
  attr?: Record<string, string | boolean>;
  placeholder?: string;
  type?: string;
  value?: string;
  title?: string;
}

function applyCreateEl<K extends keyof HTMLElementTagNameMap>(
  el: HTMLElementTagNameMap[K],
  opts?: CreateElOptions | string,
): HTMLElementTagNameMap[K] {
  if (!opts) return el;
  if (typeof opts === 'string') {
    el.className = opts;
    return el;
  }
  if (opts.cls) el.className = opts.cls;
  if (opts.text) el.textContent = opts.text;
  if (opts.attr) {
    for (const [k, v] of Object.entries(opts.attr)) {
      if (typeof v === 'boolean') {
        if (v) el.setAttribute(k, '');
        else el.removeAttribute(k);
      } else {
        el.setAttribute(k, v);
      }
    }
  }
  // Convenience shorthands
  if (opts.placeholder) el.setAttribute('placeholder', opts.placeholder);
  if (opts.type) el.setAttribute('type', opts.type);
  if (opts.value) (el as HTMLInputElement).value = opts.value;
  if (opts.title) el.setAttribute('title', opts.title);
  return el;
}

declare global {
  interface HTMLElement {
    createEl<K extends keyof HTMLElementTagNameMap>(
      tag: K,
      opts?: CreateElOptions | string,
    ): HTMLElementTagNameMap[K];
    createDiv(opts?: CreateElOptions | string): HTMLDivElement;
    createSpan(opts?: CreateElOptions | string): HTMLSpanElement;
    empty(): void;
    addClass(...classes: string[]): void;
    removeClass(...classes: string[]): void;
    hasClass(cls: string): boolean;
    toggleClass(cls: string, force?: boolean): void;
    setText(text: string): void;
  }
}

HTMLElement.prototype.createEl = function <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts?: CreateElOptions | string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyCreateEl(el, opts);
  this.appendChild(el);
  return el;
};

HTMLElement.prototype.createDiv = function (
  opts?: CreateElOptions | string,
): HTMLDivElement {
  return this.createEl('div', opts);
};

HTMLElement.prototype.createSpan = function (
  opts?: CreateElOptions | string,
): HTMLSpanElement {
  return this.createEl('span', opts);
};

HTMLElement.prototype.empty = function (): void {
  while (this.firstChild) this.removeChild(this.firstChild);
};

HTMLElement.prototype.addClass = function (...classes: string[]): void {
  for (const cls of classes) {
    if (cls) this.classList.add(cls);
  }
};

HTMLElement.prototype.removeClass = function (...classes: string[]): void {
  for (const cls of classes) {
    if (cls) this.classList.remove(cls);
  }
};

HTMLElement.prototype.hasClass = function (cls: string): boolean {
  return this.classList.contains(cls);
};

HTMLElement.prototype.toggleClass = function (cls: string, force?: boolean): void {
  if (force !== undefined) {
    this.classList.toggle(cls, force);
  } else {
    this.classList.toggle(cls);
  }
};

HTMLElement.prototype.setText = function (text: string): void {
  this.textContent = text;
};

// ─── Lucide SVG strings ───────────────────────────────────────────────────────

const ICONS: Record<string, string> = {
  'brain-circuit': `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M19.938 10.5a4 4 0 0 1 .585.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M19.967 17.484A4 4 0 0 1 18 18"/></svg>`,
  'copy': `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`,
  'check': `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
  'loader': `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4"/><path d="m16.2 7.8 2.9-2.9"/><path d="M18 12h4"/><path d="m16.2 16.2 2.9 2.9"/><path d="M12 18v4"/><path d="m4.9 19.1 2.9-2.9"/><path d="M2 12h4"/><path d="m4.9 4.9 2.9 2.9"/></svg>`,
};

const FALLBACK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>`;

// ─── Mock exports ─────────────────────────────────────────────────────────────

export const mockApp = {
  vault: {
    adapter: {
      getBasePath: () => '/mock/vault',
      getResourcePath: (p: string) => p,
    },
  },
  workspace: {},
};

export const mockLeaf = { app: mockApp, view: null, updateHeader: () => {} };

export class ItemView {
  containerEl: HTMLElement;
  app = mockApp;
  leaf: unknown;

  constructor(_leaf: unknown) {
    this.leaf = _leaf;
    this.containerEl = document.createElement('div');
    // Obsidian ItemView has containerEl.children[0] (nav header) and children[1] (view-content)
    const header = document.createElement('div');
    const content = document.createElement('div');
    this.containerEl.appendChild(header);
    this.containerEl.appendChild(content);
  }

  register(_cb: () => void): void {}
}

export class WorkspaceLeaf {}

export class Modal {
  titleEl: HTMLElement;
  contentEl: HTMLElement;
  onClose: () => void = () => {};

  private overlay: HTMLElement;
  private container: HTMLElement;

  constructor(_app: unknown) {
    // Build a modal-container overlay in the document body
    this.overlay = document.createElement('div');
    this.overlay.className = 'modal-overlay';
    this.overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'background:rgba(0,0,0,0.5)',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'z-index:9999',
    ].join(';');

    this.container = document.createElement('div');
    this.container.className = 'modal-container';
    this.container.style.cssText = [
      'background:var(--background-primary,#1e1e1e)',
      'border:1px solid var(--background-modifier-border,#404040)',
      'border-radius:8px',
      'padding:20px',
      'min-width:300px',
      'max-width:420px',
      'box-shadow:0 8px 32px rgba(0,0,0,0.4)',
    ].join(';');

    this.titleEl = document.createElement('h2');
    this.titleEl.style.cssText = 'margin:0 0 12px;font-size:16px;color:var(--text-normal,#dcddde)';

    this.contentEl = document.createElement('div');
    this.contentEl.style.cssText = 'color:var(--text-normal,#dcddde)';

    this.container.appendChild(this.titleEl);
    this.container.appendChild(this.contentEl);
    this.overlay.appendChild(this.container);
  }

  open(): void {
    document.body.appendChild(this.overlay);
    this.onOpen();
  }

  onOpen(): void {}

  close(): void {
    if (this.overlay.parentNode) {
      this.overlay.parentNode.removeChild(this.overlay);
    }
    this.onClose();
  }
}

export function setIcon(el: HTMLElement, name: string): void {
  const svg = ICONS[name] ?? FALLBACK_SVG;
  el.innerHTML = svg;
}

export function setTooltip(el: HTMLElement, tooltip: string, _options?: { placement?: string }): void {
  el.setAttribute('aria-label', tooltip);
  el.setAttribute('title', tooltip);
}

export class App {}

export function sanitizeHTMLToDom(html: string): DocumentFragment {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return tpl.content;
}

export class Menu {
  private items: MenuItem[] = [];

  addItem(cb: (item: MenuItem) => void): this {
    const item = new MenuItem();
    cb(item);
    this.items.push(item);
    return this;
  }

  addSeparator(): this { return this; }

  private show(): void {
    const menuEl = document.createElement('div');
    menuEl.className = 'menu';
    menuEl.style.cssText = [
      'position:fixed',
      'z-index:10000',
      'background:var(--background-primary,#1e1e1e)',
      'border:1px solid var(--background-modifier-border,#404040)',
      'border-radius:6px',
      'padding:4px 0',
      'min-width:160px',
      'box-shadow:0 4px 16px rgba(0,0,0,0.4)',
    ].join(';');

    for (const item of this.items) {
      const itemEl = document.createElement('div');
      itemEl.className = 'menu-item';
      itemEl.style.cssText = 'padding:6px 12px;cursor:pointer;color:var(--text-normal,#dcddde);font-size:14px;';
      itemEl.textContent = item.title;
      itemEl.addEventListener('click', () => {
        item.triggerClick();
        if (menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
      });
      menuEl.appendChild(itemEl);
    }

    document.body.appendChild(menuEl);

    // Dismiss on next outside click
    const dismiss = (e: MouseEvent) => {
      if (!menuEl.contains(e.target as Node)) {
        if (menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
        document.removeEventListener('click', dismiss);
      }
    };
    setTimeout(() => document.addEventListener('click', dismiss), 0);
  }

  showAtMouseEvent(_event: MouseEvent): void {
    this.show();
  }

  showAtPosition(_pos: { x: number; y: number }): void {
    this.show();
  }
}

class MenuItem {
  title = '';
  private _cb?: () => void;

  setTitle(title: string): this { this.title = title; return this; }
  setIcon(_icon: string): this { return this; }
  onClick(cb: () => void): this { this._cb = cb; return this; }
  triggerClick(): void { this._cb?.(); }
}

export class Notice {
  constructor(_msg: string, _duration?: number) {}
}

export class FileSystemAdapter {}

/**
 * Mock for Obsidian's MarkdownRenderer — used by ThreadsView and MobileView.
 * In the real plugin this calls into Obsidian's internal Markdown pipeline
 * (which handles [[wikilinks]] etc.). For the test harness we render via
 * `marked` so that code blocks, bold, etc. look correct in screenshots.
 */
export class MarkdownRenderer {
  static async render(
    _app: unknown,
    markdown: string,
    el: HTMLElement,
    _sourcePath: string,
    _component: unknown,
  ): Promise<void> {
    // Dynamic import keeps this optional at type-check time and avoids
    // a circular-import issue in the esbuild harness bundle.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { marked } = require('marked') as typeof import('marked');

    // Pre-process Obsidian [[wikilinks]] and [[target|alias]] before handing
    // off to marked, since marked doesn't know about them.  The real Obsidian
    // renderer resolves these to vault-internal hrefs; in the harness we just
    // produce <a data-href="…"> anchors so the rendered HTML has actual links.
    const withLinks = markdown.replace(
      /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
      (_match, target: string, alias?: string) => {
        const label = alias ?? target.split('/').pop() ?? target;
        return `<a class="internal-link" data-href="${target}" href="#">${label}</a>`;
      },
    );

    el.innerHTML = await marked(withLinks, { async: true });
  }
}

/**
 * Mock for Obsidian's requestUrl — used by SkillsManagerView to bypass CORS.
 * In the test harness we delegate to the global fetch so network calls still
 * work; the real plugin uses Electron's main-process fetch path instead.
 */
export async function requestUrl(options: { url: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<{ json: unknown; status: number }> {
  const res = await fetch(options.url, {
    method: options.method ?? 'GET',
    headers: options.headers,
    body: options.body,
  });
  const json = await res.json();
  return { json, status: res.status };
}
