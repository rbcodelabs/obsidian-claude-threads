import { describe, expect, it } from 'vitest';
import { mergeUsageSnapshot, normalizeClaudeRateLimit, normalizeClaudeResult, normalizeClaudeUsageResponse, normalizeCodexAccountUsage, normalizeCodexRateLimitResponse, normalizeCodexRateLimits, normalizeCodexTokenUsage, timestampMs } from '../../src/Usage';

describe('usage normalization', () => {
  it('preserves Claude model usage, estimated cost, and quota hints', () => {
    const result = normalizeClaudeResult({
      total_cost_usd: 0.1234,
      num_turns: 2,
      usage: { input_tokens: 100, output_tokens: 25, cache_read_input_tokens: 40 },
      modelUsage: { 'claude-sonnet-4-5': { inputTokens: 80, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 5, webSearchRequests: 2, costUSD: 0.1, contextWindow: 200000, maxOutputTokens: 64000, canonicalModel: 'claude-sonnet-4-5', provider: 'firstParty' } },
    });
    const quota = normalizeClaudeRateLimit({
      status: 'allowed_warning', utilization: 0.82, rateLimitType: 'five_hour', resetsAt: 1_800_000_000,
      isUsingOverage: true, overageInUse: true, overageStatus: 'allowed', overageResetsAt: 1_800_003_600,
      surpassedThreshold: 0.8, canUserPurchaseCredits: true, errorCode: 'credits_required',
    });

    expect(mergeUsageSnapshot(result, quota)).toMatchObject({
      provider: 'claude', estimatedCostUsd: 0.1234, turns: 2,
      tokens: { total: 135, input: 80, output: 20, cachedInput: 30, cacheWriteInput: 5 },
      models: [{ model: 'claude-sonnet-4-5', input: 80, output: 20, cachedInput: 30, cacheWriteInput: 5, webSearchRequests: 2, contextWindow: 200000, maxOutputTokens: 64000, canonicalModel: 'claude-sonnet-4-5', provider: 'firstParty', estimatedCostUsd: 0.1 }],
      quotaWindows: [{ label: 'Five hour', usedPercent: 82, resetsAt: 1_800_000_000_000 }],
      overage: { active: true, inUse: true, status: 'allowed', resetsAt: 1_800_003_600_000, surpassedThreshold: 0.8, canPurchaseCredits: true, errorCode: 'credits_required' },
    });
  });

  it('uses aggregate modelUsage totals for Claude instead of main-loop-only usage', () => {
    expect(normalizeClaudeResult({
      total_cost_usd: 1, num_turns: 1,
      usage: { input_tokens: 100, output_tokens: 20 },
      modelUsage: {
        main: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.2 },
        subagent: { inputTokens: 400, outputTokens: 80, cacheReadInputTokens: 50, cacheCreationInputTokens: 10, costUSD: 0.8 },
      },
    })).toMatchObject({ tokens: { total: 660, input: 500, output: 100, cachedInput: 50, cacheWriteInput: 10 } });
  });

  it('retains all Codex buckets and normalizes second timestamps', () => {
    expect(normalizeCodexRateLimits({
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 75, windowDurationMins: 10080, resetsAt: 1_800_604_800 },
      credits: { hasCredits: true, unlimited: false, balance: '12.50' },
      planType: 'plus', rateLimitReachedType: null,
    })).toMatchObject({
      provider: 'codex', plan: 'plus', credits: { available: true, unlimited: false, balance: '12.50' },
      quotaWindows: [
        { label: '5 hours', usedPercent: 25, resetsAt: 1_800_000_000_000 },
        { label: '7 days', usedPercent: 75, resetsAt: 1_800_604_800_000 },
      ],
    });
  });

  it('normalizes every official Codex limit-id bucket without duplicating the legacy aggregate', () => {
    expect(normalizeCodexRateLimitResponse({
      rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 2000 }, planType: 'plus' },
      rateLimitsByLimitId: {
        codex: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 2000 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 3000 }, planType: 'plus' },
        reviews: { primary: { usedPercent: 70, windowDurationMins: 1440, resetsAt: 4000 } },
      },
      rateLimitResetCredits: { balance: 3, resetsAt: 5000 },
    })).toMatchObject({
      provider: 'codex', plan: 'plus', resetCredits: { balance: 3, resetsAt: 5000 },
      quotaWindows: [
        { label: 'Codex · 5 hours', usedPercent: 10 },
        { label: 'Codex · 7 days', usedPercent: 40 },
        { label: 'Reviews · 1 day', usedPercent: 70 },
      ],
    });
  });

  it('normalizes official Codex account activity into provider-neutral metrics', () => {
    expect(normalizeCodexAccountUsage({
      summary: { lifetimeTokens: 100000, peakDailyTokens: 12000, longestRunningTurnSec: 95, currentStreakDays: 4, longestStreakDays: 10 },
      dailyUsageBuckets: [{ startDate: '2026-08-17', tokens: 1234 }],
    })).toEqual({
      lifetimeTokens: 100000, peakDailyTokens: 12000, longestRunningTurnSeconds: 95,
      currentStreakDays: 4, longestStreakDays: 10,
      daily: [{ date: '2026-08-17', tokens: 1234 }],
    });
  });

  it('clears stale account activity when a newer update reports an error', () => {
    const current = { provider: 'codex' as const, updatedAt: 1, quotaWindows: [], accountUsage: { lifetimeTokens: 100 } };
    const update = { provider: 'codex' as const, updatedAt: 2, quotaWindows: [], accountUsage: undefined, accountUsageUnavailable: 'Authentication required' };
    expect(mergeUsageSnapshot(current, update)).toMatchObject({ accountUsage: undefined, accountUsageUnavailable: 'Authentication required' });
  });

  it('keeps Codex thread and last-turn totals without requiring a context window', () => {
    expect(normalizeCodexTokenUsage({
      total: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 200, outputTokens: 200, reasoningOutputTokens: 50 },
      last: { totalTokens: 100, inputTokens: 75, cachedInputTokens: 10, outputTokens: 25, reasoningOutputTokens: 5 },
      modelContextWindow: null,
    })).toMatchObject({
      provider: 'codex',
      tokens: { total: 1000, input: 800, cachedInput: 200, output: 200, reasoning: 50 },
      lastTurnTokens: { total: 100, input: 75, cachedInput: 10, output: 25, reasoning: 5 },
    });
  });

  it('handles absent and differently-cased provider fields', () => {
    expect(normalizeClaudeRateLimit({ status: 'allowed' })).toMatchObject({ provider: 'claude', quotaWindows: [] });
    expect(normalizeClaudeResult({ total_cost_usd: 0, num_turns: 1 })).toMatchObject({ provider: 'claude', turns: 1 });
  });

  it('builds live Claude quota windows from the proactive SDK usage pull', () => {
    expect(normalizeClaudeUsageResponse({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 84, resets_at: '2026-08-23T20:50:00Z' },
        seven_day: { utilization: 30, resets_at: '2026-08-29T00:00:00Z' },
      },
    })).toMatchObject({
      provider: 'claude',
      quotaWindows: [
        { label: 'Five hour', usedPercent: 84, resetsAt: Date.parse('2026-08-23T20:50:00Z'), status: 'allowed_warning' },
        { label: 'Seven day', usedPercent: 30, resetsAt: Date.parse('2026-08-29T00:00:00Z'), status: 'allowed' },
      ],
    });
  });

  it('keeps a present Claude window with null utilization but no percent', () => {
    const snapshot = normalizeClaudeUsageResponse({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: null, resets_at: '2026-08-23T20:50:00Z' } },
    });
    expect(snapshot.quotaWindows).toEqual([
      { label: 'Five hour', usedPercent: undefined, resetsAt: Date.parse('2026-08-23T20:50:00Z'), status: 'allowed' },
    ]);
  });

  it('returns no Claude windows when plan rate limits do not apply', () => {
    expect(normalizeClaudeUsageResponse({ rate_limits_available: false, rate_limits: null }))
      .toMatchObject({ provider: 'claude', quotaWindows: [] });
    expect(normalizeClaudeUsageResponse({ rate_limits_available: true, rate_limits: null }))
      .toMatchObject({ provider: 'claude', quotaWindows: [] });
  });

  it('maps model-scoped Claude buckets by display name', () => {
    expect(normalizeClaudeUsageResponse({
      rate_limits_available: true,
      rate_limits: { model_scoped: [{ display_name: 'Fable', utilization: 55, resets_at: '2026-08-29T00:00:00Z' }] },
    })).toMatchObject({
      quotaWindows: [{ label: 'Fable', usedPercent: 55, resetsAt: Date.parse('2026-08-29T00:00:00Z'), status: 'allowed' }],
    });
  });

  it('parses ISO strings and preserves numeric timestamp behavior', () => {
    expect(timestampMs('2026-08-23T20:50:00Z')).toBe(Date.parse('2026-08-23T20:50:00Z'));
    expect(timestampMs('not-a-date')).toBeUndefined();
    expect(timestampMs(1_800_000_000)).toBe(1_800_000_000_000);
    expect(timestampMs(1_800_000_000_000)).toBe(1_800_000_000_000);
  });
});
