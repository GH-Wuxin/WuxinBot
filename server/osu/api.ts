// osu! API v2 client. All calls go through getToken() and share the token manager.
// 401 triggers automatic re-auth exactly once per call.

import { getToken, refreshTokenOn401 } from './auth.js';
import { cacheGet, cacheSet } from './cache.js';
import { recordOsuApi429 } from '../health.js';
import type { OsuUser, OsuScore, OsuBeatmap, OsuMode, OsuMatch } from './types.js';

// Overridable for offline verification (recommend-verify serves a local mock).
const API_BASE = process.env.OSU_API_BASE_URL || 'https://osu.ppy.sh/api/v2';

const TTL = {
  user: 6 * 3600_000,
  beatmap: 24 * 3600_000,
  score: 120_000,
};

// The response cache only contains completed requests. Without a separate
// in-flight table, two commands arriving in the same event-loop turn can miss
// the cache together and issue identical requests to osu!. Coalesce only GETs:
// it removes accidental duplication without throttling unrelated API traffic.
const inFlightGets = new Map<string, Promise<unknown>>();
const GET_RETRY_BACKOFF_MS = 300;

// osu! throttles the OAuth client globally. Serialize request starts and keep
// a small gap between them so concurrent bot commands cannot create bursts.
const configuredMinInterval = Number(process.env.OSU_API_MIN_INTERVAL_MS || 120);
const OSU_API_MIN_INTERVAL_MS = Number.isFinite(configuredMinInterval)
  ? Math.max(0, configuredMinInterval)
  : 120;
const OSU_API_RATE_RETRIES = 1;
let requestSerial: Promise<void> = Promise.resolve();
let lastRequestStartedAt = 0;
let rateLimitedUntil = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function waitForOsuRequestSlot(): Promise<void> {
  let release!: () => void;
  const previous = requestSerial;
  requestSerial = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const earliest = Math.max(
      lastRequestStartedAt + OSU_API_MIN_INTERVAL_MS,
      rateLimitedUntil,
    );
    const waitMs = earliest - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    lastRequestStartedAt = Date.now();
  } finally {
    release();
  }
}

function retryAfterMs(response: Response, retryIndex: number): number {
  const raw = String(response.headers.get('retry-after') || '').trim();
  const seconds = Number(raw);
  const fromHeader = Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1000
    : raw
      ? Math.max(0, Date.parse(raw) - Date.now())
      : 0;
  const fallback = 1_000 * Math.pow(2, Math.max(0, retryIndex - 1));
  return Math.min(30_000, Math.max(1_000, fromHeader || fallback));
}

function extendRateLimitCooldown(delayMs: number): void {
  rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + delayMs);
}

export interface OsuBeatmapAttributes {
  star_rating: number;
  max_combo?: number;
}

function isRetryableFetchError(error: unknown): boolean {
  const name = String((error as { name?: string } | undefined)?.name || '');
  const message = String((error as { message?: string } | undefined)?.message || error || '');
  return name === 'AbortError' || /aborted|fetch failed|network|socket|ECONNRESET|ETIMEDOUT/i.test(message);
}

async function fetchWithTimeout(url: string, opts: RequestInit, timeoutMs: number = 15000): Promise<Response> {
  // osu! API reads are idempotent. A cold TLS connection occasionally reaches
  // this timeout, while an immediate manual retry succeeds. Retry GET once here
  // so callers do not have to repeat the whole command themselves. Mutating
  // requests (currently beatmap attributes POST) are never retried here.
  const method = String(opts.method || 'GET').toUpperCase();
  const maxAttempts = method === 'GET' ? 2 : 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, { ...opts, signal: ctrl.signal });
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableFetchError(error)) break;
      await new Promise((resolve) => setTimeout(resolve, GET_RETRY_BACKOFF_MS * attempt));
    } finally {
      clearTimeout(timer);
    }
  }

  const name = String((lastError as { name?: string } | undefined)?.name || '');
  const message = String((lastError as { message?: string } | undefined)?.message || lastError || '未知错误');
  if (name === 'AbortError' || /aborted/i.test(message)) {
    throw new Error(`osu! API 请求超时${maxAttempts > 1 ? '（已自动重试 1 次）' : ''}`);
  }
  throw new Error(`osu! API 网络请求失败${maxAttempts > 1 ? '（已自动重试 1 次）' : ''}：${message}`);
}

