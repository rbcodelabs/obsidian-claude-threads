import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const css = fs.readFileSync(path.resolve('styles.css'), 'utf8');

/**
 * The agent pill is the only always-visible agent surface. It lives in
 * .ct-input-footer, which is hover-only by default, so a `:has()` rule pins the
 * footer open while the pill is showing. These tests exist because both halves
 * of that rule fail silently: lose the rule and the pill becomes invisible until
 * you hover; lose the `transition` and the footer snaps open the instant the
 * first agent starts.
 */
describe('agent pill footer pinning', () => {
  const rule = css.match(
    /\.ct-panel-collapsible:has\(\.ct-agent-pill:not\(\.ct-hidden\)\)\s+\.ct-input-footer\s*\{([^}]*)\}/,
  )?.[1];

  it('pins the composer footer open while the pill is visible', () => {
    expect(rule).toBeDefined();
    expect(rule).toMatch(/max-height:\s*50px/);
    expect(rule).toMatch(/opacity:\s*1/);
    expect(rule).toMatch(/pointer-events:\s*auto/);
  });

  it('repeats the transition so the footer animates instead of snapping open', () => {
    expect(rule).toMatch(/transition:\s*max-height[^;]*opacity[^;]*;/);
  });

  it('anchors the popover on .ct-panel-wrapper, which must be positioned', () => {
    const wrapper = css.match(/\.ct-panel-wrapper\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(wrapper).toMatch(/position:\s*relative/);
    const popover = css.match(/\.ct-agent-popover\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(popover).toMatch(/position:\s*absolute/);
    // Drawn above the composer, not inside it.
    expect(popover).toMatch(/bottom:\s*100%/);
  });

  it('hides the pill entirely when a thread has no agents', () => {
    expect(css).toMatch(/\.ct-agent-pill\.ct-hidden\s*\{\s*display:\s*none;?\s*\}/);
  });
});

describe('agent touch targets', () => {
  const mobileBlock = css.match(/@media \(max-width: 600px\) \{([\s\S]*?)\n\}/)?.[1] ?? '';

  it('keeps agent rows and dashboard chips at 44px on mobile', () => {
    expect(mobileBlock).toMatch(/\.ct-agent-row-button,\s*\.ct-dashboard-agent\s*\{\s*min-height:\s*44px/);
  });

  it('keeps the pill, crumbs and close buttons at 44px on mobile', () => {
    expect(mobileBlock).toMatch(/\.ct-agent-pill[^{]*\{[^}]*min-height:\s*44px/);
    expect(mobileBlock).toMatch(/\.ct-agent-crumb[,\s][^{]*\{[^}]*min-height:\s*44px/);
  });
});

describe('agent status dots', () => {
  it('colours every non-terminal status, including waiting and unavailable', () => {
    for (const status of ['starting', 'working', 'waiting', 'completed', 'failed', 'unavailable']) {
      expect(css).toContain(`.ct-agent-${status} .ct-agent-status-dot`);
    }
  });
});
