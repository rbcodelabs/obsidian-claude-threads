import { describe, it, expect } from 'vitest';
import {
  isTransportClosedError,
  shouldAutoRetryTransportError,
  MAX_TRANSPORT_ERROR_AUTO_RETRIES,
} from '../../src/transportErrorRecovery';

describe('transportErrorRecovery', () => {
  describe('isTransportClosedError', () => {
    it('matches the literal SDK stream-closed message', () => {
      expect(isTransportClosedError('Stream closed')).toBe(true);
    });

    it('matches the tool-permission stream-closed message', () => {
      expect(isTransportClosedError('Tool permission stream closed before response received')).toBe(true);
    });

    it('matches case-insensitively', () => {
      expect(isTransportClosedError('STREAM CLOSED')).toBe(true);
      expect(isTransportClosedError('sTreAm ClOseD unexpectedly')).toBe(true);
    });

    it('does not match unrelated error text', () => {
      expect(isTransportClosedError('ENOENT: no such file or directory')).toBe(false);
      expect(isTransportClosedError('Request timed out')).toBe(false);
      expect(isTransportClosedError('')).toBe(false);
    });
  });

  describe('shouldAutoRetryTransportError', () => {
    it('returns true at retry count 0 for a transport-closed message', () => {
      expect(shouldAutoRetryTransportError('Stream closed', 0)).toBe(true);
    });

    it('returns false once the retry count reaches the max', () => {
      expect(shouldAutoRetryTransportError('Stream closed', MAX_TRANSPORT_ERROR_AUTO_RETRIES)).toBe(false);
    });

    it('returns false once the retry count exceeds the max', () => {
      expect(shouldAutoRetryTransportError('Stream closed', MAX_TRANSPORT_ERROR_AUTO_RETRIES + 1)).toBe(false);
    });

    it('returns false for a non-transport error regardless of retry count', () => {
      expect(shouldAutoRetryTransportError('some other failure', 0)).toBe(false);
    });
  });
});
