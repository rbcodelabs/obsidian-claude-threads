/**
 * A `fetch`-shaped adapter backed by Obsidian's `requestUrl`.
 *
 * Why this exists, in one sentence: the plugin's renderer runs on a `file://`
 * origin, and Chromium refuses every cross-origin `fetch` from an opaque origin
 * no matter how permissive the server's CORS headers are — so any code in the
 * renderer that talks to a third-party HTTP API must route through the host's
 * privileged HTTP client instead of the DOM one.
 *
 * This was found the hard way. The OAuth MCP broker used global `fetch` for
 * authorization-server discovery, Dynamic Client Registration, token exchange
 * and refresh. Under vitest (Node, no origin) every one of those passed; in the
 * real app all of them failed with `TypeError: Failed to fetch`. The MCP SDK
 * then converts that TypeError into `undefined` metadata
 * (`fetchWithCorsRetry`) and swallows the protected-resource failure outright,
 * so a total network failure surfaced to the user as "this authorization server
 * does not support Dynamic Client Registration" — a claim about the *server*
 * produced by a failure in *our* HTTP layer.
 *
 * Obsidian's `requestUrl` (and Geode's, which delegates over IPC to the main
 * process for exactly this reason) is not origin-bound. It also works on mobile,
 * which a raw `require('https')` would not.
 */
import { requestUrl } from 'obsidian';

/** Statuses the Response constructor forbids a body on. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, name) => { out[name] = value; });
  } else if (Array.isArray(headers)) {
    for (const [name, value] of headers) out[name] = value;
  } else {
    Object.assign(out, headers);
  }
  return out;
}

/**
 * `requestUrl` takes a string body. The SDK sends `URLSearchParams` for token
 * and refresh requests and a JSON string for registration, so both are
 * normalized here rather than at each call site.
 */
function bodyToString(body: BodyInit | null | undefined): string | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body.buffer as ArrayBuffer);
  // Blob/FormData/streams are not used by the OAuth paths; fail loudly rather
  // than silently sending "[object Object]".
  throw new Error(`requestUrlFetch: unsupported body type ${Object.prototype.toString.call(body)}`);
}

/**
 * Returns a function assignable to `typeof fetch` that performs the request via
 * `requestUrl`. Non-2xx responses are returned, not thrown (`throw: false`),
 * because callers — including the MCP SDK's discovery — branch on `response.ok`
 * and on 4xx specifically.
 */
export function createRequestUrlFetch(): typeof fetch {
  const adapter = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input
      : input instanceof URL ? input.toString()
      : input.url;

    const response = await requestUrl({
      url,
      method: init?.method ?? 'GET',
      headers: headersToRecord(init?.headers),
      body: bodyToString(init?.body),
      throw: false,
    });

    const body = NULL_BODY_STATUSES.has(response.status) ? null : response.arrayBuffer;
    return new Response(body, {
      status: response.status,
      headers: response.headers ?? {},
    });
  };
  return adapter as typeof fetch;
}
