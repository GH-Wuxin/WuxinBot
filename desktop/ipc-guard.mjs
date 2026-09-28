// Origin allowlist for Desktop IPC and navigation (S01 layer 1).
// The packaged app loads the bundled file:// renderer; dev loads the Vite
// server; the last-resort fallback loads the loopback API page. Everything
// else — other origins, other protocols, malformed URLs — is untrusted and
// must be refused before it can reach process management IPC.

export function desktopAllowedOrigins({ devUrl = '', apiBase = '' } = {}) {
  const origins = new Set(['file:']);
  for (const candidate of [devUrl, apiBase]) {
    try {
      const url = new URL(String(candidate || ''));
      if (url.protocol === 'http:' || url.protocol === 'https:') origins.add(url.origin);
    } catch { /* malformed URLs simply do not become allowlisted */ }
  }
  return origins;
}

export function isAllowedDesktopUrl(url, origins) {
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol === 'file:') return origins.has('file:');
    return origins.has(parsed.origin);
  } catch {
    return false;
  }
}
