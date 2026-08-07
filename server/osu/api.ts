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

export interface OsuBeatmapAttributes {
  star_rating: number;
  max_combo?: number;
}

function fetchWithTimeout(url: string, opts: RequestInit, timeoutMs: number = 15000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

async function osuFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = `${API_BASE}${path}`;
  const token = await getToken();
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` } as Record<string, string>;
  const response = await fetchWithTimeout(url, { ...options, headers });
  if (response.status === 429) recordOsuApi429();
  if (response.status === 401) {
    const newToken = await refreshTokenOn401();
    const retryHeaders = { ...(options.headers || {}), Authorization: `Bearer ${newToken}` } as Record<string, string>;
    const retryResponse = await fetchWithTimeout(url, { ...options, headers: retryHeaders });
    if (retryResponse.status === 429) recordOsuApi429();
    if (!retryResponse.ok) throw new Error(`osu! API ${retryResponse.status} ${path}`);
    return retryResponse.json() as Promise<T>;
  }
  if (!response.ok) {
    if (response.status === 404) throw new Error(`osu! 资源不存在 ${path}`);
    throw new Error(`osu! API ${response.status} ${path}`);
  }
  return response.json() as Promise<T>;
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
