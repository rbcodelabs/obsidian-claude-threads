import { defineConfig } from '@playwright/test';
import path from 'path';

export default defineConfig({
  testDir: './test/screenshots',
  use: {
    viewport: { width: 420, height: 740 },
    deviceScaleFactor: 2,
  },
  expect: {
    toHaveScreenshot: {
      scale: 'device',
      // Tolerate minor sub-pixel anti-aliasing differences in SVG/circular
      // icons (status dots, action buttons) that vary between renders.
      // 200 px @ 2x device scale ≈ 0.02% of a 420×740 viewport — tight
      // enough to catch real layout regressions, loose enough for rendering
      // noise.
      maxDiffPixels: 200,
    },
  },
  projects: [{ name: 'chromium', use: { channel: 'chromium' } }],
  snapshotDir: './test/screenshots/snapshots',
});
