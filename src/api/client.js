// -----------------------------------------------------------------------------
// One call to the GO API of Metrolinx. The key goes in the query string, as the
// API asks, and only to api.openmetrolinx.com over HTTPS: no redirect is
// followed, and no error message, log line or status ever carries the URL.
//
// The API answers its own errors with HTTP 200 and `Metadata.ErrorCode`
// ("401" without a key, "403" with a key it refuses or that lost the right to
// this endpoint): both the HTTP status and the envelope are read. Every answer
// is bounded in time (10 s) and in size (read in chunks, cut past the limit).
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { API_BASE, MAX_BODY_BYTES, REQUEST_TIMEOUT_MS } from '../constants.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
export const USER_AGENT = `gladys-go-transit/${pkg.version} (+https://github.com/LM1LC3N7/gladys-go-transit)`;

export class GoApiError extends Error {
  /**
   * @param {'auth'|'rate'|'server'|'timeout'|'network'|'unreadable'|'notfound'|'error'} kind
   * @param {string} message never the URL nor the key
   * @param {{ code?: string, retryAfterMs?: number }} [extra]
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'GoApiError';
    this.kind = kind;
    this.code = extra.code;
    this.retryAfterMs = extra.retryAfterMs;
  }
}

/** Retry-After in seconds or as a date, in ms; undefined when absent or unreadable. */
export function retryAfterMs(header, nowMs) {
  if (typeof header !== 'string' || header.trim() === '') return undefined;
  const value = header.trim();
  if (/^\d{1,7}$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) && Number.isFinite(nowMs) ? Math.max(0, at - nowMs) : undefined;
}

async function readBounded(response, maxBytes, signal) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new GoApiError('unreadable', `answer too large (${declared} bytes)`);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  // The deadline holds for the body too, whatever the fetch does with its signal.
  const aborted = new Promise((resolve, reject) => {
    const fail = () => reject(new GoApiError('timeout', 'answer not complete within 10 s'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
  aborted.catch(() => {});
  const chunks = [];
  let size = 0;
  for (;;) {
    let part;
    try {
      part = await Promise.race([reader.read(), aborted]);
    } catch (err) {
      reader.cancel().catch(() => {});
      throw err;
    }
    const { done, value } = part;
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new GoApiError('unreadable', `answer cut past ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function classifyStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate';
  if (status >= 500 && status <= 599) return 'server';
  if (status === 404 || status === 400) return 'notfound';
  return 'error';
}

/**
 * GET one path of the API.
 * @param {{ path: string, key: string, fetchImpl?: typeof fetch, maxBytes?: number, timeoutMs?: number, wallNow?: () => number }} options
 * @returns {Promise<{ data: object, serverDate: number | null, empty: boolean }>}
 */
export async function apiGet({
  path,
  key,
  fetchImpl = fetch,
  maxBytes = MAX_BODY_BYTES,
  timeoutMs = REQUEST_TIMEOUT_MS,
  wallNow = Date.now,
  base = API_BASE,
}) {
  const url = new URL(path, base);
  url.searchParams.set('key', key);
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      redirect: 'error',
      signal,
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || signal.aborted) {
      throw new GoApiError('timeout', 'no answer within 10 s');
    }
    throw new GoApiError('network', 'network error');
  }
  const headerDate = Date.parse(response.headers.get('date') ?? '');
  const serverDate = Number.isFinite(headerDate) ? headerDate : null;
  let text;
  try {
    text = await readBounded(response, maxBytes, signal);
  } catch (err) {
    if (err instanceof GoApiError) throw err;
    if (signal.aborted) throw new GoApiError('timeout', 'answer not complete within 10 s');
    throw new GoApiError('unreadable', 'answer cut');
  }
  if (response.status !== 200) {
    const kind = classifyStatus(response.status);
    throw new GoApiError(kind, `HTTP ${response.status}`, {
      code: String(response.status),
      retryAfterMs:
        kind === 'rate' || kind === 'server'
          ? retryAfterMs(response.headers.get('retry-after'), wallNow())
          : undefined,
    });
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new GoApiError('unreadable', 'answer is not JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new GoApiError('unreadable', 'answer is not an object');
  }
  // The envelope first: an answer without it is not the GO API.
  const meta = data.Metadata;
  if (!meta || typeof meta !== 'object') {
    throw new GoApiError('unreadable', 'answer without Metadata');
  }
  const code = String(meta.ErrorCode ?? '').trim();
  if (code !== '200' && code !== '204') {
    const status = /^\d{3}$/.test(code) ? Number(code) : 0;
    throw new GoApiError(status ? classifyStatus(status) : 'error', `API error ${code || '?'}`, {
      code,
    });
  }
  return { data, serverDate, empty: code === '204' };
}
