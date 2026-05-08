import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const resolve = (...parts) => path.resolve(__dirname, ...parts);

await build({
  entryPoints: [resolve('./index.ts')],
  outfile: resolve('./dist/bundle.js'),
  format: 'iife',
  platform: 'browser',
  sourcemap: true,
  bundle: true,
  alias: {
    'obsidian':                         resolve('./obsidian-mock.ts'),
    'fs':                               resolve('./mocks/fs.ts'),
    'path':                             resolve('./mocks/path.ts'),
    'os':                               resolve('./mocks/os.ts'),
    '@anthropic-ai/claude-agent-sdk':   resolve('./mocks/claude-sdk.ts'),
  },
  define: {
    'process.env':          '{}',
    'process.env.HOME':     '"/Users/mock"',
    'process.env.PATH':     '"/usr/local/bin"',
  },
});

console.log('[harness] bundle built → test/harness/dist/bundle.js');
