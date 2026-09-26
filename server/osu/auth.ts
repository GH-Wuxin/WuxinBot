// osu! OAuth Client Credentials token manager.
// Token lives in process memory only — never persisted to disk or returned in APIs.

import dns from 'node:dns';
import type { OsuToken } from './types.js';

// This host has working IPv4 connectivity to Cloudflare but advertises an IPv6
// route that can remain in SYN_SENT until Undici's connect timeout. Both OAuth
// and API calls resolve osu.ppy.sh through the process-wide dns.lookup default,
// so prefer IPv4 before either request path opens a connection. Numeric
// loopback service URLs (Skill Profiler, OneBot, yumu-image) are unaffected.
const requestedDnsOrder = String(process.env.OSU_DNS_ORDER || 'ipv4first').trim().toLowerCase();
const OSU_DNS_ORDER: 'ipv4first' | 'ipv6first' | 'verbatim' =
  requestedDnsOrder === 'ipv6first' || requestedDnsOrder === 'verbatim'
    ? requestedDnsOrder
    : 'ipv4first';
dns.setDefaultResultOrder(OSU_DNS_ORDER);

// Overridable for offline verification (recommend-verify serves a local mock).
const TOKEN_URL = process.env.OSU_TOKEN_URL || 'https://osu.ppy.sh/oauth/token';
const configuredTokenTimeout = Number(process.env.OSU_TOKEN_TIMEOUT_MS || 15_000);
const TOKEN_TIMEOUT_MS = Number.isFinite(configuredTokenTimeout)
  ? Math.max(1_000, configuredTokenTimeout)
  : 15_000;
const TOKEN_MAX_ATTEMPTS = 2;
const TOKEN_RETRY_BACKOFF_MS = 300;

let currentToken: OsuToken | null = null;
let refreshPromise: Promise<OsuToken> | null = null;

// osu! OAuth Client Credentials token manager.
// Reads credentials from env vars (priority) or Wuxin DB settings.

import { readDb } from '../store.js';

function readCredentials() {
  const id = process.env.OSU_CLIENT_ID || '';
  const secret = process.env.OSU_CLIENT_SECRET || '';
  if (id && secret) return { client_id: id, client_secret: secret };
  // Fallback to DB-stored credentials
  try {
    const db = readDb();
    const dbId = String((db.settings as Record<string, unknown>).osuClientId || '').trim();
    const dbSecret = String((db.settings as Record<string, unknown>).osuClientSecret || '').trim();
    if (dbId && dbSecret) return { client_id: dbId, client_secret: dbSecret };
  } catch { /* DB not available */ }
  throw new Error('osu! OAuth 凭据未配置。请在环境变量 OSU_CLIENT_ID/OSU_CLIENT_SECRET 中设置，或在 GUI 中填写。');
}

function isRetryableTokenError(error: unknown): boolean {
  const name = String((error as { name?: string } | undefined)?.name || '');
  const message = String((error as { message?: string } | undefined)?.message || error || '');
  return name === 'AbortError' || /aborted|fetch failed|network|socket|ECONNRESET|ETIMEDOUT/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function fetchToken(): Promise<OsuToken> {
  const creds = readCredentials();
  let lastError: unknown;

  for (let attempt = 1; attempt <= TOKEN_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
    try {
      const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ...creds, grant_type: 'client_credentials', scope: 'public' }),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (attempt < TOKEN_MAX_ATTEMPTS && (response.status === 429 || response.status >= 500)) {
          try { await response.body?.cancel(); } catch { /* best effort */ }
          await sleep(TOKEN_RETRY_BACKOFF_MS * attempt);
          continue;
        }
        const body = await response.text().catch(() => '');
        throw new Error(`osu! OAuth token 请求失败 ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
      }
      const data = await response.json();
      if (!data?.access_token) throw new Error('osu! OAuth token 响应缺少 access_token');
      return {
        access_token: data.access_token,
        token_type: data.token_type || 'Bearer',
        expires_at: Date.now() + ((Number(data.expires_in) || 86400) - 60) * 1000
      };
    } catch (error) {
      lastError = error;
      if (!isRetryableTokenError(error)) throw error;
      if (attempt >= TOKEN_MAX_ATTEMPTS) break;
      await sleep(TOKEN_RETRY_BACKOFF_MS * attempt);
    } finally {
      clearTimeout(timer);
    }
  }

  const name = String((lastError as { name?: string } | undefined)?.name || '');
  const message = String((lastError as { message?: string } | undefined)?.message || lastError || '未知错误');
  if (name === 'AbortError' || /aborted/i.test(message)) {
    throw new Error('osu! OAuth token 请求超时（已自动重试 1 次）');
  }
  throw new Error(`osu! OAuth token 网络请求失败（已自动重试 1 次）：${message}`);
}

export async function getToken(): Promise<string> {
  if (currentToken && Date.now() < currentToken.expires_at) {
    return currentToken.access_token;
  }
  if (refreshPromise) return (await refreshPromise).access_token;
  refreshPromise = fetchToken()
    .then((token) => { currentToken = token; refreshPromise = null; return token; })
    .catch((error) => { refreshPromise = null; throw error; });
  return (await refreshPromise).access_token;
}

export async function refreshTokenOn401(): Promise<string> {
  currentToken = null;
  return getToken();
}
