/**
 * Keychain custody for OAuth-gated MCP servers: read/write, proactive refresh
 * scheduling, and serialized (dedup'd) on-demand refresh.
 *
 * Tokens never live in `data.json` — only in the OS keychain via the injected
 * `secretStorage`, mirroring the existing `app.secretStorage` usage in
 * `main.ts` / `SettingsTab.ts` (see `secretUtils.secretStorageKey`). This
 * class takes that dependency injected rather than reaching for `app` itself,
 * so it's unit-testable without an Obsidian host.
 *
 * `refreshFn` is injected too: this class knows how to schedule and
 * serialize a refresh, not how to talk to an authorization server. The
 * caller wires `refreshFn` to `OAuthMcpFlow.refresh()` bound to the right AS
 * metadata — composition that happens in a later stage, not here.
 */

import { secretStorageKey } from './secretUtils';

/** Mirrors the real `app.secretStorage` shape (see obsidian.d.ts's `SecretStorage`). */
export interface SecretStorageLike {
  setSecret(id: string, secret: string): void;
  getSecret(id: string): string | null;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** ms epoch. Undefined means the server didn't report an expiry (treated as never near-expiry). */
  expiresAt?: number;
}

/** Proactively refresh once fewer than this many ms remain before expiry. */
const PROACTIVE_REFRESH_WINDOW_MS = 5 * 60 * 1000;

const KEYCHAIN_FIELDS = ['CLIENT_ID', 'ACCESS_TOKEN', 'REFRESH_TOKEN', 'EXPIRES_AT'] as const;
type KeychainField = typeof KEYCHAIN_FIELDS[number];

function keyFor(serverName: string, field: KeychainField): string {
  return secretStorageKey(`OAUTH_MCP_${serverName.toUpperCase()}_${field}`);
}

export class OAuthTokenStore {
  /** One in-flight refresh per server; concurrent callers await the same promise. */
  private refreshPromises = new Map<string, Promise<TokenSet>>();
  private refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly secretStorage: SecretStorageLike,
    private readonly refreshFn: (serverName: string) => Promise<TokenSet>,
  ) {}

  /** Write tokens to the keychain after a successful auth or refresh, and (re)schedule proactive refresh. */
  store(serverName: string, tokens: TokenSet): void {
    this.secretStorage.setSecret(keyFor(serverName, 'ACCESS_TOKEN'), tokens.accessToken);
    this.secretStorage.setSecret(keyFor(serverName, 'REFRESH_TOKEN'), tokens.refreshToken ?? '');
    this.secretStorage.setSecret(keyFor(serverName, 'EXPIRES_AT'), tokens.expiresAt ? String(tokens.expiresAt) : '');
    if (tokens.expiresAt !== undefined) this.scheduleRefresh(serverName, tokens.expiresAt);
  }

  /** DCR-issued (or user-provided) client_id, cached alongside the tokens it authenticates. */
  storeClientId(serverName: string, clientId: string): void {
    this.secretStorage.setSecret(keyFor(serverName, 'CLIENT_ID'), clientId);
  }

  getClientId(serverName: string): string | undefined {
    return this.secretStorage.getSecret(keyFor(serverName, 'CLIENT_ID')) || undefined;
  }

  /** Raw read with no refresh side effect — needed by revoke()/refresh() to see what's actually stored. */
  getCurrentTokens(serverName: string): TokenSet | undefined {
    const accessToken = this.secretStorage.getSecret(keyFor(serverName, 'ACCESS_TOKEN'));
    if (!accessToken) return undefined;
    const refreshToken = this.secretStorage.getSecret(keyFor(serverName, 'REFRESH_TOKEN')) || undefined;
    const expiresAtRaw = this.secretStorage.getSecret(keyFor(serverName, 'EXPIRES_AT'));
    const expiresAt = expiresAtRaw ? Number(expiresAtRaw) : undefined;
    return { accessToken, refreshToken, expiresAt: expiresAt !== undefined && Number.isFinite(expiresAt) ? expiresAt : undefined };
  }

  /** Current access token, refreshing proactively first if fewer than 5 minutes remain. */
  async getAccessToken(serverName: string): Promise<string | null> {
    const current = this.getCurrentTokens(serverName);
    if (!current) return null;
    const nearExpiry = current.expiresAt !== undefined && current.expiresAt - Date.now() < PROACTIVE_REFRESH_WINDOW_MS;
    if (!nearExpiry) return current.accessToken;
    if (!current.refreshToken) return current.accessToken; // Nothing to refresh with; let a 401 surface the real problem.
    try {
      const refreshed = await this.refresh(serverName);
      return refreshed.accessToken;
    } catch {
      // Refresh failed — hand back whatever's on hand rather than failing the caller outright.
      return current.accessToken;
    }
  }

  /** Serialized per-server refresh: concurrent callers share one in-flight `refreshFn` call. */
  refresh(serverName: string): Promise<TokenSet> {
    const pending = this.refreshPromises.get(serverName);
    if (pending) return pending;
    // refreshFn is called synchronously (so concurrent dedup callers observe one invocation
    // immediately) but its result is normalized through Promise.resolve/try-catch — refreshFn
    // is an injected dependency, and a synchronous throw shouldn't become an uncaught exception.
    let started: Promise<TokenSet>;
    try {
      started = Promise.resolve(this.refreshFn(serverName));
    } catch (err) {
      started = Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    const job = started
      .then((tokens) => { this.store(serverName, tokens); return tokens; })
      .finally(() => this.refreshPromises.delete(serverName));
    this.refreshPromises.set(serverName, job);
    return job;
  }

  /** Schedule a proactive refresh for `expires_in - 300` seconds from now. */
  scheduleRefresh(serverName: string, expiresAt: number): void {
    const existing = this.refreshTimers.get(serverName);
    if (existing) clearTimeout(existing);
    const delayMs = Math.max(0, expiresAt - Date.now() - PROACTIVE_REFRESH_WINDOW_MS);
    const timer = setTimeout(() => {
      this.refresh(serverName).catch(() => {
        // Network hiccups are expected; the next proxy request will retry via getAccessToken()/401 handling.
      });
    }, delayMs);
    this.refreshTimers.set(serverName, timer);
  }

  /** Clear all tokens and the client_id for a server (unregister/revoke), and cancel its scheduled refresh. */
  clear(serverName: string): void {
    const timer = this.refreshTimers.get(serverName);
    if (timer) clearTimeout(timer);
    this.refreshTimers.delete(serverName);
    this.refreshPromises.delete(serverName);
    for (const field of KEYCHAIN_FIELDS) this.secretStorage.setSecret(keyFor(serverName, field), '');
  }
}
