import { describe, it, expect } from 'vitest';
import {
  isRateLimitError,
  shouldAutoRetryRateLimitError,
  rateLimitBackoffMs,
  MAX_RATE_LIMIT_AUTO_RETRIES,
} from '../../src/rateLimitRecovery';

describe('rateLimitRecovery', () => {
  describe('isRateLimitError', () => {
    it('matches the literal rate-limit message', () => {
      expect(isRateLimitError('Server is temporarily limiting requests (not your usage limit) · Rate limited')).toBe(true);
    });

    it('matches an overloaded_error message', () => {
      expect(isRateLimitError('overloaded_error: Overloaded')).toBe(true);
    });

    it('matches a bare 429 status', () => {
      expect(isRateLimitError('API Error: 429')).toBe(true);
    });

    it('matches a bare 529 status', () => {
      expect(isRateLimitError('API Error: 529')).toBe(true);
    });

    it('matches case-insensitively', () => {
      expect(isRateLimitError('RATE LIMIT exceeded')).toBe(true);
      expect(isRateLimitError('Temporarily Limiting Requests')).toBe(true);
    });

    it('does not match unrelated error text', () => {
      expect(isRateLimitError('Stream closed')).toBe(false);
      expect(isRateLimitError('ENOENT: no such file or directory')).toBe(false);
      expect(isRateLimitError('')).toBe(false);
    });
  });

  describe('shouldAutoRetryRateLimitError', () => {
    it('returns true at retry count 0 for a rate-limit message', () => {
      expect(shouldAutoRetryRateLimitError('Rate limited', 0)).toBe(true);
    });

    it('returns true below the max retry count', () => {
      expect(shouldAutoRetryRateLimitError('Rate limited', MAX_RATE_LIMIT_AUTO_RETRIES - 1)).toBe(true);
    });

    it('returns false once the retry count reaches the max', () => {
      expect(shouldAutoRetryRateLimitError('Rate limited', MAX_RATE_LIMIT_AUTO_RETRIES)).toBe(false);
    });

    it('returns false once the retry count exceeds the max', () => {
      expect(shouldAutoRetryRateLimitError('Rate limited', MAX_RATE_LIMIT_AUTO_RETRIES + 1)).toBe(false);
    });

    it('returns false for a non-rate-limit error regardless of retry count', () => {
      expect(shouldAutoRetryRateLimitError('some other failure', 0)).toBe(false);
    });
  });

  describe('rateLimitBackoffMs', () => {
    it('returns the schedule values in order', () => {
      expect(rateLimitBackoffMs(0)).toBe(3000);
      expect(rateLimitBackoffMs(1)).toBe(8000);
      expect(rateLimitBackoffMs(2)).toBe(20000);
      expect(rateLimitBackoffMs(3)).toBe(45000);
      expect(rateLimitBackoffMs(4)).toBe(90000);
    });

    it('clamps to the last schedule value beyond its length', () => {
      expect(rateLimitBackoffMs(5)).toBe(90000);
      expect(rateLimitBackoffMs(100)).toBe(90000);
    });
  });
});
