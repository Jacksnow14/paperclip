import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveApiBase,
  loopbackFallback,
  __resetForTest,
} from './paperclip-api-base.mjs';

function withEnv(value, fn) {
  const prev = process.env.PAPERCLIP_API_URL;
  if (value === undefined) delete process.env.PAPERCLIP_API_URL;
  else process.env.PAPERCLIP_API_URL = value;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = prev;
  });
}

function withFetch(impl, fn) {
  const prev = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => { globalThis.fetch = prev; });
}

test.beforeEach(() => __resetForTest());

// ── (a) unreachable configured URL falls back to loopback ──────────────────

test('falls back to 127.0.0.1 loopback when the configured URL is unreachable', async () => {
  await withEnv('http://91.197.235.234:3100', () =>
    withFetch(
      async () => { throw new Error('network unreachable (hairpin NAT)'); },
      async () => {
        const base = await resolveApiBase();
        assert.equal(base, 'http://127.0.0.1:3100');
      },
    ),
  );
});

test('uses the configured URL directly when it is reachable', async () => {
  await withEnv('http://91.197.235.234:3100', () =>
    withFetch(
      async () => new Response('ok', { status: 200 }),
      async () => {
        const base = await resolveApiBase();
        assert.equal(base, 'http://91.197.235.234:3100');
      },
    ),
  );
});

test('falls back to the default loopback base when PAPERCLIP_API_URL is unset', async () => {
  await withEnv(undefined, () =>
    withFetch(
      async () => { throw new Error('should not be called'); },
      async () => {
        const base = await resolveApiBase();
        assert.equal(base, 'http://127.0.0.1:3100');
      },
    ),
  );
});

// ── (b) localhost is never used ─────────────────────────────────────────────

test('loopbackFallback swaps host to 127.0.0.1, never "localhost"', () => {
  const result = loopbackFallback('http://localhost:3210/api');
  assert.ok(!result.includes('localhost'), `expected no "localhost" in ${result}`);
  assert.ok(result.startsWith('http://127.0.0.1:3210'));
});

test('default fallback (no configured URL) is 127.0.0.1, never "localhost"', () => {
  const result = loopbackFallback('');
  assert.ok(!result.includes('localhost'));
  assert.equal(result, 'http://127.0.0.1:3100');
});

// ── (c) port is preserved when swapping host ────────────────────────────────

test('loopbackFallback preserves the configured port', () => {
  assert.equal(loopbackFallback('http://91.197.235.234:3210'), 'http://127.0.0.1:3210');
  assert.equal(loopbackFallback('http://91.197.235.234:3100'), 'http://127.0.0.1:3100');
});

test('loopbackFallback preserves scheme and path alongside host+port', () => {
  assert.equal(
    loopbackFallback('https://91.197.235.234:8443/api/v1'),
    'https://127.0.0.1:8443/api/v1',
  );
});

// ── (d) result is memoized ──────────────────────────────────────────────────

test('resolveApiBase memoizes the result for the process lifetime', async () => {
  await withEnv('http://91.197.235.234:3100', () => {
    let calls = 0;
    return withFetch(
      async () => { calls += 1; throw new Error('unreachable'); },
      async () => {
        const first = await resolveApiBase();
        const second = await resolveApiBase();
        assert.equal(first, second);
        assert.equal(calls, 1, 'fetch should only probe once across repeated resolves');
      },
    );
  });
});

test('resolveApiBase returns the same in-flight promise for concurrent callers', async () => {
  await withEnv('http://91.197.235.234:3100', () => {
    let calls = 0;
    return withFetch(
      async () => { calls += 1; throw new Error('unreachable'); },
      async () => {
        const [a, b] = await Promise.all([resolveApiBase(), resolveApiBase()]);
        assert.equal(a, b);
        assert.equal(calls, 1);
      },
    );
  });
});

// ── configured host already 127.0.0.1: no probing ──────────────────────────

test('returns the configured URL without probing when its host is already 127.0.0.1', async () => {
  await withEnv('http://127.0.0.1:3210', () =>
    withFetch(
      async () => { throw new Error('should not probe an already-loopback host'); },
      async () => {
        const base = await resolveApiBase();
        assert.equal(base, 'http://127.0.0.1:3210');
      },
    ),
  );
});
