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
    },
  },
  projects: [{ name: 'chromium', use: { channel: 'chromium' } }],
  snapshotDir: './test/screenshots/snapshots',
});
