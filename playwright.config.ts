import { defineConfig } from '@playwright/test';
import path from 'path';

export default defineConfig({
  testDir: './test/screenshots',
  use: {
    viewport: { width: 420, height: 740 },
    deviceScaleFactor: 2,
    // Pin the browser timezone + locale so message timestamps render the
    // same regardless of the machine's system timezone. The committed
    // baselines were captured in Eastern time — without this pin the suite
    // fails on any machine (or after any travel) outside America/New_York.
    timezoneId: 'America/New_York',
    locale: 'en-US',
  },
  expect: {
    toHaveScreenshot: {
      scale: 'device',
      // Small allowance for sub-pixel anti-aliasing noise. With the clock,
      // timezone, and locale pinned above, renders are fully deterministic
      // on a given machine (verified: two consecutive runs pass at 0), so
      // this stays tight. The previous 200px tolerance silently swallowed an
      // entire added footer icon (~116 differing pixels) — keep this below
      // the footprint of the smallest meaningful UI change.
      maxDiffPixels: 25,
    },
  },
  projects: [{ name: 'chromium', use: { channel: 'chromium' } }],
  snapshotDir: './test/screenshots/snapshots',
});
