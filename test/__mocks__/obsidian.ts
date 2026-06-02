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
  constructor(_message: string, _duration?: number) {}
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

export function sanitizeHTMLToDom(html: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const div = document.createElement('div');
  div.innerHTML = html;
  while (div.firstChild) frag.appendChild(div.firstChild);
  return frag;
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
