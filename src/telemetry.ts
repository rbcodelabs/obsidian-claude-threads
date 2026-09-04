/**
 * telemetry.ts — always-on, LOCAL-ONLY diagnostics for Claude Threads.
 *
 * NOTHING here ever leaves the machine: no network calls, no remote reporting.
 * It maintains in-memory counters, a short ring of renderer performance samples,
 * and a longtask summary, plus a PURE `buildDiagnosticsReport()` that renders a
 * redacted markdown + JSON bundle a user can paste into a GitHub issue.
 *
 * Desktop-only: every collector is gated on `!Platform.isMobile` and lazily
 * `require()`s Node built-ins (`os`, `perf_hooks`) the same way the rest of the
 * plugin does (see main.ts / ThreadManager.ts). On mobile it is a complete no-op.
 *
 * The counters are deliberately cheap (integer bumps) so instrumenting hot paths
 * costs nothing measurable. The perf sampler only runs while a plugin view is open
 * and nothing here reaches for `@electron/remote` or any Geode API — the numbers
 * are all reachable from the renderer today, so it works in real Obsidian too.
 */
import { Platform } from 'obsidian';
import type { LogEntry } from './logger';

/** Where a child-process spawn originated, for the spawn counter breakdown. */
export type SpawnSource = 'statusline' | 'gitdiff' | 'other';

export interface TelemetryCounters {
  /** Times KanbanView.scheduleRender() was requested (pre-coalescing). */
  rendersScheduled: number;
  /** Times KanbanView.render() did a full board rebuild (post-coalescing). */
  kanbanFullRebuilds: number;
  /** Child-process spawns, keyed by source. */
  spawns: Record<SpawnSource, number>;
  /** saveSettings() calls (may coalesce into fewer disk writes). */
  savesRequested: number;
  /** Actual data.json disk writes performed by the save loop. */
  savesWritten: number;
}

export interface PerfSample {
  /** Epoch ms. */
  ts: number;
  /** Renderer CPU user time (ms) consumed since the previous sample. */
  cpuUserMs: number;
  /** Renderer CPU system time (ms) consumed since the previous sample. */
  cpuSystemMs: number;
  /** Resident set size (MB) at sample time. */
  rssMb: number;
  /** V8 heap used (MB) at sample time. */
  heapUsedMb: number;
  /** 1-minute system load average. */
  loadAvg1: number;
  /** Logical CPU count. */
  cpuCount: number;
}

export interface LongtaskSummary {
  /** Total longtasks observed since load (or last reset). */
  count: number;
  /** The worst (longest) durations in ms, descending, capped. */
  worstMs: number[];
}

export interface TelemetrySnapshot {
  counters: TelemetryCounters;
  perfSamples: PerfSample[];
  longtask: LongtaskSummary;
}

/** Injected dependencies for the collectors (desktop only). */
export interface TelemetryInitDeps {
  /** True while at least one plugin view is open — gates the perf sampler. */
  isViewOpen: () => boolean;
}

const PERF_SAMPLE_INTERVAL_MS = 10_000;
const PERF_RING_CAPACITY = 360; // ~1 hour at one sample / 10s
const LONGTASK_WORST_CAPACITY = 20;

function emptyCounters(): TelemetryCounters {
  return {
    rendersScheduled: 0,
    kanbanFullRebuilds: 0,
    spawns: { statusline: 0, gitdiff: 0, other: 0 },
    savesRequested: 0,
    savesWritten: 0,
  };
}

class Telemetry {
  /** Local-only master switch. Default on (safe: nothing leaves the machine). */
  private enabled = true;
  private readonly mobile = Platform.isMobile;

  private counters = emptyCounters();
  private perfRing: PerfSample[] = [];
  private longtaskCount = 0;
  private longtaskWorst: number[] = [];

  private isViewOpen: (() => boolean) | null = null;
  private sampleTimer: ReturnType<typeof setInterval> | null = null;
  private lastCpu: { user: number; system: number } | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private longtaskObserver: any = null;
  private initialized = false;

  /** Whether counters/samplers are active right now. */
  isEnabled(): boolean {
    return this.enabled && !this.mobile;
  }

