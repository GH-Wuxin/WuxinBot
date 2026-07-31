// PP+ (PerformancePlus) client — talks to the local PP+ aggregate service.
// Normalizes raw dimension values into display bars matching LazyBot's panel.

import { readDb } from '../store.js';

// ── Auth (with in-memory caching + timeout) ──

function fetchPP(url: string, opts: RequestInit = {}, timeoutMs: number = 10000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

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
  const token = await getPPlusToken();
  let resp: Response;
  try { resp = await fetchPP(`${baseUrl}/player/info?id=${encodeURIComponent(String(osuUserId))}`, { headers: { Authorization: `Bearer ${token}` } }); }
  catch { return null; }
  if (!resp.ok) return null;
  let json: any;
  try { json = await resp.json(); } catch { return null; }
  if (json.code !== 200) return null;
  return json.data?.performances || null;
}

// ── Normalization (matches LazyBot PerformanceDimensionLimit + getScaledRatio) ──

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
  if (rawValue > limit) rawValue = limit;
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
  }, 120000); // player update is slow — fetches all scores
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`PP+ refresh failed HTTP ${resp.status}: ${text.slice(0, 100)}`);
  }
}

export async function getPlayerBars(osuUserId: string | number): Promise<PPlusBars | null> {
  const perf = await getPlayerPPlus(osuUserId);
  if (!perf) return null;
  return ppToBars(perf);
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
