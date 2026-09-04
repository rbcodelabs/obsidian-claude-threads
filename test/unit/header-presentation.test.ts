/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { hasVisibleDirectViewHeader } from '../../src/headerPresentation';

const style = (display: string) => () => ({ display }) as CSSStyleDeclaration;

describe('conversation header presentation', () => {
  it('uses the native header when the direct ItemView header is visible', () => {
    const container = document.createElement('div');
    container.innerHTML = '<div class="view-header"></div><div class="view-content"></div>';
    expect(hasVisibleDirectViewHeader(container, style('flex'))).toBe(true);
  });

  it('uses custom chrome when the direct ItemView header is hidden', () => {
    const container = document.createElement('div');
    container.innerHTML = '<div class="view-header"></div><div class="view-content"></div>';
    expect(hasVisibleDirectViewHeader(container, style('none'))).toBe(false);
  });

  it('ignores nested headers owned by conversation content', () => {
    const container = document.createElement('div');
    container.innerHTML = '<div class="view-content"><div class="view-header"></div></div>';
    expect(hasVisibleDirectViewHeader(container, style('flex'))).toBe(false);
  });
});
