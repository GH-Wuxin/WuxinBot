// osu! OAuth Client Credentials token manager.
// Token lives in process memory only — never persisted to disk or returned in APIs.

import type { OsuToken } from './types.js';

// Overridable for offline verification (recommend-verify serves a local mock).
const TOKEN_URL = process.env.OSU_TOKEN_URL || 'https://osu.ppy.sh/oauth/token';

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

async function fetchToken(): Promise<OsuToken> {
  const creds = readCredentials();
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ...creds, grant_type: 'client_credentials', scope: 'public' })
  });
  if (!response.ok) {
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
