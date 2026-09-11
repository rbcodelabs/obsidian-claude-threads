import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthTokenStore, type TokenSet } from '../../src/OAuthTokenStore';
import { secretStorageKey } from '../../src/secretUtils';

function fakeSecretStorage() {
  const store = new Map<string, string>();
  return {
    setSecret: vi.fn((id: string, secret: string) => { store.set(id, secret); }),
    getSecret: vi.fn((id: string) => store.get(id) ?? null),
    store,
  };
}

describe('OAuthTokenStore — keychain key naming', () => {
  it('writes access/refresh/expiry/clientId under OAUTH_MCP_{NAME}_* keys, normalized through secretStorageKey', () => {
    const secretStorage = fakeSecretStorage();
    const refreshFn = vi.fn();
    const tokenStore = new OAuthTokenStore(secretStorage, refreshFn);
    tokenStore.storeClientId('vercel', 'client-abc');
    tokenStore.store('vercel', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000 });

    expect(secretStorage.setSecret).toHaveBeenCalledWith(secretStorageKey('OAUTH_MCP_VERCEL_CLIENT_ID'), 'client-abc');
    expect(secretStorage.setSecret).toHaveBeenCalledWith(secretStorageKey('OAUTH_MCP_VERCEL_ACCESS_TOKEN'), 'at');
    expect(secretStorage.setSecret).toHaveBeenCalledWith(secretStorageKey('OAUTH_MCP_VERCEL_REFRESH_TOKEN'), 'rt');
    expect(secretStorage.setSecret).toHaveBeenCalledWith(secretStorageKey('OAUTH_MCP_VERCEL_EXPIRES_AT'), expect.any(String));
  });

  it('uppercases a mixed-case server name into the key', () => {
    const secretStorage = fakeSecretStorage();
    const tokenStore = new OAuthTokenStore(secretStorage, vi.fn());
    tokenStore.store('My-Server', { accessToken: 'at' });
    expect(secretStorage.setSecret).toHaveBeenCalledWith(secretStorageKey('OAUTH_MCP_MY-SERVER_ACCESS_TOKEN'), 'at');
  });
});

