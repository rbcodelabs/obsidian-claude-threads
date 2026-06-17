// Thin re-export of the promises surface from fs.ts so that
// `await import('fs/promises')` in SkillsManagerView resolves correctly.
// The fs alias only covers bare 'fs' imports; 'fs/promises' needs its
// own explicit alias entry in esbuild.mjs.
export { promises as default } from './fs';
export * from './fs';

// Named re-exports matching the Node.js fs/promises API surface used in src/
export { promises } from './fs';

import { promises } from './fs';
export const readdir = promises.readdir;
export const stat = promises.stat;
export const realpath = promises.realpath;
export const readFile = promises.readFile;
export const writeFile = promises.writeFile;
export const rm = promises.rm;
export const mkdir = promises.mkdir;
export const cp = promises.cp;