  /**
   * Enable/disable at runtime (from the settings toggle). Disabling stops the
   * sampler and turns counter bumps into no-ops; existing data is retained so a
   * report taken right after disabling still shows history.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (this.mobile) return;
    if (enabled) {
      if (this.initialized) this.startSampler();
    } else {
      this.stopSampler();
    }
  }

  /**
   * Wire up the desktop collectors. Safe to call once from onloadDesktop; a no-op
   * on mobile or if already initialized. `isViewOpen` gates the perf sampler.
   */
  init(deps: TelemetryInitDeps): void {
    if (this.mobile || this.initialized) return;
    this.initialized = true;
    this.isViewOpen = deps.isViewOpen;
    this.startLongtaskObserver();
    if (this.enabled) this.startSampler();
  }

  /** Stop all collectors and release timers/observers (from onunload). */
  dispose(): void {
    this.stopSampler();
    this.stopLongtaskObserver();
    this.isViewOpen = null;
    this.initialized = false;
  }

  // ── Counter bumps (hot-path safe; guarded) ────────────────────────────────

  recordRenderScheduled(): void {
    if (!this.isEnabled()) return;
    this.counters.rendersScheduled++;
  }

  recordKanbanFullRebuild(): void {
    if (!this.isEnabled()) return;
    this.counters.kanbanFullRebuilds++;
  }

  recordSpawn(source: SpawnSource): void {
    if (!this.isEnabled()) return;
    this.counters.spawns[source]++;
  }

  recordSaveRequested(): void {
    if (!this.isEnabled()) return;
    this.counters.savesRequested++;
  }

  recordSaveWritten(): void {
    if (!this.isEnabled()) return;
    this.counters.savesWritten++;
  }

  // ── Snapshot / reset ──────────────────────────────────────────────────────

  /** Deep-ish copy of current state for report assembly. */
  snapshot(): TelemetrySnapshot {
    return {
      counters: {
        ...this.counters,
        spawns: { ...this.counters.spawns },
      },
      perfSamples: [...this.perfRing],
      longtask: { count: this.longtaskCount, worstMs: [...this.longtaskWorst] },
    };
  }

  /** Reset all counters + rings. Primarily for tests. */
  reset(): void {
    this.counters = emptyCounters();
    this.perfRing = [];
    this.longtaskCount = 0;
    this.longtaskWorst = [];
    this.lastCpu = null;
  }

  // ── Perf sampler ──────────────────────────────────────────────────────────

  private startSampler(): void {
    if (this.mobile || this.sampleTimer) return;
    // Baseline the CPU counter so the first recorded delta covers one interval,
    // not the whole process lifetime.
    this.lastCpu = this.readCpu();
    this.sampleTimer = setInterval(() => this.sampleOnce(), PERF_SAMPLE_INTERVAL_MS);
  }

  private stopSampler(): void {
    if (this.sampleTimer) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
  }

  private readCpu(): { user: number; system: number } | null {
    try {
      const u = process.cpuUsage();
      return { user: u.user, system: u.system };
    } catch {
      return null;
    }
  }

  /**
   * Take a single perf sample. Guarded: only records while enabled, on desktop,
   * and while a plugin view is open (idle views cost nothing). Exposed for tests.
   */
  sampleOnce(): void {
    if (!this.isEnabled()) return;
    if (this.isViewOpen && !this.isViewOpen()) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const os = require('os') as typeof import('os');
      const cpu = this.readCpu();
      let cpuUserMs = 0;
      let cpuSystemMs = 0;
      if (cpu && this.lastCpu) {
        cpuUserMs = (cpu.user - this.lastCpu.user) / 1000;
        cpuSystemMs = (cpu.system - this.lastCpu.system) / 1000;
      }
      if (cpu) this.lastCpu = cpu;

      const mem = process.memoryUsage();
      const sample: PerfSample = {
        ts: Date.now(),
        cpuUserMs: Math.round(cpuUserMs),
        cpuSystemMs: Math.round(cpuSystemMs),
        rssMb: Math.round(mem.rss / (1024 * 1024)),
        heapUsedMb: Math.round(mem.heapUsed / (1024 * 1024)),
        loadAvg1: Math.round(os.loadavg()[0] * 100) / 100,
        cpuCount: os.cpus().length,
      };
      this.perfRing.push(sample);
      while (this.perfRing.length > PERF_RING_CAPACITY) this.perfRing.shift();
    } catch {
      // Best-effort: a sampling failure must never disrupt the plugin.
    }
  }

  // ── Longtask observer ─────────────────────────────────────────────────────

  private startLongtaskObserver(): void {
    if (this.mobile || this.longtaskObserver) return;
    try {
      // PerformanceObserver('longtask') is a renderer/browser API. In Node (tests)
      // the entry type is unsupported and observe() throws — caught and skipped.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const PO = (globalThis as any).PerformanceObserver;
      if (typeof PO !== 'function') return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.longtaskObserver = new PO((list: any) => {
        if (!this.isEnabled()) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const entry of list.getEntries() as any[]) {
          this.recordLongtask(entry.duration as number);
        }
      });
      this.longtaskObserver.observe({ entryTypes: ['longtask'] });
    } catch {
      this.longtaskObserver = null;
    }
  }

  private stopLongtaskObserver(): void {
    if (this.longtaskObserver) {
      try {
        this.longtaskObserver.disconnect();
      } catch {
        /* ignore */
      }
      this.longtaskObserver = null;
    }
  }

  private recordLongtask(durationMs: number): void {
    if (!Number.isFinite(durationMs)) return;
    this.longtaskCount++;
    this.longtaskWorst.push(Math.round(durationMs));
    this.longtaskWorst.sort((a, b) => b - a);
    if (this.longtaskWorst.length > LONGTASK_WORST_CAPACITY) {
      this.longtaskWorst.length = LONGTASK_WORST_CAPACITY;
    }
  }
}

