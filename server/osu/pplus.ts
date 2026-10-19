// PP+ (PerformancePlus) client — talks to the local PP+ aggregate service.
// Normalizes raw dimension values into display bars matching LazyBot's panel.

import { readDb, updateDb } from '../store.js';

// ── Auth (with in-memory caching + timeout) ──

function fetchPP(url: string, opts: RequestInit = {}, timeoutMs: number = 10000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// A cache hit returns almost instantly, but the aggregate service initializes a
// previously unseen player inside GET /player/info. That first request may need
// to download and calculate up to 200 best scores, so the ordinary 10 second
// service timeout is far too short. Aborting the client request does not stop
// the Java-side calculation and used to make Analyze incorrectly report that
// PP+ was unavailable while initialization continued in the background.
// Measured 2026-10-19 under 20-way parallel player/update: successful calls
// reached 282s and the four heaviest were still running at 306s when the
// connection dropped. 360s is the ceiling with headroom over that observation.
const PLAYER_INFO_TIMEOUT_MS = 360_000;

let ppTokenCache: { token: string; expiresAt: number } | null = null;

async function getPPlusToken(): Promise<string> {
  if (ppTokenCache && Date.now() < ppTokenCache.expiresAt) return ppTokenCache.token;

  const db = readDb();
  const settings = db.settings as Record<string, unknown>;
  const clientId = String(settings.pplusClientId || '');
  const clientSecret = String(settings.pplusClientSecret || '');
  const baseUrl = String(settings.pplusBaseUrl || 'http://127.0.0.1:9001');
  if (!clientId || !clientSecret) throw new Error('PP+ 凭据未配置。');
  const resp = await fetchPP(`${baseUrl}/auth/token?clientId=${encodeURIComponent(clientId)}&clientSecret=${encodeURIComponent(clientSecret)}`, { method: 'POST' });
  if (!resp.ok) throw new Error(`PP+ 认证 HTTP ${resp.status}`);
  let json: any;
  try { json = await resp.json(); } catch { throw new Error('PP+ 认证返回了无效 JSON'); }
  if (json.code !== 200) throw new Error(`PP+ 认证失败：${json.msg || ''}`);
  const token = json.data as string;
  ppTokenCache = { token, expiresAt: Date.now() + 23 * 3600 * 1000 };
  return token;
}

// ── API ──

interface PPlusPerformance {
  pp: number;
  ppAim: number;
  ppJumpAim: number;
  ppFlowAim: number;
  ppPrecision: number;
  ppSpeed: number;
  ppStamina: number;
  ppAcc: number;
}

export interface PPlusBars {
  ppTotal: number;
  jump: number;
  flow: number;
  speed: number;
  stamina: number;
  precision: number;
  accuracy: number;
}

export async function getPlayerPPlus(osuUserId: string | number): Promise<PPlusPerformance | null> {
  const db = readDb();
  const settings = db.settings as Record<string, unknown>;
  const baseUrl = String(settings.pplusBaseUrl || 'http://127.0.0.1:9001');
  let token = await getPPlusToken();
  let resp: Response;
  const infoUrl = `${baseUrl}/player/info?id=${encodeURIComponent(String(osuUserId))}`;
  try {
    resp = await fetchPP(infoUrl, { headers: { Authorization: `Bearer ${token}` } }, PLAYER_INFO_TIMEOUT_MS);
    // The PP+ token is cached in Wuxin for 23 hours, but the aggregate service
    // can restart sooner. Re-authenticate once instead of silently losing PP+.
    if (resp.status === 401) {
      ppTokenCache = null;
      token = await getPPlusToken();
      resp = await fetchPP(infoUrl, { headers: { Authorization: `Bearer ${token}` } }, PLAYER_INFO_TIMEOUT_MS);
    }
  } catch (error: any) {
    console.error(`[PP+] player/info ${String(osuUserId)} request failed: ${error?.name || 'Error'}: ${error?.message || error}`);
    return null;
  }
  let json: any;
  try { json = await resp.json(); }
  catch {
    console.error(`[PP+] player/info ${String(osuUserId)} returned invalid JSON (HTTP ${resp.status})`);
    return null;
  }
  if (!resp.ok || json.code !== 200) {
    console.error(`[PP+] player/info ${String(osuUserId)} failed (HTTP ${resp.status}, code ${String(json.code ?? 'unknown')}): ${String(json.msg || '').slice(0, 160)}`);
    return null;
  }
  return json.data?.performances || null;
}

// ── Normalization (matches LazyBot PerformanceDimensionLimit + getScaledRatio) ──
// LazyBot clamps raw values at the per-dimension limit so its 530px bars never
// overflow. We only feed text/data consumers, so the limit stays as a reference
// line (15 = expertPlus benchmark) and raw values above it are NOT truncated.

const PP_DIMS: Record<string, { limit: number; alpha: number }> = {
  jump:     { limit: 11000, alpha: 0.903 },
  flow:     { limit: 8000,  alpha: 0.691 },
  speed:    { limit: 7500,  alpha: 1.109 },
  stamina:  { limit: 6200,  alpha: 0.993 },
  precision:{ limit: 6000,  alpha: 0.741 },
  accuracy: { limit: 4000,  alpha: 0.891 },
};

function normalizeBar(rawValue: number, limit: number, alpha: number): number {
  if (rawValue < 0) rawValue = 0;
  return Math.pow(rawValue, alpha) / Math.pow(limit, alpha) * 15;
}

export function ppToBars(perf: PPlusPerformance): PPlusBars {
  return {
    ppTotal: Math.round(perf.pp || 0),
    jump:     normalizeBar(perf.ppJumpAim || 0,  PP_DIMS.jump.limit,      PP_DIMS.jump.alpha),
    flow:     normalizeBar(perf.ppFlowAim || 0,  PP_DIMS.flow.limit,      PP_DIMS.flow.alpha),
    speed:    normalizeBar(perf.ppSpeed || 0,    PP_DIMS.speed.limit,     PP_DIMS.speed.alpha),
    stamina:  normalizeBar(perf.ppStamina || 0,  PP_DIMS.stamina.limit,   PP_DIMS.stamina.alpha),
    precision:normalizeBar(perf.ppPrecision || 0,PP_DIMS.precision.limit, PP_DIMS.precision.alpha),
    accuracy: normalizeBar(perf.ppAcc || 0,      PP_DIMS.accuracy.limit,  PP_DIMS.accuracy.alpha),
  };
}

export async function refreshPlayerPPlus(osuUserId: string | number): Promise<void> {
  const db = readDb();
  const settings = db.settings as Record<string, unknown>;
  const baseUrl = String(settings.pplusBaseUrl || 'http://127.0.0.1:9001');
  const token = await getPPlusToken();
  const resp = await fetchPP(`${baseUrl}/player/update?id=${encodeURIComponent(String(osuUserId))}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  }, 360_000); // player update fetches every score; measured ceiling 306s at 20-way parallelism
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`PP+ refresh failed HTTP ${resp.status}: ${text.slice(0, 100)}`);
  }
}

// ── 24 小时缓存 ──
// 内存 + settings.pplusBarsCache 双层：进程重启后仍能命中，避免每条 info 都打 aggregate。
const PPLUS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const pplusMemCache = new Map<string, { bars: PPlusBars; at: number }>();

function readPPlusCache(osuUserId: string | number): { bars: PPlusBars; at: number } | null {
  const key = String(osuUserId);
  const memory = pplusMemCache.get(key);
  if (memory) return memory;
  const stored = (readDb().settings as Record<string, any>)?.pplusBarsCache?.[key];
  if (stored && stored.bars && Number.isFinite(Number(stored.at))) {
    const entry = { bars: stored.bars as PPlusBars, at: Number(stored.at) };
    pplusMemCache.set(key, entry);
    return entry;
  }
  return null;
}

function writePPlusCache(osuUserId: string | number, bars: PPlusBars): void {
  const key = String(osuUserId);
  const entry = { bars, at: Date.now() };
  pplusMemCache.set(key, entry);
  try {
    updateDb((db: any) => {
      const cache = { ...(db.settings.pplusBarsCache || {}), [key]: entry };
      // 只保留最近 500 个玩家，防止 settings 无限膨胀
      const keys = Object.keys(cache);
      if (keys.length > 500) {
        keys.sort((a, b) => Number(cache[b].at || 0) - Number(cache[a].at || 0));
        for (const stale of keys.slice(500)) delete cache[stale];
      }
      db.settings.pplusBarsCache = cache;
    });
  } catch { /* 缓存写失败不影响回复 */ }
}

export async function getPlayerBars(osuUserId: string | number): Promise<PPlusBars | null> {
  const cached = readPPlusCache(osuUserId);
  if (cached && Date.now() - cached.at < PPLUS_CACHE_TTL_MS) return cached.bars;

  const perf = await getPlayerPPlus(osuUserId);
  if (perf) {
    const bars = ppToBars(perf);
    writePPlusCache(osuUserId, bars);
    return bars;
  }

  // 第一次查某个玩家时 aggregate 里还没有记录，/player/info 会直接报错。
  // 主动触发一次初始化再取一次，让「第一次查询」也有 PP+（这条回复会慢一些）。
  try {
    await refreshPlayerPPlus(osuUserId);
  } catch (error) {
    console.error(`[PP+] player/update ${String(osuUserId)} failed: ${(error as Error)?.message || error}`);
    return cached ? cached.bars : null;
  }
  const retried = await getPlayerPPlus(osuUserId);
  if (!retried) return cached ? cached.bars : null;
  const bars = ppToBars(retried);
  writePPlusCache(osuUserId, bars);
  return bars;
}

export function formatBarsForPrompt(bars: PPlusBars, label: string): string {
  const dims: [string, number][] = [
    ['Jump',     bars.jump],
    ['Flow',     bars.flow],
    ['Speed',    bars.speed],
    ['Stamina',  bars.stamina],
    ['Precision',bars.precision],
    ['Accuracy', bars.accuracy],
  ];
  dims.sort((a, b) => b[1] - a[1]);
  const lines = dims.map(([name, val]) => `  ${name.padEnd(10)} ${val.toFixed(2)}`);
  return `${label}（PP+ ${bars.ppTotal}pp）：\n${lines.join('\n')}`;
}
