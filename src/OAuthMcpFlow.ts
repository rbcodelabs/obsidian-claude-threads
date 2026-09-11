/**
 * OAuth 2.1 + PKCE broker for one OAuth-gated remote MCP server: discovery,
 * Dynamic Client Registration (RFC 7591), the authorization-code+PKCE
 * consent round-trip, refresh, and revocation.
 *
 * Uses `@modelcontextprotocol/sdk`'s client auth helpers for discovery, DCR,
 * and token exchange/refresh (RFC 9728 / RFC 8414 / RFC 7591 are all
 * SDK-covered — no reason to hand-roll them). PKCE generation and the
 * authorization-URL/callback-server plumbing are implemented directly here:
 * the SDK's own `startAuthorization()` generates and owns its own PKCE
 * verifier internally with no way to inject one, which conflicts with this
 * module needing directly testable PKCE generation (known S256 vectors,
 * fake-timer-driven callback timeout tests). There is no SDK client-side
 * helper for RFC 7009 revocation either (only server-side schemas ship), so
 * revoke() performs that POST directly, reusing the SDK's `parseErrorResponse`
 * for consistent error shaping.
 *
 * Deliberately host-agnostic: `openUrl` is injected (wired to `host_open_url`
 * by the caller in a later stage) and tokens are handed to an injected
 * `OAuthTokenStoreLike` rather than touching keychain APIs here.
 */

import { createHash, randomBytes } from 'crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  parseErrorResponse,
  refreshAuthorization,
  registerClient as sdkRegisterClient,
  type OAuthServerInfo,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { AuthorizationServerMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { TokenSet } from './OAuthTokenStore';

/** Result of AS discovery (RFC 9728 protected-resource metadata + RFC 8414/OIDC AS metadata). */
export type OAuthASMetadata = OAuthServerInfo;

export interface OAuthTokenStoreLike {
  store(serverName: string, tokens: TokenSet): void | Promise<void>;
  getClientId(serverName: string): string | undefined | Promise<string | undefined>;
  getCurrentTokens(serverName: string): TokenSet | undefined | Promise<TokenSet | undefined>;
  clear(serverName: string): void | Promise<void>;
}

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

type FinishResult = { ok: true; tokens: TokenSet } | { ok: false; error: Error };

/** RFC 7636 S256 code challenge for a given verifier. Split out from generatePkcePair so it's testable against known vectors. */
export function pkceChallengeForVerifier(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: pkceChallengeForVerifier(verifier) };
}

