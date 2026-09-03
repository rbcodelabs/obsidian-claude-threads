/**
 * Minimal Obsidian API mock for vitest.
 * Covers just the surface area used by MobileView, RelayClient, and ThreadManager.
 */

export class Plugin {
  app: unknown = {};
  manifest: unknown = {};
  addCommand(_cmd: unknown) {}
  addSettingTab(_tab: unknown) {}
  addRibbonIcon(_icon: string, _title: string, _cb: () => void) { return document.createElement('div'); }
  registerView(_type: string, _fn: unknown) {}
  registerObsidianProtocolHandler(_type: string, _fn: unknown) {}
  loadData(): Promise<unknown> { return Promise.resolve({}); }
  saveData(_data: unknown): Promise<void> { return Promise.resolve(); }
}

export class PluginSettingTab {
  app: unknown;
  plugin: unknown;
  containerEl: HTMLElement = document.createElement('div');
  constructor(_app: unknown, _plugin: unknown) {}
  display() {}
  hide() {}
}

export class Setting {
  settingEl: HTMLElement = document.createElement('div');
  constructor(_containerEl: HTMLElement) {}
  setName(_name: string): this { return this; }
  setDesc(_desc: string): this { return this; }
  addText(_cb: (text: unknown) => void): this { return this; }
  addToggle(_cb: (toggle: unknown) => void): this { return this; }
  addButton(_cb: (btn: unknown) => void): this { return this; }
  addDropdown(_cb: (dd: unknown) => void): this { return this; }
}

export class ItemView {
  containerEl: HTMLElement;
  leaf: unknown;
  app: unknown = {};

  constructor(leaf: unknown) {
    this.leaf = leaf;
    this.containerEl = document.createElement('div');
    // Obsidian ItemView has containerEl.children[1] as the content area
    const header = document.createElement('div');
    const content = document.createElement('div');
    this.containerEl.appendChild(header);
    this.containerEl.appendChild(content);
  }

  registerEvent(_event: unknown) {}
  registerDomEvent(_el: unknown, _type: string, _handler: unknown) {}
}

export class WorkspaceLeaf {
  view: unknown = null;
}

export class Notice {
  static messages: Array<{ message: string; duration?: number }> = [];

  constructor(message: string, duration?: number) {
    Notice.messages.push({ message, duration });
  }
}

/**
 * Records what was added to a menu so tests can assert on titles and invoke
 * handlers. Chainable, matching the real MenuItem builder API.
 */
export class MenuItem {
  title = '';
  icon: string | undefined;
  checked = false;
  disabled = false;
  clickHandler: ((evt?: unknown) => unknown) | undefined;
  setTitle(title: string): this { this.title = title; return this; }
  setIcon(icon: string): this { this.icon = icon; return this; }
  setChecked(checked: boolean): this { this.checked = checked; return this; }
  setDisabled(disabled: boolean): this { this.disabled = disabled; return this; }
  setSection(_section: string): this { return this; }
  onClick(handler: (evt?: unknown) => unknown): this { this.clickHandler = handler; return this; }
}

export class Menu {
  /** Items in the order they were added. Separators are recorded as null. */
  items: Array<MenuItem | null> = [];
  shown = false;
  addItem(cb: (item: MenuItem) => void): this {
    const item = new MenuItem();
    cb(item);
    this.items.push(item);
    return this;
  }
  addSeparator(): this { this.items.push(null); return this; }
  showAtMouseEvent(_evt: unknown): this { this.shown = true; return this; }
  showAtPosition(_pos: unknown): this { this.shown = true; return this; }
  hide(): this { return this; }
  /** Test helper: the titles of all non-separator items. */
  titles(): string[] { return this.items.filter((i): i is MenuItem => i !== null).map(i => i.title); }
  /** Test helper: find an item by its exact title. */
  item(title: string): MenuItem | undefined {
    return this.items.find((i): i is MenuItem => i !== null && i.title === title);
  }
}

export class Modal {
  app: unknown;
  containerEl: HTMLElement = document.createElement('div');
  contentEl: HTMLElement = document.createElement('div');
  constructor(_app: unknown) {}
  open() {}
  close() {}
}

export class TFile {
  path: string;
  name: string;
  basename: string;
  extension: string;
  constructor(path: string) {
    this.path = path;
    this.name = path.split('/').pop() ?? path;
    this.basename = this.name.replace(/\.[^.]+$/, '');
    this.extension = this.name.includes('.') ? this.name.split('.').pop() ?? '' : '';
  }
}

// FileSystemAdapter is only used via `instanceof` guards in source (desktop
// detection). The test App mock's adapter is a plain object, so `instanceof
// FileSystemAdapter` is false, so code takes the mobile/base64 fallback path.
export class FileSystemAdapter {
  getBasePath(): string { return ''; }
  getResourcePath(p: string): string { return p; }
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const buf = Buffer.from(base64, 'base64');
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString('base64');
}

export function sanitizeHTMLToDom(html: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const div = document.createElement('div');
  div.innerHTML = html;
  while (div.firstChild) frag.appendChild(div.firstChild);
  return frag;
}

export function normalizePath(path: string): string { return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, ''); }
export function parseLinktext(linktext: string): { path: string; subpath: string } {
  const match = linktext.match(/^([^#]*)(#.*)?$/);
  return { path: match?.[1] ?? linktext, subpath: match?.[2] ?? '' };
}

export function addIcon(_iconId: string, _svgContent: string) {}

export function setIcon(_el: HTMLElement, _icon: string): void {}

export function setTooltip(_el: HTMLElement, _tooltip: string): void {}

export const Platform = {
  isMobile: false,
  isDesktop: true,
  isMacOS: true,
};

export class App {
  workspace = {
    getLeavesOfType: () => [],
    getRightLeaf: () => null,
    getLeaf: () => null,
    revealLeaf: () => {},
    on: () => {},
    onLayoutReady: (cb: () => void) => cb(),
  };
  vault = {
    getAbstractFileByPath: () => null,
    create: () => Promise.resolve({}),
    modify: () => Promise.resolve(),
    read: () => Promise.resolve(''),
    on: () => {},
  };
  metadataCache = { on: () => {} };
}
