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
    'child_process':                    resolve('./mocks/child-process.ts'),
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

console.log('[harness] bundles built → test/harness/dist/');
