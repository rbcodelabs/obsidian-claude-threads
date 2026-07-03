import { describe, it, expect } from 'vitest';
import {
  isTransportClosedError,
  shouldAutoRetryTransportError,
  MAX_TRANSPORT_ERROR_AUTO_RETRIES,
} from '../../src/transportErrorRecovery';

describe('isTransportClosedError', () => {
  it('matches "Stream closed"', () => {
    expect(isTransportClosedError('Stream closed')).toBe(true);
  });

  it('matches "Tool permission stream closed before response received"', () => {
    expect(isTransportClosedError('Tool permission stream closed before response received')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isTransportClosedError('STREAM CLOSED')).toBe(true);
    expect(isTransportClosedError('stream ClOsEd unexpectedly')).toBe(true);
  });

  it('does not match unrelated error text', () => {
    expect(isTransportClosedError('Claude session ended: error_max_turns')).toBe(false);
    expect(isTransportClosedError('ENOENT: no such file or directory')).toBe(false);
  });
});

describe('shouldAutoRetryTransportError', () => {
  it('is true when the message matches and the retry count is below the max', () => {
    expect(shouldAutoRetryTransportError('Stream closed', 0)).toBe(true);
  });

  it('is false once the retry count reaches the max', () => {
    expect(shouldAutoRetryTransportError('Stream closed', MAX_TRANSPORT_ERROR_AUTO_RETRIES)).toBe(false);
  });

  it('is false once the retry count exceeds the max', () => {
    expect(shouldAutoRetryTransportError('Stream closed', MAX_TRANSPORT_ERROR_AUTO_RETRIES + 1)).toBe(false);
  });

  it('is false when the message does not match, regardless of count', () => {
    expect(shouldAutoRetryTransportError('Claude session ended: error_max_turns', 0)).toBe(false);
  });
});
