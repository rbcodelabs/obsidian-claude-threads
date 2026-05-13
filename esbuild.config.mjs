import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes('--watch');
const outdir = path.join(__dirname, 'dist');

// Load .env.local if present
const envLocalPath = path.join(__dirname, '.env.local');
if (fs.existsSync(envLocalPath)) {
  for (const line of fs.readFileSync(envLocalPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
}

const pluginDir = process.env.OBSIDIAN_PLUGIN_DIR;

if (!fs.existsSync(outdir)) fs.mkdirSync(outdir, { recursive: true });

function copyToObsidian() {
  if (!pluginDir) return;
  for (const file of ['main.js', 'styles.css', 'manifest.json']) {
    const src = path.join(outdir, file);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(pluginDir, file));
  }
  console.log(`Copied to ${pluginDir}`);
}

const syncPlugin = {
  name: 'obsidian-sync',
  setup(build) {
    build.onEnd(() => copyToObsidian());
  },
};

const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  plugins: [syncPlugin],
  external: [
    'obsidian',
    'electron',
    'codemirror',
    '@codemirror/autocomplete',
    '@codemirror/closebrackets',
    '@codemirror/commands',
    '@codemirror/fold',
    '@codemirror/gutter',
    '@codemirror/highlight',
    '@codemirror/history',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/matchbrackets',
    '@codemirror/panel',
    '@codemirror/rangeset',
    '@codemirror/rectangular-selection',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/stream-parser',
    '@codemirror/text',
    '@codemirror/tooltip',
    '@codemirror/view',
  ],
  format: 'cjs',
  target: 'es2020',
  platform: 'node',
  logLevel: 'info',
  sourcemap: 'inline',
  treeShaking: true,
  outfile: 'dist/main.js',
});

// Copy static assets
fs.copyFileSync('manifest.json', 'dist/manifest.json');
if (fs.existsSync('styles.css')) fs.copyFileSync('styles.css', 'dist/styles.css');

if (isWatch) {
  await ctx.watch();
  console.log(`Watching for changes...${pluginDir ? ` (syncing to ${pluginDir})` : ' (set OBSIDIAN_PLUGIN_DIR to sync)'}`);
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log('Build complete');
}
