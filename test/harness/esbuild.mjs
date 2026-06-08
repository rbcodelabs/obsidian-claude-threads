import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const resolve = (...parts) => path.resolve(__dirname, ...parts);

const sharedConfig = {
  format: 'iife',
  platform: 'browser',
  sourcemap: true,
  bundle: true,
  alias: {
    'obsidian':                         resolve('./obsidian-mock.ts'),
    'fs':                               resolve('./mocks/fs.ts'),
    'path':                             resolve('./mocks/path.ts'),
    'os':                               resolve('./mocks/os.ts'),
    // child_process is statically imported by ThreadsView — stub it so the
    // IIFE bundle doesn't crash at load time in the browser harness.
    'child_process':                    resolve('./mocks/child-process.ts'),
    // electron is used in dynamic require() calls inside click handlers;
    // inject a no-op so those code paths don't crash when reached in tests.
    'electron':                         resolve('./mocks/electron.ts'),
    '@anthropic-ai/claude-agent-sdk':   resolve('./mocks/claude-sdk.ts'),
  },
  define: {
    'process.env':          '{}',
    'process.env.HOME':     '"/Users/mock"',
    'process.env.PATH':     '"/usr/local/bin"',
  },
};

await build({
  ...sharedConfig,
  entryPoints: [resolve('./index.ts')],
  outfile: resolve('./dist/bundle.js'),
});

await build({
  ...sharedConfig,
  entryPoints: [resolve('./mobile-index.ts')],
  outfile: resolve('./dist/mobile-bundle.js'),
});

await build({
  ...sharedConfig,
  entryPoints: [resolve('./skills-index.ts')],
  outfile: resolve('./dist/skills-bundle.js'),
});

console.log('[harness] bundles built → test/harness/dist/ (bundle.js, mobile-bundle.js, skills-bundle.js)');
