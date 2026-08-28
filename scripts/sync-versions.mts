#!/usr/bin/env node
/**
 * Keep versions.json in step with manifest.json (and, on demand, with every
 * released git tag).
 *
 * Why this exists: `.github/workflows/release.yml` used to prepend the new
 * entry to versions.json at tag-push time and attach the result as a release
 * asset — but it never committed that file back to the repo. So the working
 * copy stayed frozen and every release re-derived its asset from an
 * increasingly stale base. By v0.27.10 the repo copy was missing 106 of the
 * released versions, all the way back to 0.1.0.
 *
 * Modes:
 *   (default)    ensure versions.json contains manifest.json's current version
 *   --backfill   reconcile against every vX.Y.Z tag, reading each tag's own
 *                manifest.json for its minAppVersion (never assumed)
 *   --check      verify only; exit 1 if out of sync. Used by CI so the drift
 *                cannot silently come back.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const VERSIONS = 'versions.json';
const MANIFEST = 'manifest.json';

const mode = process.argv.includes('--check')
  ? 'check'
  : process.argv.includes('--backfill')
    ? 'backfill'
    : 'sync';

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

/** Ascending semver sort so diffs stay stable and reviewable. */
const bySemver = (a: string, b: string): number => {
  const parse = (v: string) => v.split('.').map((n) => parseInt(n, 10) || 0);
  const [aM, aN, aP] = parse(a);
  const [bM, bN, bP] = parse(b);
  return aM - bM || aN - bN || aP - bP;
};

/** Only plain X.Y.Z versions belong here — no prerelease/beta tags. */
const isReleaseVersion = (v: string) => /^\d+\.\d+\.\d+$/.test(v);

const manifest = readJson(MANIFEST) as { version: string; minAppVersion: string };
const versions = readJson(VERSIONS) as Record<string, string>;
const before = JSON.stringify(versions);

const added: string[] = [];

if (mode === 'backfill') {
  const tags = execFileSync('git', ['tag', '-l', 'v*'], { encoding: 'utf8' })
    .split('\n')
    .map((t) => t.trim().replace(/^v/, ''))
    .filter(isReleaseVersion);

  for (const v of tags) {
    if (versions[v]) continue;
    let minApp = manifest.minAppVersion;
    try {
      const tagged = JSON.parse(
        execFileSync('git', ['show', `v${v}:${MANIFEST}`], { encoding: 'utf8' }),
      ) as { minAppVersion?: string };
      if (tagged.minAppVersion) minApp = tagged.minAppVersion;
    } catch {
      // Tag exists but has no readable manifest — fall back to current.
    }
    versions[v] = minApp;
    added.push(v);
  }
}

// Always ensure the version currently in manifest.json is present.
if (isReleaseVersion(manifest.version) && !versions[manifest.version]) {
  versions[manifest.version] = manifest.minAppVersion;
  added.push(manifest.version);
}

const sorted: Record<string, string> = {};
for (const k of Object.keys(versions).sort(bySemver)) sorted[k] = versions[k];

if (mode === 'check') {
  const missing = added.length > 0;
  const unsorted = JSON.stringify(sorted) !== before;
  if (missing) {
    console.error(
      `versions.json is out of sync: missing ${added.join(', ')}.\n` +
        `Run: npm run sync-versions`,
    );
    process.exit(1);
  }
  if (unsorted) {
    console.error('versions.json is not in canonical order. Run: npm run sync-versions');
    process.exit(1);
  }
  console.log(`versions.json in sync (${Object.keys(sorted).length} entries).`);
  process.exit(0);
}

writeFileSync(VERSIONS, JSON.stringify(sorted, null, 2) + '\n');
console.log(
  added.length
    ? `versions.json: added ${added.length} entr${added.length === 1 ? 'y' : 'ies'} ` +
        `(${added.slice(0, 5).join(', ')}${added.length > 5 ? ', …' : ''}); ` +
        `${Object.keys(sorted).length} total.`
    : `versions.json already in sync (${Object.keys(sorted).length} entries).`,
);
