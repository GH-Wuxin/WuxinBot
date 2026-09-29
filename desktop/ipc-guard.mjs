import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Desktop IPC is privileged: the renderer must be the exact document loaded
// by the main window, not merely a page with the same origin or file scheme.
// Keep this module pure so the trust boundary can be exercised without
// starting Electron or any managed process.

function normalizeLocalPath(filePath) {
  const value = String(filePath || '');
  if (!value || /^[/\\]{2}/u.test(value)) return null;
  try {
    const resolved = path.resolve(value);
    if (/^[/\\]{2}/u.test(resolved)) return null;
    return process.platform === 'win32'
      ? resolved.replaceAll('/', '\\').toLowerCase()
      : resolved;
  } catch {
    return null;
  }
}

function normalizeFileDocument(url) {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch { return null; }
  if (parsed.protocol !== 'file:' || parsed.hostname || parsed.search) return null;
  try {
    const filePath = normalizeLocalPath(fileURLToPath(parsed));
    return filePath ? `file:${filePath}` : null;
  } catch {
    return null;
  }
}

function normalizeHttpDocument(url) {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch { return null; }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username || parsed.password || parsed.search) return null;
  return `${parsed.origin}${parsed.pathname}`;
}

function normalizeDocument(url) {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch { return null; }
  if (parsed.protocol === 'file:') return normalizeFileDocument(parsed.href);
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return normalizeHttpDocument(parsed.href);
  return null;
}

function addTrustedDocument(documents, url) {
  const document = normalizeDocument(url);
  if (document) documents.add(document);
}

/**
 * Build an explicit document trust set.
 *
 * `devUrl`, `packagedIndex`, and `fallbackUrl` are documents, not origins.
 * In particular, passing a loopback API base does not trust `/api/*` or any
 * other page on that origin. A hash is ignored because Electron may append a
 * renderer-local route fragment; query strings and all other protocols are
 * rejected.
 */
export function desktopAllowedOrigins({ devUrl = '', packagedIndex = '', fallbackUrl = '' } = {}) {
  const trustedDocuments = new Set();
  addTrustedDocument(trustedDocuments, devUrl);
  const packagedDocument = normalizeLocalPath(packagedIndex);
  if (packagedDocument) trustedDocuments.add(`file:${packagedDocument}`);
  addTrustedDocument(trustedDocuments, fallbackUrl);
  return { trustedDocuments };
}

export function isAllowedDesktopUrl(url, trust) {
  if (!trust?.trustedDocuments || !(trust.trustedDocuments instanceof Set)) return false;
  const document = normalizeDocument(url);
  return document !== null && trust.trustedDocuments.has(document);
}

/**
 * Electron's event.sender identifies the webContents and senderFrame identifies
 * the exact frame. Both identities are required; same-webContents subframes
 * must never inherit the main frame's privileged IPC capability.
 */
export function isTrustedDesktopFrame({ mainWebContents, sender, senderFrame, trust } = {}) {
  if (!mainWebContents || sender !== mainWebContents) return false;
  if (!senderFrame || senderFrame !== mainWebContents.mainFrame) return false;
  return isAllowedDesktopUrl(senderFrame.url, trust);
}
