import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  log,
  logger,
  debugLog,
  setDebugLogging,
  isDebugLogging,
  getLogRing,
  clearLogRing,
  LOG_RING_CAPACITY,
} from '../../src/logger';

describe('logger — ring buffer + level gating', () => {
  beforeEach(() => {
    clearLogRing();
    setDebugLogging(false);
    // Silence console noise from the always-emit levels during the run.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not retain debug entries while debug mode is off', () => {
    debugLog('high-frequency noise');
    logger.debug('more noise');
    expect(getLogRing()).toHaveLength(0);
  });

  it('retains debug entries once debug mode is on', () => {
    setDebugLogging(true);
    expect(isDebugLogging()).toBe(true);
    debugLog('now recorded');
    const ring = getLogRing();
    expect(ring).toHaveLength(1);
    expect(ring[0].level).toBe('debug');
    expect(ring[0].msg).toBe('now recorded');
  });

  it('always retains warn/error/info even when debug mode is off', () => {
    logger.info('info line');
    logger.warn('warn line');
    logger.error('error line');
    const levels = getLogRing().map((e) => e.level);
    expect(levels).toEqual(['info', 'warn', 'error']);
  });

  it('records an optional category tag', () => {
    log('warn', 'kanban', 'rebuild storm');
    const [entry] = getLogRing();
    expect(entry.category).toBe('kanban');
    expect(entry.level).toBe('warn');
    expect(entry.msg).toBe('rebuild storm');
  });

  it('joins multiple console-style args into one message', () => {
    logger.warn('count is', 42, { a: 1 });
    expect(getLogRing()[0].msg).toBe('count is 42 {"a":1}');
  });

  it('serializes Error args with their stack/message', () => {
    logger.error(new Error('boom'));
    expect(getLogRing()[0].msg).toContain('boom');
  });

  it('bounds the ring at LOG_RING_CAPACITY, evicting oldest first', () => {
    const overflow = LOG_RING_CAPACITY + 250;
    for (let i = 0; i < overflow; i++) logger.info(`entry-${i}`);
    const ring = getLogRing();
    expect(ring).toHaveLength(LOG_RING_CAPACITY);
    // Oldest 250 evicted → first retained entry is entry-250.
    expect(ring[0].msg).toBe(`entry-${overflow - LOG_RING_CAPACITY}`);
    expect(ring[ring.length - 1].msg).toBe(`entry-${overflow - 1}`);
  });

  it('getLogRing(limit) returns only the most recent N entries', () => {
    for (let i = 0; i < 10; i++) logger.info(`e-${i}`);
    const tail = getLogRing(3);
    expect(tail.map((e) => e.msg)).toEqual(['e-7', 'e-8', 'e-9']);
  });

  it('returns a copy — callers cannot mutate internal state', () => {
    logger.info('x');
    const ring = getLogRing();
    ring.push({ ts: 0, level: 'info', msg: 'injected' });
    expect(getLogRing()).toHaveLength(1);
  });
});
