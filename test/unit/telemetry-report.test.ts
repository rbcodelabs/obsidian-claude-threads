import { describe, it, expect } from 'vitest';
import {
  buildDiagnosticsReport,
  redactText,
  type DiagnosticsInput,
} from '../../src/telemetry';
import type { LogEntry } from '../../src/logger';

const HOME = '/Users/rick';

function makeInput(logEntries: LogEntry[]): DiagnosticsInput {
  return {
    pluginVersion: '0.25.7',
    host: { app: 'obsidian', version: '1.5.0', platform: 'darwin', arch: 'arm64' },
    system: { cpuCount: 8, totalMemMb: 16384, loadAvg: [1.2, 1.1, 0.9] },
    vault: { fileCount: 1234, dataJsonSizeBytes: 456789 },
    threads: { total: 12, running: 3 },
    counters: {
      rendersScheduled: 40,
      kanbanFullRebuilds: 4,
      spawns: { statusline: 30, gitdiff: 90, other: 0 },
      savesRequested: 100,
      savesWritten: 12,
    },
    perfSamples: [
      { ts: 1_700_000_000_000, cpuUserMs: 120, cpuSystemMs: 30, rssMb: 512, heapUsedMb: 128, loadAvg1: 1.2, cpuCount: 8 },
    ],
    longtask: { count: 3, worstMs: [220, 180, 90] },
    logEntries,
    homedir: HOME,
    generatedAt: 1_700_000_050_000,
  };
}

describe('redactText', () => {
  it('collapses the home directory to ~', () => {
    expect(redactText(`${HOME}/vault/notes.md`, HOME)).toBe('~/vault/notes.md');
  });

  it('reduces a non-home absolute POSIX path to …/<basename>', () => {
    expect(redactText('reading /opt/company/secret-config/app.json now', HOME)).toBe(
      'reading …/app.json now',
    );
  });

  it('strips values from secret-looking KEY=value assignments', () => {
    expect(redactText('env AWS_SECRET_ACCESS_KEY=abc123XYZ set', HOME)).toBe(
      'env AWS_SECRET_ACCESS_KEY=<redacted> set',
    );
    expect(redactText('GITHUB_TOKEN=ghp_deadbeef', HOME)).toBe('GITHUB_TOKEN=<redacted>');
  });

  it('reduces Windows absolute paths to a basename', () => {
    expect(redactText('opened C:\\Users\\rick\\vault\\notes.md', HOME)).toContain('notes.md');
    expect(redactText('opened C:\\Users\\rick\\vault\\notes.md', HOME)).not.toContain('rick');
  });

  it('leaves home-relative ~ paths human-readable (no basename crushing)', () => {
    expect(redactText('~/projects/x/y.ts', HOME)).toBe('~/projects/x/y.ts');
  });
});

describe('buildDiagnosticsReport — redaction guarantees', () => {
  const secretLogs: LogEntry[] = [
    { ts: 1_700_000_000_100, level: 'info', msg: `opened ${HOME}/vault/private-notes.md` },
    { ts: 1_700_000_000_200, level: 'warn', category: 'git', msg: 'clone /opt/company/secret-config/app.json failed' },
    { ts: 1_700_000_000_300, level: 'error', msg: 'AWS_SECRET_ACCESS_KEY=abc123XYZ rejected' },
    { ts: 1_700_000_000_400, level: 'info', msg: 'user message content: my private diary entry' },
  ];

  it('never leaks the absolute home path (collapsed to ~)', () => {
    const { markdown, json } = buildDiagnosticsReport(makeInput(secretLogs));
    expect(markdown).not.toContain(HOME);
    expect(json).not.toContain(HOME);
    expect(markdown).toContain('~/vault/private-notes.md');
  });

  it('never leaks a non-home absolute path', () => {
    const { markdown, json } = buildDiagnosticsReport(makeInput(secretLogs));
    expect(markdown).not.toContain('/opt/company');
    expect(json).not.toContain('/opt/company');
    expect(markdown).toContain('…/app.json');
  });

  it('never leaks secret env values', () => {
    const { markdown, json } = buildDiagnosticsReport(makeInput(secretLogs));
    expect(markdown).not.toContain('abc123XYZ');
    expect(json).not.toContain('abc123XYZ');
    expect(markdown).toContain('AWS_SECRET_ACCESS_KEY=<redacted>');
  });

  it('produces parseable JSON that mirrors the counters/samples', () => {
    const { json } = buildDiagnosticsReport(makeInput(secretLogs));
    const parsed = JSON.parse(json);
    expect(parsed.plugin.version).toBe('0.25.7');
    expect(parsed.counters.spawns.gitdiff).toBe(90);
    expect(parsed.perfSamples).toHaveLength(1);
    expect(parsed.recentLog).toHaveLength(4);
    // The redacted log survives into the JSON payload too.
    expect(parsed.recentLog[0].msg).toBe('opened ~/vault/private-notes.md');
    expect(JSON.stringify(parsed)).not.toContain(HOME);
  });

  it('renders the core sections in the markdown', () => {
    const { markdown } = buildDiagnosticsReport(makeInput(secretLogs));
    for (const heading of [
      '# Agent Threads — Diagnostics Report',
      '## Environment',
      '## Vault & threads',
      '## Counters',
      '## Longtasks',
      '## Performance samples',
      '## Recent log',
    ]) {
      expect(markdown).toContain(heading);
    }
    expect(markdown).toContain('Plugin version: 0.25.7');
    expect(markdown).toContain('gitdiff: 90');
  });

  it('handles empty samples/logs gracefully', () => {
    const input = makeInput([]);
    input.perfSamples = [];
    const { markdown } = buildDiagnosticsReport(input);
    expect(markdown).toContain('No samples captured');
    expect(markdown).toContain('No log entries retained');
  });
});
