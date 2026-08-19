import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('harness picker touch targets', () => {
  it('keeps each menu choice at least 44px tall', () => {
    const css = fs.readFileSync(path.resolve('styles.css'), 'utf8');
    const rule = css.match(/\.ct-harness-menu-item\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(rule).toMatch(/min-height:\s*44px/);
  });
});
