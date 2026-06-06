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

// Additional vaults to sync to (real copies, not symlinks)
const extraVaults = [
  path.join(process.env.HOME, 'Documents/Personal/.obsidian/plugins/claude-threads'),
  path.join(process.env.HOME, 'projects/PluginTesting/.obsidian/plugins/claude-threads'),
];

if (!fs.existsSync(outdir)) fs.mkdirSync(outdir, { recursive: true });

function copyToObsidian() {
  const dirs = [];
  if (pluginDir && fs.existsSync(pluginDir)) dirs.push(pluginDir);
  for (const v of extraVaults) if (fs.existsSync(v)) dirs.push(v);
  for (const dir of dirs) {
    for (const file of ['main.js', 'styles.css', 'manifest.json']) {
      const src = path.join(outdir, file);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, file));
    }
    console.log(`Copied to ${dir}`);
  }
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
