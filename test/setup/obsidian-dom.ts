/**
 * obsidian-dom.ts
 *
 * Polyfills Obsidian's HTMLElement prototype extensions for jsdom test environments.
 * Obsidian adds helper methods like .empty(), .addClass(), .createDiv(), .createEl(), .createSpan()
 * to the DOM elements. Without these the MobileView DOM tests fail immediately.
 *
 * Only runs in the jsdom environment (loaded via vitest setupFiles).
 */

declare global {
  interface HTMLElement {
    empty(): void;
    addClass(cls: string): void;
    removeClass(cls: string): void;
    toggleClass(cls: string, value?: boolean): void;
    hasClass(cls: string): boolean;
    createDiv(cls?: string | { cls?: string; text?: string; attr?: Record<string, string> }): HTMLDivElement;
    createSpan(options?: string | { cls?: string; text?: string; attr?: Record<string, string> }): HTMLSpanElement;
    createEl<K extends keyof HTMLElementTagNameMap>(
      tag: K,
      options?: { cls?: string; text?: string; attr?: Record<string, string> }
    ): HTMLElementTagNameMap[K];
    setText(text: string): void;
    insertBefore<T extends Node>(newChild: T, reference: Node | null): T;
  }
}

function applyOptions(el: HTMLElement, options?: string | { cls?: string; text?: string; attr?: Record<string, string> }) {
  if (!options) return;
  if (typeof options === 'string') {
    if (options) el.className = options;
    return;
  }
  if (options.cls) el.className = options.cls;
  if (options.text) el.textContent = options.text;
  if (options.attr) {
    for (const [k, v] of Object.entries(options.attr)) {
      el.setAttribute(k, v);
    }
  }
}

HTMLElement.prototype.empty = function (this: HTMLElement): void {
  while (this.firstChild) this.removeChild(this.firstChild);
};

HTMLElement.prototype.addClass = function (this: HTMLElement, cls: string): void {
  cls.split(' ').filter(Boolean).forEach((c) => this.classList.add(c));
};

HTMLElement.prototype.removeClass = function (this: HTMLElement, cls: string): void {
  cls.split(' ').filter(Boolean).forEach((c) => this.classList.remove(c));
};

HTMLElement.prototype.toggleClass = function (this: HTMLElement, cls: string, value?: boolean): void {
  if (value === undefined) {
    this.classList.toggle(cls);
  } else {
    this.classList.toggle(cls, value);
  }
};

HTMLElement.prototype.hasClass = function (this: HTMLElement, cls: string): boolean {
  return this.classList.contains(cls);
};

HTMLElement.prototype.createDiv = function (
  this: HTMLElement,
  options?: string | { cls?: string; text?: string; attr?: Record<string, string> }
): HTMLDivElement {
  const el = document.createElement('div');
  applyOptions(el, options);
  this.appendChild(el);
  return el;
};

HTMLElement.prototype.createSpan = function (
  this: HTMLElement,
  options?: string | { cls?: string; text?: string; attr?: Record<string, string> }
): HTMLSpanElement {
  const el = document.createElement('span');
  applyOptions(el, options);
  this.appendChild(el);
  return el;
};

HTMLElement.prototype.createEl = function <K extends keyof HTMLElementTagNameMap>(
  this: HTMLElement,
  tag: K,
  options?: { cls?: string; text?: string; attr?: Record<string, string> }
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag) as HTMLElementTagNameMap[K];
  applyOptions(el as HTMLElement, options);
  this.appendChild(el);
  return el;
};

HTMLElement.prototype.setText = function (this: HTMLElement, text: string): void {
  this.textContent = text;
};

export {};