describe('OAuthTokenStore — getAccessToken', () => {
  it('returns the current token unchanged when far from expiry', async () => {
    const secretStorage = fakeSecretStorage();
    const refreshFn = vi.fn();
    const tokenStore = new OAuthTokenStore(secretStorage, refreshFn);
    tokenStore.store('vercel', { accessToken: 'at-1', refreshToken: 'rt', expiresAt: Date.now() + 3600_000 });
    await expect(tokenStore.getAccessToken('vercel')).resolves.toBe('at-1');
    expect(refreshFn).not.toHaveBeenCalled();
  });

  it('returns null when nothing is stored', async () => {
    const tokenStore = new OAuthTokenStore(fakeSecretStorage(), vi.fn());
    await expect(tokenStore.getAccessToken('vercel')).resolves.toBeNull();
  });

  it('proactively refreshes when fewer than 5 minutes remain', async () => {
    const secretStorage = fakeSecretStorage();
    const refreshFn = vi.fn(async (): Promise<TokenSet> => ({ accessToken: 'at-2', refreshToken: 'rt', expiresAt: Date.now() + 3600_000 }));
    const tokenStore = new OAuthTokenStore(secretStorage, refreshFn);
    tokenStore.store('vercel', { accessToken: 'at-1', refreshToken: 'rt', expiresAt: Date.now() + 4 * 60_000 });
    await expect(tokenStore.getAccessToken('vercel')).resolves.toBe('at-2');
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it('does not refresh when near expiry but no refresh token is available', async () => {
    const secretStorage = fakeSecretStorage();
    const refreshFn = vi.fn();
    const tokenStore = new OAuthTokenStore(secretStorage, refreshFn);
    tokenStore.store('vercel', { accessToken: 'at-1', expiresAt: Date.now() + 60_000 });
    await expect(tokenStore.getAccessToken('vercel')).resolves.toBe('at-1');
    expect(refreshFn).not.toHaveBeenCalled();
  });

  it('falls back to the current access token when refresh fails', async () => {
    const secretStorage = fakeSecretStorage();
    const refreshFn = vi.fn(async () => { throw new Error('AS unreachable'); });
    const tokenStore = new OAuthTokenStore(secretStorage, refreshFn);
    tokenStore.store('vercel', { accessToken: 'at-1', refreshToken: 'rt', expiresAt: Date.now() + 60_000 });
    await expect(tokenStore.getAccessToken('vercel')).resolves.toBe('at-1');
  });

  it('dedups concurrent refresh calls into a single refreshFn invocation', async () => {
    const secretStorage = fakeSecretStorage();
    let resolveRefresh!: (tokens: TokenSet) => void;
    const refreshFn = vi.fn(() => new Promise<TokenSet>((resolve) => { resolveRefresh = resolve; }));
    const tokenStore = new OAuthTokenStore(secretStorage, refreshFn);
    tokenStore.store('vercel', { accessToken: 'at-1', refreshToken: 'rt', expiresAt: Date.now() + 60_000 });

    const first = tokenStore.getAccessToken('vercel');
    const second = tokenStore.getAccessToken('vercel');
    expect(refreshFn).toHaveBeenCalledTimes(1);
    resolveRefresh({ accessToken: 'at-2', refreshToken: 'rt', expiresAt: Date.now() + 3600_000 });
    expect(await first).toBe('at-2');
    expect(await second).toBe('at-2');
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });
});

describe('OAuthTokenStore — scheduled refresh timing', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('schedules the refresh for expires_in - 300 seconds, not before and not much after', async () => {
    const secretStorage = fakeSecretStorage();
    const refreshFn = vi.fn(async (): Promise<TokenSet> => ({ accessToken: 'at-2', expiresAt: Date.now() + 3600_000 }));
    const tokenStore = new OAuthTokenStore(secretStorage, refreshFn);
    const expiresInMs = 20 * 60_000; // expires_in = 1200s
    tokenStore.store('vercel', { accessToken: 'at-1', refreshToken: 'rt', expiresAt: Date.now() + expiresInMs });

    // (expires_in - 300)s = 900s = 15 minutes.
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1000);
    expect(refreshFn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it('re-scheduling replaces a still-pending timer instead of stacking another one', async () => {
    const secretStorage = fakeSecretStorage();
    const refreshFn = vi.fn(async (): Promise<TokenSet> => ({ accessToken: 'at-2', expiresAt: Date.now() + 3600_000 }));
    const tokenStore = new OAuthTokenStore(secretStorage, refreshFn);
    tokenStore.store('vercel', { accessToken: 'at-1', refreshToken: 'rt', expiresAt: Date.now() + 20 * 60_000 });
    tokenStore.scheduleRefresh('vercel', Date.now() + 20 * 60_000);

    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1000);
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });
});

describe('OAuthTokenStore — clear', () => {
  it('blanks every keychain field and cancels the scheduled refresh', () => {
    vi.useFakeTimers();
    try {
      const secretStorage = fakeSecretStorage();
      const refreshFn = vi.fn(async (): Promise<TokenSet> => ({ accessToken: 'at-2' }));
      const tokenStore = new OAuthTokenStore(secretStorage, refreshFn);
      tokenStore.storeClientId('vercel', 'client-abc');
      tokenStore.store('vercel', { accessToken: 'at-1', refreshToken: 'rt', expiresAt: Date.now() + 3600_000 });

      tokenStore.clear('vercel');

      expect(tokenStore.getCurrentTokens('vercel')).toBeUndefined();
      expect(tokenStore.getClientId('vercel')).toBeUndefined();

      vi.advanceTimersByTime(3600_000);
      expect(refreshFn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is a safe no-op for a server that was never stored', () => {
    const tokenStore = new OAuthTokenStore(fakeSecretStorage(), vi.fn());
    expect(() => tokenStore.clear('ghost')).not.toThrow();
  });
});
