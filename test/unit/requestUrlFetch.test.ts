/**
 * The requestUrl-backed fetch adapter. These assertions are shaped by what the
 * MCP SDK's auth helpers actually send and expect back: GETs with a
 * MCP-Protocol-Version header for discovery, a URLSearchParams body for token
 * exchange/refresh, a JSON string body for Dynamic Client Registration, and
 * `response.ok` / 4xx branching on the way out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const requestUrl = vi.fn();
vi.mock('obsidian', () => ({ requestUrl: (...args: unknown[]) => requestUrl(...args) }));

import { createRequestUrlFetch } from '../../src/requestUrlFetch';

const encode = (s: string) => new TextEncoder().encode(s).buffer;

function respondWith(body: string, status = 200, headers: Record<string, string> = {}) {
  requestUrl.mockResolvedValue({ status, headers, arrayBuffer: encode(body), text: body, json: null });
}

beforeEach(() => requestUrl.mockReset());

describe('request translation', () => {
  it('sends a GET with headers and returns a parseable Response', async () => {
    respondWith(JSON.stringify({ registration_endpoint: 'https://as.example/register' }));
    const doFetch = createRequestUrlFetch();

    const res = await doFetch('https://mcp.example/.well-known/oauth-authorization-server', {
      headers: { 'MCP-Protocol-Version': '2025-06-18', Accept: 'application/json' },
    });

    expect(requestUrl).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://mcp.example/.well-known/oauth-authorization-server',
      method: 'GET',
      headers: { 'MCP-Protocol-Version': '2025-06-18', Accept: 'application/json' },
      throw: false,
    }));
    expect(res.ok).toBe(true);
    await expect(res.json()).resolves.toEqual({ registration_endpoint: 'https://as.example/register' });
  });

  it('serializes a URLSearchParams body, as token exchange and refresh send', async () => {
    respondWith('{"access_token":"a"}');
    const doFetch = createRequestUrlFetch();

    await doFetch('https://as.example/token', {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'r' }),
    });

    expect(requestUrl).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      body: 'grant_type=refresh_token&refresh_token=r',
    }));
  });

  it('passes a JSON string body through unchanged, as registration sends', async () => {
    respondWith('{"client_id":"x"}');
    const doFetch = createRequestUrlFetch();

    await doFetch('https://as.example/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Agent Threads' }),
    });

    expect(requestUrl).toHaveBeenCalledWith(expect.objectContaining({
      body: '{"client_name":"Agent Threads"}',
      headers: { 'Content-Type': 'application/json' },
    }));
  });

  it('accepts a Headers instance and a URL object', async () => {
    respondWith('{}');
    const doFetch = createRequestUrlFetch();

    await doFetch(new URL('https://as.example/register'), {
      headers: new Headers({ 'content-type': 'application/json' }),
    });

    expect(requestUrl).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://as.example/register',
      headers: { 'content-type': 'application/json' },
    }));
  });
});

describe('response translation', () => {
  it('returns 4xx as a response rather than throwing, so discovery can try the next URL', async () => {
    respondWith('not found', 404);
    const doFetch = createRequestUrlFetch();

    const res = await doFetch('https://as.example/.well-known/openid-configuration');

    expect(res.status).toBe(404);
    expect(res.ok).toBe(false);
  });

  it('does not attach a body to a null-body status', async () => {
    respondWith('', 204);
    const doFetch = createRequestUrlFetch();

    // A Response constructed with a body on 204 throws — the adapter must not.
    const res = await doFetch('https://as.example/revoke', { method: 'POST' });
    expect(res.status).toBe(204);
  });

  it('surfaces response headers', async () => {
    respondWith('{}', 200, { 'content-type': 'application/json' });
    const doFetch = createRequestUrlFetch();

    const res = await doFetch('https://as.example/x');
    expect(res.headers.get('content-type')).toBe('application/json');
  });
});

describe('guard rails', () => {
  it('rejects a body type the OAuth paths never use rather than sending [object Object]', async () => {
    respondWith('{}');
    const doFetch = createRequestUrlFetch();

    await expect(
      doFetch('https://as.example/x', { method: 'POST', body: new FormData() }),
    ).rejects.toThrow(/unsupported body type/);
  });

  it('never falls back to global fetch', async () => {
    respondWith('{}');
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    const doFetch = createRequestUrlFetch();

    await doFetch('https://as.example/x');

    expect(globalFetch).not.toHaveBeenCalled();
    expect(requestUrl).toHaveBeenCalledOnce();
    globalFetch.mockRestore();
  });
});
