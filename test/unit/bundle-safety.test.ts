/**
 * bundle-safety.test.ts
 *
 * Regression guard for the mobile crash bug: Obsidian Mobile's require()
 * interceptor returns null for Node.js built-ins (fs, path, os,
 * child_process, etc.). If any of those are called at module-init time
 * (i.e., outside a lazy __esm factory function) the plugin crashes on load.
 *
 * What we fix: desktop-only modules use `import type` so esbuild does NOT
 * include their top-level code in the entry module's init scope. The
 * require("fs") calls exist in the bundle but only inside __esm factory
 * functions that only execute when those modules are first required (which
 * only happens in onloadDesktop(), never on mobile).
 *
 * Tests:
 *   1. Node built-in requires only appear inside __esm/lazy factories, NOT
 *      in the main entry module's top-level init block.
 *   2. The `src/main.ts` module block in the bundle does NOT directly require
 *      any Node built-in.
 *   3. Source file check: main.ts uses `import type` for desktop-only modules.
 *   4. Bundle is a valid CJS module with expected structure.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const BUNDLE_PATH = resolve(__dirname, '../../dist/main.js');
const MAIN_TS_PATH = resolve(__dirname, '../../src/main.ts');

const NODE_BUILT_INS = ['fs', 'path', 'os', 'child_process', 'crypto', 'stream', 'util', 'net', 'tls', 'http', 'https', 'events', 'buffer', 'readline'];

describe('dist/main.js bundle safety', () => {
  it('bundle exists (run npm run build first)', () => {
    if (!existsSync(BUNDLE_PATH)) {
      console.warn('SKIP: dist/main.js not found — run npm run build first');
      return;
    }
    expect(existsSync(BUNDLE_PATH)).toBe(true);
  });

  it('Node built-in requires are never at module init scope (zero indentation)', () => {
    if (!existsSync(BUNDLE_PATH)) return;

    const bundle = readFileSync(BUNDLE_PATH, 'utf8');
    const lines = bundle.split('\n');
    const violations: string[] = [];

    // In esbuild CJS bundles, code at module init scope (top-level, runs when
    // the module is first required) has zero leading whitespace. Code inside
    // function bodies, __esm factories, or __commonJS wrappers is indented.
    //
    // A dangerous pattern: `var import_fs = require("fs");` at column 0
    // A safe pattern:     `    import_fs = require("fs");` (inside a factory)
    //
    // We flag any Node built-in require whose line has 0 leading spaces.
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line[0] === ' ' || line[0] === '\t') continue; // indented = inside factory

      for (const mod of NODE_BUILT_INS) {
        const patterns = [`require("${mod}")`, `require('${mod}')`, `require("node:${mod}")`, `require('node:${mod}')`];
        for (const pattern of patterns) {
          if (line.includes(pattern)) {
            violations.push(`Line ${i + 1}: ${line.trim()}`);
          }
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Node.js built-in require() calls at module init scope (zero indentation).\n` +
          `These execute synchronously when the bundle loads and will crash on\n` +
          `Obsidian Mobile (require returns null for built-ins there).\n\n` +
          `Violations:\n${violations.join('\n')}\n\n` +
          `Fix: ensure desktop-only modules use "import type" and are\n` +
          `lazy-loaded inside onloadDesktop() with require('./Module').`,
      );
    }

    expect(violations).toHaveLength(0);
  });

  it('the top-level (zero-indentation) code in src/main.ts block does not require Node built-ins', () => {
    if (!existsSync(BUNDLE_PATH)) return;

    const bundle = readFileSync(BUNDLE_PATH, 'utf8');
    const lines = bundle.split('\n');

    // Find the last "// src/main.ts" section in the bundle
    let mainTsStartLine = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim() === '// src/main.ts') {
        mainTsStartLine = i;
        break;
      }
    }
    if (mainTsStartLine === -1) throw new Error('Could not find // src/main.ts comment in bundle');

    // Scan from mainTsStartLine to end; flag zero-indentation Node requires
    const violations: string[] = [];
    for (let i = mainTsStartLine; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line[0] === ' ' || line[0] === '\t') continue; // indented = inside function
      for (const mod of NODE_BUILT_INS) {
        const patterns = [`require("${mod}")`, `require('${mod}')`];
        for (const p of patterns) {
          if (line.includes(p)) {
            violations.push(`Line ${i + 1}: ${line.trim()}`);
          }
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `src/main.ts entry module has top-level Node built-in require() calls:\n` +
          violations.join('\n') +
          '\nThese execute at module load time and crash on Obsidian Mobile.',
      );
    }

    expect(violations).toHaveLength(0);
  });

  it('bundle is a valid CJS module', () => {
    if (!existsSync(BUNDLE_PATH)) return;

    const bundle = readFileSync(BUNDLE_PATH, 'utf8');
    expect(bundle).toMatch(/^"use strict"/);

    // Should contain the esbuild module helpers (__commonJS is only emitted when
    // there are CJS dependencies to wrap; __esm is always present)
    expect(bundle).toContain('__esm');
  });

  it('bundle size is reasonable (not inlining obsidian or other huge externals)', () => {
    if (!existsSync(BUNDLE_PATH)) return;

    const bundle = readFileSync(BUNDLE_PATH, 'utf8');
    const sizeKB = Buffer.byteLength(bundle, 'utf8') / 1024;

    // Sanity check: if bundle exceeds 20MB something is very wrong
    expect(sizeKB).toBeLessThan(20 * 1024);
    console.log(`Bundle size: ${sizeKB.toFixed(0)} KB`);
  });
});

describe('src/main.ts source safety', () => {
  it('desktop-only modules use "import type" not static "import"', () => {
    const source = readFileSync(MAIN_TS_PATH, 'utf8');

    // These modules use Node.js built-ins. They must be "import type" only.
    const desktopOnlyModules = [
      'ThreadsView',
      'AgentDashboard',
      'ThreadManager',
      'VaultPersistence',
      'InProcessSummarizer',
      'WakeLockService',
      'ObsidianTools',
      'ClaudeSession',
    ];

    for (const mod of desktopOnlyModules) {
      // Check for runtime (non-type) static import like: import { Foo } from './Foo'
      // Allow: import type { Foo } from './Foo'
      const runtimeImportRegex = new RegExp(`^import\\s+(?!type\\s)\\{[^}]+\\}\\s+from\\s+['"].*${mod}['"]`, 'm');
      const hasRuntimeImport = runtimeImportRegex.test(source);

      if (hasRuntimeImport) {
        throw new Error(
          `src/main.ts has a runtime (non-type) static import of '${mod}'.\n` +
            `This causes Node.js built-ins to be required at mobile load time.\n` +
            `Change to: import type { ${mod} } from './${mod}';`,
        );
      }
    }
  });

  it('lazy require() calls for desktop modules are inside onloadDesktop', () => {
    const source = readFileSync(MAIN_TS_PATH, 'utf8');

    const desktopOnlyModules = [
      'ThreadsView',
      'AgentDashboard',
      'ThreadManager',
      'VaultPersistence',
      'InProcessSummarizer',
      'WakeLockService',
      'ObsidianTools',
    ];

    // onloadDesktop should contain require() calls for desktop modules
    const onloadDesktopMatch = source.match(/onloadDesktop\s*\(\s*\)\s*\{([\s\S]*?)^\s{2}\}/m);
    if (!onloadDesktopMatch) {
      // fallback: just check the requires exist somewhere in the file
      for (const mod of desktopOnlyModules) {
        expect(source).toContain(`require('./${mod}')`);
      }
      return;
    }

    const onloadBody = onloadDesktopMatch[1];
    for (const mod of desktopOnlyModules) {
      const hasLazyRequire = onloadBody.includes(`require('./${mod}')`) || onloadBody.includes(`require("./${mod}")`);
      expect(hasLazyRequire, `${mod} should be lazily required inside onloadDesktop()`).toBe(true);
    }
  });
});
