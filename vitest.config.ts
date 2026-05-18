import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
    environmentMatchGlobs: [
      // MobileView tests need a real DOM
      ['test/unit/MobileView.test.ts', 'jsdom'],
    ],
  },
  resolve: {
    alias: {
      // Route all obsidian imports to our test mock (works in both node and jsdom environments)
      obsidian: resolve(__dirname, 'test/__mocks__/obsidian.ts'),
    },
  },
});
