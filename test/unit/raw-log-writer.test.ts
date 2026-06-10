import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RawLogWriter } from '../../src/RawLogWriter';

// ---------------------------------------------------------------------------
// RawLogWriter writes to the real filesystem (it uses require('fs')), so each
// test points it at a throwaway temp directory and reads the result back.
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-rawlog-test-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Wait for the writer's async append chain for a thread to settle. */
async function settle(): Promise<void> {
  // Two macrotask hops are enough for the mkdir + appendFile promise chain.
  await new Promise((r) => setTimeout(r, 20));
}

function makeWriter(folder = 'Claude') {
  return new RawLogWriter(
    () => tmpRoot,
    () => folder,
  );
}

function logLines(threadId: string, folder = 'Claude'): Record<string, unknown>[] {
  const file = path.join(tmpRoot, folder, 'logs', `${threadId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe('RawLogWriter.shouldLog', () => {
  it('filters out partial streaming token deltas', () => {
    expect(RawLogWriter.shouldLog('stream_event')).toBe(false);
  });

  it('keeps every other event type', () => {
    for (const t of ['assistant', 'user', 'result', 'system', 'session_start', undefined]) {
      expect(RawLogWriter.shouldLog(t)).toBe(true);
    }
  });
});

describe('RawLogWriter.vaultRelativePath', () => {
  it('keys the log by thread id under <folder>/logs', () => {
    const w = makeWriter('Claude');
    expect(w.vaultRelativePath('abc-123')).toBe('Claude/logs/abc-123.jsonl');
  });

  it('falls back to Claude when the folder is empty', () => {
    const w = new RawLogWriter(() => tmpRoot, () => '');
    expect(w.vaultRelativePath('t1')).toBe('Claude/logs/t1.jsonl');
  });
});

describe('RawLogWriter.append', () => {
  it('writes one wrapped JSONL line per event with ts/threadId/type/event', async () => {
    const w = makeWriter();
    w.append('t1', 'sess-9', 'assistant', { type: 'assistant', message: { text: 'hi' } });
    await settle();

    const lines = logLines('t1');
    expect(lines).toHaveLength(1);
    const line = lines[0] as Record<string, unknown>;
    expect(line.threadId).toBe('t1');
    expect(line.sessionId).toBe('sess-9');
    expect(line.type).toBe('assistant');
    expect(typeof line.ts).toBe('string');
    expect((line.event as Record<string, unknown>).message).toEqual({ text: 'hi' });
  });

  it('appends in arrival order across multiple events', async () => {
    const w = makeWriter();
    w.append('t2', undefined, 'session_start', { type: 'session_start' });
    w.append('t2', undefined, 'assistant', { type: 'assistant', n: 1 });
    w.append('t2', undefined, 'result', { type: 'result', cost: 0.02 });
    await settle();

    const types = logLines('t2').map((l) => l.type);
    expect(types).toEqual(['session_start', 'assistant', 'result']);
  });

  it('keeps logs for different threads in separate files', async () => {
    const w = makeWriter();
    w.append('a', undefined, 'assistant', { type: 'assistant' });
    w.append('b', undefined, 'assistant', { type: 'assistant' });
    await settle();

    expect(logLines('a')).toHaveLength(1);
    expect(logLines('b')).toHaveLength(1);
  });

  it('does nothing when the vault root is unknown', async () => {
    const w = new RawLogWriter(() => '', () => 'Claude');
    w.append('t3', undefined, 'assistant', { type: 'assistant' });
    await settle();
    // No file should have been created anywhere under tmpRoot.
    expect(fs.existsSync(path.join(tmpRoot, 'Claude'))).toBe(false);
  });

  it('degrades gracefully on a non-serializable payload', async () => {
    const w = makeWriter();
    const circular: Record<string, unknown> = { type: 'assistant' };
    circular.self = circular;
    w.append('t4', undefined, 'assistant', circular);
    await settle();

    const lines = logLines('t4');
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toBe('[unserializable]');
    expect(lines[0].type).toBe('assistant');
  });
});

describe('RawLogWriter.read', () => {
  it('returns null when no log file exists yet', async () => {
    const w = makeWriter();
    expect(await w.read('missing')).toBeNull();
  });

  it('returns null when the vault root is unknown', async () => {
    const w = new RawLogWriter(() => '', () => 'Claude');
    expect(await w.read('t1')).toBeNull();
  });

  it('parses every appended entry and reports the absolute path', async () => {
    const w = makeWriter();
    w.append('r1', 's', 'session_start', { type: 'session_start' });
    w.append('r1', 's', 'assistant', { type: 'assistant', n: 1 });
    await settle();

    const res = await w.read('r1');
    expect(res).not.toBeNull();
    expect(res!.total).toBe(2);
    expect(res!.returned).toBe(2);
    expect(res!.path).toBe(path.join(tmpRoot, 'Claude', 'logs', 'r1.jsonl'));
    expect(res!.entries.map((e) => e.type)).toEqual(['session_start', 'assistant']);
  });

  it('tails to the most recent `limit` entries', async () => {
    const w = makeWriter();
    for (let i = 0; i < 5; i++) w.append('r2', undefined, 'assistant', { type: 'assistant', n: i });
    await settle();

    const res = await w.read('r2', { limit: 2 });
    expect(res!.total).toBe(5);
    expect(res!.returned).toBe(2);
    expect(res!.entries.map((e) => (e.event as { n: number }).n)).toEqual([3, 4]);
  });

  it('filters by type before tailing, and limit 0 returns all', async () => {
    const w = makeWriter();
    w.append('r3', undefined, 'session_start', { type: 'session_start' });
    w.append('r3', undefined, 'assistant', { type: 'assistant', n: 0 });
    w.append('r3', undefined, 'result', { type: 'result' });
    w.append('r3', undefined, 'assistant', { type: 'assistant', n: 1 });
    await settle();

    const res = await w.read('r3', { type: 'assistant', limit: 0 });
    expect(res!.total).toBe(2);
    expect(res!.returned).toBe(2);
    expect(res!.entries.every((e) => e.type === 'assistant')).toBe(true);
  });

  it('skips malformed lines rather than throwing', async () => {
    const w = makeWriter();
    w.append('r4', undefined, 'assistant', { type: 'assistant' });
    await settle();
    // Corrupt the file by appending a junk line.
    const file = path.join(tmpRoot, 'Claude', 'logs', 'r4.jsonl');
    fs.appendFileSync(file, 'not json\n', 'utf8');

    const res = await w.read('r4');
    expect(res!.total).toBe(1);
    expect(res!.entries[0].type).toBe('assistant');
  });
});
