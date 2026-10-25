import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  assertAllowedUrl,
  fetchJson,
  fetchJsonHashed,
  type FetchFn
} from '../../scripts/build-registry';
import { COMMIT, json } from './registry.helpers';

const good = `https://raw.githubusercontent.com/someone/demo/${COMMIT}/widget.json`;

describe('SSRF guard', () => {
  it('accepts the allow-listed URL', () =>
    expect(assertAllowedUrl(good).hostname).toBe('raw.githubusercontent.com'));
  it.each([
    ['http', `http://raw.githubusercontent.com/a/b/${COMMIT}/widget.json`],
    ['other host', `https://example.com/a/b/${COMMIT}/widget.json`],
    ['suffix host', `https://raw.githubusercontent.com.evil.com/a/b/${COMMIT}/widget.json`],
    ['userinfo', `https://user@raw.githubusercontent.com/a/b/${COMMIT}/widget.json`],
    ['userinfo trick', `https://raw.githubusercontent.com@evil.com/a/b/${COMMIT}/widget.json`],
    ['port', `https://raw.githubusercontent.com:8443/a/b/${COMMIT}/widget.json`],
    ['file', 'file:///etc/passwd'],
    ['data', 'data:application/json,{}'],
    ['query', `${good}?token=x`],
    ['garbage', 'not a url']
  ])('rejects %s', (_n, url) => expect(() => assertAllowedUrl(url)).toThrow(/rejected URL/));

  it('fetchJson rejects before calling fetch', async () => {
    let called = false;
    const f: FetchFn = async () => ((called = true), json({}));
    await expect(fetchJson('https://evil.com/x.json', { fetch: f })).rejects.toThrow();
    expect(called).toBe(false);
  });
});

describe('fetchJson', () => {
  it('sends redirect:error, no credentials or auth headers', async () => {
    let init: RequestInit = {};
    const f: FetchFn = async (_u, i) => ((init = i), json({ ok: 1 }));
    expect(await fetchJson(good, { fetch: f })).toEqual({ ok: 1 });
    expect(init.redirect).toBe('error');
    expect(init.credentials).toBe('omit');
    expect(Object.keys(init.headers as object)).toEqual(['accept']);
  });
  it('rejects redirects whether thrown or returned', async () => {
    const thrown: FetchFn = async () => {
      throw new TypeError('redirect mode is set to error');
    };
    await expect(fetchJson(good, { fetch: thrown })).rejects.toThrow();
    const returned: FetchFn = async () =>
      new Response(null, { status: 302, headers: { location: 'https://evil.com' } });
    await expect(fetchJson(good, { fetch: returned })).rejects.toThrow(/redirect/);
  });
  it('rejects non-JSON, html, arrays and HTTP errors', async () => {
    const mk =
      (r: Response): FetchFn =>
      async () =>
        r;
    await expect(fetchJson(good, { fetch: mk(new Response('<html>')) })).rejects.toThrow(
      /not valid JSON/
    );
    await expect(
      fetchJson(good, {
        fetch: mk(new Response('{}', { headers: { 'content-type': 'text/html' } }))
      })
    ).rejects.toThrow(/content-type/);
    await expect(fetchJson(good, { fetch: mk(new Response('[]')) })).rejects.toThrow(/object/);
    await expect(
      fetchJson(good, { fetch: mk(new Response('x', { status: 404 })) })
    ).rejects.toThrow(/HTTP 404/);
  });
  it('aborts a 10 MB body early while streaming', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(32);
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        if (pulled > 160) return c.close(); // 10 MB total if never stopped
        c.enqueue(chunk);
      }
    });
    const f: FetchFn = async () => new Response(body);
    await expect(fetchJson(good, { fetch: f })).rejects.toThrow(/over 262144 bytes/);
    expect(pulled).toBeLessThan(10);
  });
  it('rejects an oversized content-length without reading', async () => {
    const f: FetchFn = async () =>
      new Response('{}', { headers: { 'content-length': '10000000' } });
    await expect(fetchJson(good, { fetch: f })).rejects.toThrow(/over/);
  });
  it('times out a hanging request', async () => {
    const f: FetchFn = (_u, i) =>
      new Promise((_, rej) => i.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
    await expect(fetchJson(good, { fetch: f, timeoutMs: 30 })).rejects.toThrow(/timeout/);
  });
  it('times out a body that stalls mid-stream', async () => {
    const body = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
    const f: FetchFn = async () => new Response(body);
    await expect(fetchJson(good, { fetch: f, timeoutMs: 30 })).rejects.toThrow(/timeout/);
  });
});

describe('fetchJsonHashed', () => {
  it('hashes the exact bytes it parsed, not a re-serialisation', async () => {
    const raw = '{ "b": 1,\n  "a": 2 }\n';
    const f: FetchFn = async () =>
      new Response(raw, { headers: { 'content-type': 'application/json' } });
    const r = await fetchJsonHashed(good, { fetch: f });
    expect(r.json).toEqual({ a: 2, b: 1 });
    expect(r.sha256).toBe(createHash('sha256').update(raw).digest('hex'));
  });
});
