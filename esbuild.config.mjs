import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes('--watch');
const outdir = path.join(__dirname, 'dist');

if (!fs.existsSync(outdir)) fs.mkdirSync(outdir, { recursive: true });

const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  plugins: [],
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
  console.log('Watching for changes...');
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log('Build complete');
}
