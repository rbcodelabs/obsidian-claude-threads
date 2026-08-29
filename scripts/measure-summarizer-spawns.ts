#!/usr/bin/env node
/**
 * Empirical spawn-count measurement for the summarizer trigger fix.
 *
 * Replays a REAL recorded thread log (`Claude/logs/<thread_id>.jsonl`) through
 * both the old and the new auto-summarize trigger, then actually drives
 * `InProcessSummarizer.summarize()` for each fire with a stubbed `query()`,
 * counting real `_runQuery` invocations via the module's own spawn counter.
 *
 * Each `_runQuery` call spawns a `claude` subprocess in production, so the
 * counter is a direct proxy for spawn count.
 *
 * The real src modules are bundled with esbuild first: they use extensionless
 * TS imports that native Node ESM cannot resolve. The Claude Agent SDK is kept
 * external and intercepted, so no subprocess is ever actually spawned.
 *
 * Usage: node scripts/measure-summarizer-spawns.ts <path-to-log.jsonl>
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const logPath = process.argv[2];
if (!logPath) {
  console.error('usage: measure-summarizer-spawns.ts <path-to-log.jsonl>');
  process.exit(1);
}

// ── Bundle the real source under test ─────────────────────────────────────
const workDir = mkdtempSync(join(tmpdir(), 'summarizer-measure-'));
const entry = join(workDir, 'entry.ts');
const outfile = join(workDir, 'bundle.cjs');
writeFileSync(
  entry,
  `export { InProcessSummarizer, getSummarizerQueryCount, resetSummarizerQueryCount } from ${JSON.stringify(join(repoRoot, 'src/InProcessSummarizer.ts'))};\n` +
    `export { shouldAutoSummarize } from ${JSON.stringify(join(repoRoot, 'src/summarization.ts'))};\n`,
);

await build({
  entryPoints: [entry],
  bundle: true,
  outfile,
  platform: 'node',
  format: 'cjs',
  // Keep the SDK external so the stub below is what gets loaded.
  external: ['@anthropic-ai/claude-agent-sdk', 'obsidian'],
  logLevel: 'error',
});

// Intercept the SDK require so query() returns a canned response instead of
// spawning `claude`. The call still goes through the real _runQuery, so the
// spawn counter reflects exactly what production would have spawned.
const require_ = createRequire(import.meta.url);
const Module = require_('module');
const originalLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === '@anthropic-ai/claude-agent-sdk') {
    return {
      query: () =>
        (async function* () {
          yield {
            type: 'assistant',
            message: {
              content: [{ type: 'text', text: '{"title":"Replayed title","summary":"Replayed summary."}' }],
            },
          };
        })(),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const mod = require_(outfile);
const { InProcessSummarizer, getSummarizerQueryCount, resetSummarizerQueryCount, shouldAutoSummarize } = mod;

interface ChatMessage { id: string; role: string; content: string; timestamp: number }
interface Envelope { type?: string; event?: any }

const entries: Envelope[] = readFileSync(logPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line) as Envelope;
    } catch {
      return {};
    }
  });

// ── Reconstruct the ThreadsView-visible event stream ───────────────────────
//
// ThreadSession emits `{type:'message'}` for every SDK `assistant` message that
// has text parts OR tool_use parts (ThreadSession.ts `case 'assistant'`), and
// `{type:'done'}` once per completed turn from onDone (driven by `result`).
type ViewEvent =
  | { kind: 'message'; content: string; ts: number }
  | { kind: 'done'; ts: number }
  | { kind: 'user'; content: string; ts: number };

const events: ViewEvent[] = [];
let ts = 0;
let userTurns = 0;
let toolOnlyMessages = 0;
let subAgentMessages = 0;

for (const e of entries) {
  ts++;
  if (e.type === 'session_start') {
    const prompt = typeof e.event?.prompt === 'string' ? e.event.prompt : '';
    if (prompt) {
      userTurns++;
      events.push({ kind: 'user', content: prompt, ts });
    }
    continue;
  }
  if (e.type === 'assistant') {
    const blocks = e.event?.message?.content;
    if (!Array.isArray(blocks)) continue;
    const text = blocks.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n');
    const hasToolUse = blocks.some((b: any) => b?.type === 'tool_use');
    if (!text && !hasToolUse) continue; // ThreadSession emits nothing for these
    if (!text) toolOnlyMessages++;
    if (e.event?.parent_tool_use_id) subAgentMessages++;
    events.push({ kind: 'message', content: text, ts });
    continue;
  }
  if (e.type === 'result') {
    events.push({ kind: 'done', ts });
  }
}

// ── Replay both triggers ──────────────────────────────────────────────────
const summarizer = new InProcessSummarizer();

async function replay(
  trigger: 'message' | 'done',
  useGate: boolean,
): Promise<{ fires: number; spawns: number }> {
  resetSummarizerQueryCount();
  const messages: ChatMessage[] = [];
  const thread: { summary?: string; lastSummarizedAt?: number; titleUserSet?: boolean } = {};
  let fires = 0;
  let inFlight = false;

  for (const ev of events) {
    if (ev.kind === 'user') {
      messages.push({ id: `u${ev.ts}`, role: 'user', content: ev.content, timestamp: ev.ts });
      continue;
    }
    if (ev.kind === 'message') {
      messages.push({ id: `a${ev.ts}`, role: 'assistant', content: ev.content, timestamp: ev.ts });
    }
    if (ev.kind !== trigger) continue;

    const fire = useGate
      ? shouldAutoSummarize({
          summarizationEnabled: true,
          autoSummarize: false,
          titleUserSet: thread.titleUserSet,
          inFlight,
          messages,
          lastSummarizedAt: thread.lastSummarizedAt,
        })
      : // Old behaviour: settings.summarizationEnabled && !thread.titleUserSet
        !thread.titleUserSet;

    if (!fire) continue;
    fires++;
    inFlight = true;
    const result = await summarizer.summarize(
      messages,
      '/usr/bin/claude',
      'haiku',
      '',
      undefined,
      thread.summary,
      thread.lastSummarizedAt,
      'Thread 1',
    );
    inFlight = false;
    if (useGate) {
      if (result.summary) thread.summary = result.summary;
      thread.lastSummarizedAt = ev.ts;
    }
  }
  return { fires, spawns: getSummarizerQueryCount() };
}

const before = await replay('message', false);
const after = await replay('done', true);

const doneEvents = events.filter((e) => e.kind === 'done').length;
const messageEvents = events.filter((e) => e.kind === 'message').length;

console.log(`log:                    ${logPath.split('/').pop()}`);
console.log(`log entries:            ${entries.length}`);
console.log(`user turns:             ${userTurns}`);
console.log(`'message' events:       ${messageEvents}  (tool-only: ${toolOnlyMessages}, sub-agent: ${subAgentMessages})`);
console.log(`'done' events:          ${doneEvents}`);
console.log('');
console.log(`BEFORE (trigger=message, no gate)  fires: ${before.fires}   subprocess spawns: ${before.spawns}`);
console.log(`AFTER  (trigger=done,  new gate)   fires: ${after.fires}   subprocess spawns: ${after.spawns}`);
console.log('');
console.log(`spawn reduction:        ${(before.spawns / Math.max(after.spawns, 1)).toFixed(1)}x  (${before.spawns} -> ${after.spawns})`);
console.log(`AFTER spawns vs turns:  ${after.spawns} spawns / ${userTurns} user turns`);

rmSync(workDir, { recursive: true, force: true });
