import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes('--watch');
const outdir = path.join(__dirname, 'dist');

if (!fs.existsSync(outdir)) fs.mkdirSync(outdir, { recursive: true });

// Stub native modules Transformers.js imports but never uses in Electron renderer:
// - onnxruntime-node: not used because process.release.name === 'electron', not 'node'
// - sharp: image processing lib, not needed for text summarization
const stubNativeModules = {
  name: 'stub-native-modules',
  setup(build) {
    const stubs = ['onnxruntime-node', 'sharp'];
    for (const mod of stubs) {
      build.onResolve({ filter: new RegExp(`^${mod}$`) }, () => ({
        path: mod,
        namespace: 'stub',
      }));
    }
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'module.exports = {};',
      loader: 'js',
    }));
  },
};

// Copy WASM runtime files Transformers.js needs into dist/
const wasmSrc = path.join(__dirname, 'node_modules/@xenova/transformers/dist');
const wasmFiles = fs.readdirSync(wasmSrc).filter(f => f.endsWith('.wasm'));
for (const f of wasmFiles) {
  fs.copyFileSync(path.join(wasmSrc, f), path.join(outdir, f));
}

const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  plugins: [stubNativeModules],
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
