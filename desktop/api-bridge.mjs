// Loopback API bridge validation (S01 layer 2).
// The packaged renderer talks to the bot API only through main-process
// handlers, so webSecurity can stay enabled. The bridge must not become a
// generic fetchAnyUrl: targets are pinned to the configured unauthenticated
// loopback API base, /api/* paths, a fixed method set, and an allowlisted
// header set.

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);
const ALLOWED_HEADERS = new Set(['content-type', 'accept', 'x-wuxin-admin-password']);

export function assertLoopbackBase(apiBase) {
  const base = new URL(String(apiBase || ''));
  if (base.protocol !== 'http:'
    || !['127.0.0.1', 'localhost'].includes(base.hostname.toLowerCase())
    || base.username || base.password) {
    throw new Error('API bridge base must be an unauthenticated loopback HTTP URL');
  }
  return base;
}

export function resolveApiRequest({ apiBase, url, method = 'GET', headers = {} }) {
  const base = assertLoopbackBase(apiBase);
  const target = new URL(String(url || ''));
  if (target.origin !== base.origin) {
    throw new Error('API bridge target origin is not the loopback API');
  }
  if (!target.pathname.startsWith('/api/')) {
    throw new Error('API bridge only serves /api/* paths');
  }
  const verb = String(method || 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(verb)) {
    throw new Error(`API bridge method not allowed: ${verb}`);
  }
  const safeHeaders = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const name = String(key).toLowerCase();
    if (ALLOWED_HEADERS.has(name) && value !== undefined && value !== null) {
      safeHeaders[String(key)] = String(value);
    }
  }
  return { url: target.href, method: verb, headers: safeHeaders };
}

export const MAX_API_RESPONSE_BYTES = 8 * 1024 * 1024;
