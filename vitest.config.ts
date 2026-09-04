import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
    // The default environment is `node`. A test that touches the DOM opts in
    // per file with an `@vitest-environment jsdom` docblock — there is no
    // config-side list to update. (`environmentMatchGlobs` used to live here,
    // but it was removed in Vitest 3 and silently ignored by the Vitest 4 we
    // run on, so it was load-bearing for nothing.) Forget the docblock and the
    // file runs under `node` and fails with "HTMLElement is not defined".
  },
  resolve: {
    alias: {
      // Route all obsidian imports to our test mock (works in both node and jsdom environments)
      obsidian: resolve(__dirname, 'test/__mocks__/obsidian.ts'),
    },
  },
});