/** Process-wide telemetry singleton. */
export const telemetry = new Telemetry();

// ── Redaction ────────────────────────────────────────────────────────────────

// A POSIX path run, with an optional leading `~`. A home-relative run (`~/…`) is
// kept human-readable; any other multi-segment absolute path is reduced to
// `…/<basename>` so it can't leak a username or directory layout.
const POSIX_PATH_RE = /(~)?((?:\/[A-Za-z0-9._@%+-]+)+)/g;
// Windows absolute path (e.g. C:\Users\rick\x).
const WIN_PATH_RE = /[A-Za-z]:\\[^\s"']+/g;
// KEY=value where KEY looks secret-ish — the value is dropped entirely.
const SECRET_ASSIGN_RE = /\b([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|PASS|AUTH|CREDENTIAL)[A-Z0-9_]*)\s*=\s*[^\s"']+/gi;

/**
 * Redact a free-text string for inclusion in a diagnostics bundle:
 *  - the user's home directory is collapsed to `~` (no username leak),
 *  - any remaining non-home absolute path is reduced to `…/<basename>`,
 *  - obvious `SECRET=value` assignments have their value stripped.
 *
 * Pure and deterministic — safe to unit-test.
 */
export function redactText(text: string, homedir?: string): string {
  let s = String(text);
  if (homedir && homedir.length > 0) {
    // Collapse the home dir to ~ before path reduction so home paths stay
    // human-readable (`~/projects/x`) rather than being basename-crushed.
    s = s.split(homedir).join('~');
  }
  s = s.replace(SECRET_ASSIGN_RE, (_m, key: string) => `${key}=<redacted>`);
  s = s.replace(POSIX_PATH_RE, (m: string, tilde: string | undefined, path: string) => {
    // Home-relative (`~/…`) paths are already username-free — keep them readable.
    if (tilde) return m;
    const segs = path.split('/').filter(Boolean);
    // Leave single-segment paths (e.g. `/tmp`) alone; only crush deeper paths
    // that could reveal a username or private directory layout.
    if (segs.length < 2) return m;
    return `…/${segs[segs.length - 1]}`;
  });
  s = s.replace(WIN_PATH_RE, (m) => {
    const base = m.split('\\').pop() ?? '';
    return `…\\${base}`;
  });
  return s;
}

// ── Diagnostics report (pure) ─────────────────────────────────────────────────

export interface DiagnosticsInput {
  /** Plugin version from manifest.json. */
  pluginVersion: string;
  host: {
    /** 'obsidian' or 'geode' (or whatever the host reports). */
    app: string;
    /** Host/API version string, best-effort. */
    version: string;
    /** e.g. process.platform. */
    platform: string;
    /** e.g. process.arch. */
    arch: string;
  };
  system: {
    cpuCount: number;
    totalMemMb: number;
    loadAvg: number[];
  };
  vault: {
    fileCount: number;
    dataJsonSizeBytes: number;
  };
  threads: {
    total: number;
    running: number;
  };
  counters: TelemetryCounters;
  perfSamples: PerfSample[];
  longtask: LongtaskSummary;
  /** Recent log ring tail (redacted before rendering). */
  logEntries: LogEntry[];
  /** Home directory used for path redaction. */
  homedir?: string;
  /** Epoch ms the report was generated. */
  generatedAt: number;
}

/**
 * Build a redacted diagnostics report. PURE: no I/O, no telemetry access — every
 * input is injected, so it is fully unit-testable.
 *
 * REDACTION GUARANTEES:
 *  - No thread/message content is ever included (not accepted by this signature).
 *  - Log messages are passed through redactText (home → ~, paths → basename,
 *    SECRET=value stripped).
 *  - No environment variable values are included.
 */
export function buildDiagnosticsReport(input: DiagnosticsInput): { markdown: string; json: string } {
  const home = input.homedir;
  const iso = (ms: number) => new Date(ms).toISOString();

  const redactedLog = input.logEntries.map((e) => ({
    ts: e.ts,
    level: e.level,
    category: e.category,
    msg: redactText(e.msg, home),
  }));

  // Structured, redacted object — the JSON payload and the source for markdown.
  const structured = {
    generatedAt: iso(input.generatedAt),
    plugin: { version: input.pluginVersion },
    host: input.host,
    system: {
      cpuCount: input.system.cpuCount,
      totalMemMb: input.system.totalMemMb,
      loadAvg: input.system.loadAvg,
    },
    vault: {
      fileCount: input.vault.fileCount,
      dataJsonSizeBytes: input.vault.dataJsonSizeBytes,
    },
    threads: input.threads,
    counters: input.counters,
    perfSamples: input.perfSamples,
    longtask: input.longtask,
    recentLog: redactedLog,
  };

  const json = JSON.stringify(structured, null, 2);
  const c = input.counters;

  const lines: string[] = [];
  lines.push('# Claude Threads — Diagnostics Report');
  lines.push('');
  lines.push(`Generated: ${iso(input.generatedAt)}`);
  lines.push('');
  lines.push('_Local-only diagnostics. No message content, file contents, absolute home paths, or env values are included._');
  lines.push('');

  lines.push('## Environment');
  lines.push('');
  lines.push(`- Plugin version: ${input.pluginVersion}`);
  lines.push(`- Host: ${input.host.app} ${input.host.version}`);
  lines.push(`- Platform: ${input.host.platform} / ${input.host.arch}`);
  lines.push(`- CPUs: ${input.system.cpuCount}`);
  lines.push(`- Total memory: ${input.system.totalMemMb} MB`);
  lines.push(`- Load average: ${input.system.loadAvg.map((n) => n.toFixed(2)).join(', ')}`);
  lines.push('');

  lines.push('## Vault & threads');
  lines.push('');
  lines.push(`- Vault files: ${input.vault.fileCount}`);
  lines.push(`- data.json size: ${input.vault.dataJsonSizeBytes} bytes`);
  lines.push(`- Threads: ${input.threads.total} (${input.threads.running} running)`);
  lines.push('');

  lines.push('## Counters');
  lines.push('');
  lines.push(`- Renders scheduled: ${c.rendersScheduled}`);
  lines.push(`- Agent Board full rebuilds: ${c.kanbanFullRebuilds}`);
  lines.push(`- Spawns — statusline: ${c.spawns.statusline}, gitdiff: ${c.spawns.gitdiff}, other: ${c.spawns.other}`);
  lines.push(`- Saves requested: ${c.savesRequested}`);
  lines.push(`- Saves written: ${c.savesWritten}`);
  lines.push('');

  lines.push('## Longtasks');
  lines.push('');
  lines.push(`- Count: ${input.longtask.count}`);
  lines.push(
    `- Worst (ms): ${input.longtask.worstMs.length ? input.longtask.worstMs.join(', ') : 'none observed'}`,
  );
  lines.push('');

  lines.push('## Performance samples');
  lines.push('');
  if (input.perfSamples.length === 0) {
    lines.push('_No samples captured (view may not have been open)._');
  } else {
    lines.push('| time | cpuUser ms | cpuSys ms | rss MB | heap MB | load1 |');
    lines.push('|---|---|---|---|---|---|');
    for (const s of input.perfSamples) {
      lines.push(
        `| ${iso(s.ts)} | ${s.cpuUserMs} | ${s.cpuSystemMs} | ${s.rssMb} | ${s.heapUsedMb} | ${s.loadAvg1} |`,
      );
    }
  }
  lines.push('');

  lines.push('## Recent log');
  lines.push('');
  if (redactedLog.length === 0) {
    lines.push('_No log entries retained._');
  } else {
    lines.push('```');
    for (const e of redactedLog) {
      const cat = e.category ? ` [${e.category}]` : '';
      lines.push(`${iso(e.ts)} ${e.level.toUpperCase()}${cat} ${e.msg}`);
    }
    lines.push('```');
  }
  lines.push('');

  return { markdown: lines.join('\n'), json };
}
