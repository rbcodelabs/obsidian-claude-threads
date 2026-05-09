import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
  },
  resolve: {
    alias: {
      // Prevent Obsidian from being imported in tests — nothing in ThreadManager or types needs it
      obsidian: '/dev/null',
    },
  },
});