async function performOsuFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = `${API_BASE}${path}`;
  let token = await getToken();
  let authRetried = false;
  let rateRetried = 0;

  while (true) {
    const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` } as Record<string, string>;
    await waitForOsuRequestSlot();
    const response = await fetchWithTimeout(url, { ...options, headers });

    if (response.status === 429) {
      recordOsuApi429();
      if (rateRetried < OSU_API_RATE_RETRIES) {
        rateRetried += 1;
        extendRateLimitCooldown(retryAfterMs(response, rateRetried));
        try { await response.body?.cancel(); } catch { /* best effort */ }
        continue;
      }
    }

    if (response.status === 401 && !authRetried) {
      authRetried = true;
      token = await refreshTokenOn401();
      try { await response.body?.cancel(); } catch { /* best effort */ }
      continue;
    }
    if (!response.ok) {
      if (response.status === 404) throw new Error(`osu! 资源不存在 ${path}`);
      throw new Error(`osu! API ${response.status} ${path}`);
    }
    return response.json() as Promise<T>;
  }
}

async function osuFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = String(options.method || 'GET').toUpperCase();
  if (method !== 'GET') return performOsuFetch<T>(path, options);

  const key = `GET ${path}`;
  const existing = inFlightGets.get(key);
  if (existing) return existing as Promise<T>;

  const request = performOsuFetch<T>(path, options);
  inFlightGets.set(key, request);
  try {
    return await request;
  } finally {
    if (inFlightGets.get(key) === request) inFlightGets.delete(key);
  }
}

export async function getUser(
  username: string,
  mode: OsuMode = 'osu',
  options: { force?: boolean } = {},
): Promise<OsuUser> {
  const cacheKey = `user:${username}:${mode}`;
  const cached = cacheGet<OsuUser>(cacheKey);
  if (cached && !options.force) return cached;
  const user = await osuFetch<OsuUser>(`/users/@${encodeURIComponent(username)}/${mode}`);
  cacheSet(cacheKey, user, TTL.user);
  cacheSet(`user:${user.id}:${mode}`, user, TTL.user);
  if (user.username) cacheSet(`user:${user.username}:${mode}`, user, TTL.user);
  return user;
}

export async function getUserById(
  userId: number,
  mode: OsuMode = 'osu',
  options: { force?: boolean } = {},
): Promise<OsuUser> {
  const cacheKey = `user:${userId}:${mode}`;
  const cached = cacheGet<OsuUser>(cacheKey);
  if (cached && !options.force) return cached;
  const user = await osuFetch<OsuUser>(`/users/${userId}/${mode}`);
  cacheSet(cacheKey, user, TTL.user);
  if (user.username) cacheSet(`user:${user.username}:${mode}`, user, TTL.user);
  return user;
}

export async function getUserBestScores(userId: number, mode: OsuMode = 'osu', limit: number = 100): Promise<OsuScore[]> {
  const cacheKey = `best:${userId}:${mode}:${limit}`;
  const cached = cacheGet<OsuScore[]>(cacheKey);
  if (cached) return cached;
  const scores = await osuFetch<OsuScore[]>(`/users/${userId}/scores/best?mode=${mode}&limit=${limit}`);
  cacheSet(cacheKey, scores, TTL.score);
  return scores;
}

export async function getUserRecentScores(userId: number, mode: OsuMode = 'osu', limit: number = 50): Promise<OsuScore[]> {
  const scores = await osuFetch<OsuScore[]>(`/users/${userId}/scores/recent?mode=${mode}&limit=${limit}&include_fails=1`);
  return scores;
}

export async function getUserBeatmapScore(
  userId: number,
  beatmapId: number,
  mode: OsuMode = 'osu',
): Promise<OsuScore> {
  const cacheKey = `user-score:${userId}:${beatmapId}:${mode}`;
  const cached = cacheGet<OsuScore>(cacheKey);
  if (cached) return cached;
  // Same endpoint family as the original yumu `!s`: beatmap-scoped user score.
  // legacy_only=0 first (lazer), then 1 (stable) for scores not exposed by the
  // modern variant.
  let body: { score?: OsuScore } | undefined;
  for (const legacyOnly of ['0', '1']) {
    try {
      body = await osuFetch<{ score?: OsuScore }>(
        `/beatmaps/${beatmapId}/scores/users/${userId}?mode=${mode}&legacy_only=${legacyOnly}`,
      );
      break;
    } catch (error) {
      if (String(error?.message || '').includes('资源不存在')) continue;
      throw error;
    }
  }
  const score = body?.score;
  if (!score) throw new Error(`beatmap_score_not_found:${beatmapId}`);
  cacheSet(cacheKey, score, TTL.score);
  return score;
}

export async function getBeatmapScores(
  beatmapId: number,
  mode: OsuMode = 'osu',
  mods?: string[],
): Promise<OsuScore[]> {
  const normalizedMods = [...new Set((mods || []).map((mod) => String(mod).toUpperCase()).filter((mod) => mod && mod !== 'NM'))].sort();
  const modKey = normalizedMods.join(',');
  const cacheKey = `scores:${beatmapId}:${mode}:${modKey}`;
  const cached = cacheGet<OsuScore[]>(cacheKey);
  if (cached) return cached;
  const query = new URLSearchParams({ mode });
  if (normalizedMods.length > 0) query.set('mods', normalizedMods.join(''));
  const body = await osuFetch<{ scores?: OsuScore[] }>(`/beatmaps/${beatmapId}/scores?${query.toString()}`);
  const scores = Array.isArray(body?.scores) ? body.scores : [];
  cacheSet(cacheKey, scores, 30 * 60_000);
  return scores;
}

export async function getMatch(matchId: number): Promise<OsuMatch> {
  const cacheKey = `match:${matchId}`;
  const cached = cacheGet<OsuMatch>(cacheKey);
  if (cached) return cached;
  const match = await osuFetch<OsuMatch>(`/matches/${matchId}`);
  cacheSet(cacheKey, match, 30_000);
  return match;
}

export async function getMatchAfter(matchId: number, eventId: number): Promise<OsuMatch> {
  // No cache: the listener polls this every 8 seconds and needs fresh data.
  return osuFetch<OsuMatch>(`/matches/${matchId}?after=${eventId}`);
}

export async function getBeatmap(beatmapId: number): Promise<OsuBeatmap> {
  const cacheKey = `beatmap:${beatmapId}`;
  const cached = cacheGet<OsuBeatmap>(cacheKey);
  if (cached) return cached;
  const beatmap = await osuFetch<OsuBeatmap>(`/beatmaps/${beatmapId}`);
  cacheSet(cacheKey, beatmap, TTL.beatmap);
  return beatmap;
}

export async function getBeatmapAttributes(
  beatmapId: number,
  mode: OsuMode = 'osu',
  mods: string[] = [],
): Promise<{ attributes: OsuBeatmapAttributes }> {
  const normalizedMods = [...new Set(mods.map(mod => String(mod).toUpperCase()))]
    .filter(mod => mod && mod !== 'NM')
    .sort();
  const cacheKey = `attr:${beatmapId}:${mode}:${normalizedMods.join(',')}`;
  const cached = cacheGet<{ attributes: OsuBeatmapAttributes }>(cacheKey);
  if (cached) return cached;
  const body: Record<string, unknown> = { mods: normalizedMods };
  if (mode !== 'osu') body.ruleset_id = { taiko: 1, fruits: 2, mania: 3 }[mode] || 0;
  let attrs: { attributes: OsuBeatmapAttributes };
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      attrs = await osuFetch<{ attributes: OsuBeatmapAttributes }>(`/beatmaps/${beatmapId}/attributes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      cacheSet(cacheKey, attrs, TTL.beatmap);
      return attrs;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('429') || attempt >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
