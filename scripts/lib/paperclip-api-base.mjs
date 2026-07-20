/**
 * Shared PAPERCLIP_API_URL resolver (AUR-3729).
 *
 * Root cause: PAPERCLIP_API_URL is configured as the VPS's public IP, but
 * agents/scripts run on that same VPS — outbound calls to the public IP
 * hairpin-NAT and hang. Swapping the host to 127.0.0.1 (never `localhost`;
 * IPv6 `::1` hangs) while preserving the configured scheme/port/path fixes
 * it without touching the env var itself.
 */

const PROBE_TIMEOUT_MS = 1500;
const DEFAULT_FALLBACK = 'http://127.0.0.1:3100';

let resolvedBase = null;
let resolvingPromise = null;

function stripTrailingSlash(url) {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** Swap only the host to 127.0.0.1, preserving scheme + port + path. */
export function loopbackFallback(configuredUrl) {
  if (!configuredUrl) return DEFAULT_FALLBACK;
  try {
    const u = new URL(configuredUrl);
    u.hostname = '127.0.0.1';
    return stripTrailingSlash(u.toString());
  } catch {
    return DEFAULT_FALLBACK;
  }
}

async function probeOnce(url, method) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, { method, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cheap reachability check: GET /api/health, falling back to HEAD / only if
 * the server responds but doesn't have that route (404) — a network-level
 * failure (timeout/refused/hairpin hang) is decisive and short-circuits.
 */
async function isReachable(base) {
  let res;
  try {
    res = await probeOnce(`${base}/api/health`, 'GET');
  } catch {
    return false;
  }
  if (res.status !== 404) return true;
  try {
    await probeOnce(`${base}/`, 'HEAD');
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the API base to use for this process: the configured
 * PAPERCLIP_API_URL if reachable, else a 127.0.0.1 loopback fallback.
 * Memoized for the process lifetime.
 */
export async function resolveApiBase() {
  if (resolvedBase) return resolvedBase;
  if (resolvingPromise) return resolvingPromise;

  resolvingPromise = (async () => {
    const raw = process.env.PAPERCLIP_API_URL || '';
    const configured = raw ? stripTrailingSlash(raw) : '';

    if (configured) {
      try {
        const u = new URL(configured);
        if (u.hostname === '127.0.0.1') {
          resolvedBase = configured;
          console.error(`[api-base] using ${resolvedBase} (already loopback)`);
          return resolvedBase;
        }
      } catch {
        // invalid PAPERCLIP_API_URL — fall through to the default fallback below.
      }
    }

    if (configured && (await isReachable(configured))) {
      resolvedBase = configured;
      console.error(`[api-base] using ${resolvedBase}`);
      return resolvedBase;
    }

    resolvedBase = loopbackFallback(configured);
    console.error(
      configured
        ? `[api-base] using ${resolvedBase} (configured ${configured} unreachable)`
        : `[api-base] using ${resolvedBase} (no PAPERCLIP_API_URL configured)`,
    );
    return resolvedBase;
  })();

  return resolvingPromise;
}

/** Test-only: clear memoized state so each test starts fresh. */
export function __resetForTest() {
  resolvedBase = null;
  resolvingPromise = null;
}