function toTokenSet(tokens: OAuthTokens): TokenSet {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expires_in !== undefined ? Date.now() + tokens.expires_in * 1000 : undefined,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function callbackPage(message: string): string {
  return `<!doctype html><html><body><p>${escapeHtml(message)}</p><script>window.close()</script></body></html>`;
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export class OAuthMcpFlow {
  constructor(
    private readonly tokenStore: OAuthTokenStoreLike,
    private readonly openUrl: (url: string) => Promise<unknown>,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly callbackTimeoutMs = CALLBACK_TIMEOUT_MS,
  ) {}

  /** RFC 9728 protected-resource discovery -> RFC 8414/OIDC AS metadata discovery, combined by the SDK. */
  async discoverAS(serverUrl: string): Promise<OAuthASMetadata> {
    return discoverOAuthServerInfo(serverUrl);
  }

  /**
   * RFC 7591 Dynamic Client Registration. Returns the issued client_id.
   *
   * This method takes a bare registration endpoint rather than a server name (matching the
   * plan's signature), so it has no key to store the client_id under — the caller persists it
   * via `tokenStore.storeClientId(serverName, clientId)` once it knows which server this was for.
   */
  async registerClient(registrationEndpoint: string, redirectUri: string, scopes?: string): Promise<string> {
    // The SDK's registerClient() only reads `metadata.registration_endpoint` when metadata is
    // supplied (see its implementation) — the other required AuthorizationServerMetadata fields
    // below are unused placeholders needed only to satisfy a type that models a full discovered
    // AS document, not a bare registration endpoint URL.
    const metadata: AuthorizationServerMetadata = {
      issuer: registrationEndpoint,
      authorization_endpoint: registrationEndpoint,
      token_endpoint: registrationEndpoint,
      response_types_supported: ['code'],
      registration_endpoint: registrationEndpoint,
    };
    const info = await sdkRegisterClient(registrationEndpoint, {
      metadata,
      clientMetadata: {
        redirect_uris: [redirectUri],
        client_name: 'Agent Threads',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      scope: scopes,
    });
    return info.client_id;
  }

  /**
   * Full PKCE authorization-code flow: starts a local callback server on an ephemeral port,
   * opens the consent URL via the injected `openUrl`, waits for the callback (validating
   * `state`), exchanges the code for tokens, and stores them. Rejects (after cleaning up the
   * callback server either way) on denial, state mismatch, exchange failure, or a 5-minute timeout.
   */
  async authorize(params: {
    serverName: string;
    clientId: string;
    asMetadata: OAuthASMetadata;
    scopes?: string;
  }): Promise<TokenSet> {
    const { verifier, challenge } = generatePkcePair();
    const state = randomBytes(16).toString('hex');

    return new Promise<TokenSet>((resolve, reject) => {
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let redirectUri = '';

      const finish = (result: FinishResult): void => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        server.close();
        if (result.ok) resolve(result.tokens); else reject(result.error);
      };

      const server: Server = createServer((req, res) => {
        void this.handleCallback(req, res, { ...params, redirectUri, verifier, expectedState: state }, finish);
      });

      server.on('error', (err) => finish({ ok: false, error: asError(err) }));

      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          finish({ ok: false, error: new Error('OAuth callback server failed to bind a port.') });
          return;
        }
        redirectUri = `http://127.0.0.1:${address.port}/callback`;

        const authorizationEndpoint = params.asMetadata.authorizationServerMetadata?.authorization_endpoint
          ?? `${params.asMetadata.authorizationServerUrl.replace(/\/+$/, '')}/authorize`;
        const authorizationUrl = new URL(authorizationEndpoint);
        authorizationUrl.searchParams.set('response_type', 'code');
        authorizationUrl.searchParams.set('client_id', params.clientId);
        authorizationUrl.searchParams.set('redirect_uri', redirectUri);
        authorizationUrl.searchParams.set('code_challenge', challenge);
        authorizationUrl.searchParams.set('code_challenge_method', 'S256');
        authorizationUrl.searchParams.set('state', state);
        if (params.scopes) authorizationUrl.searchParams.set('scope', params.scopes);

        timeoutHandle = setTimeout(
          () => finish({ ok: false, error: new Error('OAuth authorization timed out waiting for consent.') }),
          this.callbackTimeoutMs,
        );

        Promise.resolve(this.openUrl(authorizationUrl.toString()))
          .catch((err) => finish({ ok: false, error: asError(err) }));
      });
    });
  }

  private async handleCallback(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: { serverName: string; clientId: string; asMetadata: OAuthASMetadata; redirectUri: string; verifier: string; expectedState: string },
    finish: (result: FinishResult) => void,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }

    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');

    if (error) {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(callbackPage(`Authorization was denied: ${error}`));
      finish({ ok: false, error: new Error(`OAuth authorization was denied: ${error}`) });
      return;
    }
    if (!code || returnedState !== ctx.expectedState) {
      res.writeHead(400, { 'Content-Type': 'text/html' }).end(callbackPage('Invalid authorization response.'));
      finish({ ok: false, error: new Error('OAuth callback state mismatch or missing authorization code.') });
      return;
    }

    try {
      const tokens = await exchangeAuthorization(ctx.asMetadata.authorizationServerUrl, {
        metadata: ctx.asMetadata.authorizationServerMetadata,
        clientInformation: { client_id: ctx.clientId },
        authorizationCode: code,
        codeVerifier: ctx.verifier,
        redirectUri: ctx.redirectUri,
      });
      const tokenSet = toTokenSet(tokens);
      await this.tokenStore.store(ctx.serverName, tokenSet);
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(callbackPage('Authorization complete — you can close this tab.'));
      finish({ ok: true, tokens: tokenSet });
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'text/html' }).end(callbackPage('Token exchange failed.'));
      finish({ ok: false, error: asError(err) });
    }
  }

  /** Refresh via the AS's token endpoint, using the client_id and refresh token already on file. */
  async refresh(serverName: string, asMetadata: OAuthASMetadata): Promise<TokenSet> {
    const current = await this.tokenStore.getCurrentTokens(serverName);
    if (!current?.refreshToken) throw new Error(`No refresh token available for "${serverName}"; re-authorization is required.`);
    const clientId = await this.tokenStore.getClientId(serverName);
    if (!clientId) throw new Error(`No client_id stored for "${serverName}"; re-authorization is required.`);

    const tokens = await refreshAuthorization(asMetadata.authorizationServerUrl, {
      metadata: asMetadata.authorizationServerMetadata,
      clientInformation: { client_id: clientId },
      refreshToken: current.refreshToken,
    });
    const tokenSet = toTokenSet(tokens);
    await this.tokenStore.store(serverName, tokenSet);
    return tokenSet;
  }

  /** RFC 7009 revocation, best-effort — an AS that rejects revocation still gets its local state cleared. */
  async revoke(serverName: string, asMetadata: OAuthASMetadata): Promise<void> {
    // revocation_endpoint is only present on the OAuthMetadata (RFC 8414) arm of the
    // AuthorizationServerMetadata union, not the plain OpenID Connect discovery arm.
    const asMeta = asMetadata.authorizationServerMetadata;
    const revocationEndpoint = asMeta && 'revocation_endpoint' in asMeta ? asMeta.revocation_endpoint : undefined;
    const current = await this.tokenStore.getCurrentTokens(serverName);
    const clientId = await this.tokenStore.getClientId(serverName);

    if (revocationEndpoint && clientId && current) {
      const candidates: Array<[string | undefined, string]> = [
        [current.refreshToken, 'refresh_token'],
        [current.accessToken, 'access_token'],
      ];
      for (const [token, tokenTypeHint] of candidates) {
        if (!token) continue;
        try {
          const response = await this.fetchFn(revocationEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token, token_type_hint: tokenTypeHint, client_id: clientId }),
          });
          if (!response.ok) throw await parseErrorResponse(response);
        } catch {
          // Best-effort: an unreachable or uncooperative AS shouldn't block clearing local state.
        }
      }
    }

    await this.tokenStore.clear(serverName);
  }
}
