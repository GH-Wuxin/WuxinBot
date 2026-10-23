// PP+ (PerformancePlus) client — talks to the local PP+ aggregate service.
// Normalizes raw dimension values into display bars matching LazyBot's panel.

import { readDb, updateDb } from '../store.js';
import { createHash } from 'node:crypto';

// ── Auth (with in-memory caching + timeout) ──

export type PPlusErrorCode = 'AUTH' | 'TIMEOUT' | 'UNAVAILABLE' | 'INVALID_RESPONSE' | 'NO_SCORES' | 'QUEUE_FULL';
export class PPlusError extends Error {
  constructor(public readonly code: PPlusErrorCode, message: string) {
    super(message);
    this.name = 'PPlusError';
  }
}

function duration(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
const REQUEST_TIMEOUT_MS = duration('PPLUS_REQUEST_TIMEOUT_MS', 15_000);
const JOB_TIMEOUT_MS = duration('PPLUS_JOB_TIMEOUT_MS', 30 * 60_000);
const POLL_INTERVAL_MS = duration('PPLUS_POLL_INTERVAL_MS', 1_500);
type Configuration = { baseUrl: string; clientId: string; clientSecret: string; key: string };

function configuration(settings = readDb().settings as Record<string, unknown>): Configuration {
  const baseUrl = String(settings.pplusBaseUrl || 'http://127.0.0.1:9001').replace(/\/+$/, '');
  const clientId = String(settings.pplusClientId || '');
  const clientSecret = String(settings.pplusClientSecret || '');
  const key = createHash('sha256').update(JSON.stringify([baseUrl, clientId, clientSecret])).digest('hex');
  return { baseUrl, clientId, clientSecret, key };
}

async function requestJson(url: string, opts: RequestInit = {}): Promise<{ status: number; json: any }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...opts, signal: ctrl.signal });
    const json = await response.json(); // The deadline also covers the body.
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new SyntaxError('Invalid envelope');
    return { status: response.status, json };
  } catch (error) {
    if (ctrl.signal.aborted) throw new PPlusError('TIMEOUT', 'PP+ 服务响应超时，请稍后重试。');
    if (error instanceof SyntaxError) throw new PPlusError('INVALID_RESPONSE', 'PP+ 服务返回了无效数据。');
    throw new PPlusError('UNAVAILABLE', 'PP+ 服务连接失败，请检查聚合服务。');
  } finally {
    clearTimeout(timer);
  }
}

let ppTokenCache: { key: string; token: string; expiresAt: number } | null = null;
let tokenInflight: { key: string; promise: Promise<string> } | null = null;
async function getPPlusToken(config: Configuration): Promise<string> {
  if (ppTokenCache?.key === config.key && Date.now() < ppTokenCache.expiresAt) return ppTokenCache.token;
  if (tokenInflight?.key === config.key) return tokenInflight.promise;
  const promise = (async () => {
    const { baseUrl, clientId, clientSecret } = config;
    if (!clientId || !clientSecret) throw new PPlusError('AUTH', 'PP+ 凭据未配置，请联系管理员。');
    const { status, json } = await requestJson(`${baseUrl}/auth/token?clientId=${encodeURIComponent(clientId)}&clientSecret=${encodeURIComponent(clientSecret)}`, { method: 'POST' });
    if (status >= 400 || json.code !== 200 || typeof json.data !== 'string' || !json.data) {
      throw new PPlusError('AUTH', 'PP+ 认证失败，请管理员检查客户端 ID 和密钥。');
    }
    ppTokenCache = { key: config.key, token: json.data, expiresAt: Date.now() + 23 * 3600 * 1000 };
    return json.data as string;
  })();
  tokenInflight = { key: config.key, promise };
  try { return await promise; }
  finally { if (tokenInflight?.promise === promise) tokenInflight = null; }
}

async function authorizedRequest(config: Configuration, route: string, method = 'GET') {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getPPlusToken(config);
    const result = await requestJson(config.baseUrl + route, { method, headers: { Authorization: `Bearer ${token}` } });
    if (result.status !== 401 && result.json.code !== 401) return result;
    if (ppTokenCache?.token === token) ppTokenCache = null;
  }
  throw new PPlusError('AUTH', 'PP+ 认证失效，请管理员检查客户端 ID 和密钥。');
}

export async function validatePPlusCredentials(settings: Record<string, unknown>): Promise<void> {
  await getPPlusToken(configuration(settings));
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
  return waitForPlayerJob(configuration(), osuUserId);
}

async function waitForPlayerJob(config: Configuration, osuUserId: string | number, refresh = false): Promise<PPlusPerformance | null> {
  const id = encodeURIComponent(String(osuUserId));
  const startRoute = `/player/jobs?id=${id}${refresh ? '&refresh=true' : ''}`;
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  let start = true;
  let failures = 0;
  while (Date.now() < deadline) {
    let response: Awaited<ReturnType<typeof authorizedRequest>>;
    try {
      response = await authorizedRequest(config, start ? startRoute : `/player/jobs/status?id=${id}`, start ? 'POST' : 'GET');
      failures = 0;
    } catch (error) {
      if (!(error instanceof PPlusError) || !['TIMEOUT', 'UNAVAILABLE'].includes(error.code) || ++failures >= 3) throw error;
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      continue;
    }
    if (!start && (response.status === 404 || response.json.code === 404)) {
      // The aggregate restarted. Starting again is idempotent per player.
      start = true;
    } else {
      if (response.status >= 400 || response.json.code !== 200) {
        throw new PPlusError('UNAVAILABLE', 'PP+ 任务接口不可用，请检查聚合服务版本与运行状态。');
      }
      const job = response.json.data;
      if (String(job?.id) !== String(osuUserId)) throw new PPlusError('INVALID_RESPONSE', 'PP+ 返回的玩家任务不匹配。');
      if (job.status === 'completed') {
        const perf = job.result?.performances;
        const fields = ['pp', 'ppJumpAim', 'ppFlowAim', 'ppSpeed', 'ppStamina', 'ppPrecision', 'ppAcc'];
        if (!perf || fields.some(key => typeof perf[key] !== 'number' || !Number.isFinite(perf[key]) || perf[key] < 0)) {
          throw new PPlusError('INVALID_RESPONSE', 'PP+ 任务完成但六维数据不完整。');
        }
        return perf as PPlusPerformance;
      }
      if (job.status === 'failed') {
        if (job.errorCode === 'NO_SCORES') return null;
        if (job.errorCode === 'QUEUE_FULL') throw new PPlusError('QUEUE_FULL', 'PP+ 当前排队人数较多，请稍后重试。');
        throw new PPlusError('UNAVAILABLE', 'PP+ 玩家计算失败，请稍后重试。');
      }
      if (job.status !== 'queued' && job.status !== 'running') throw new PPlusError('INVALID_RESPONSE', 'PP+ 返回了未知任务状态。');
      start = false;
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new PPlusError('TIMEOUT', 'PP+ 仍在排队或计算，请稍后再次查询；已启动的任务会继续运行。');
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

export async function refreshPlayerPPlus(osuUserId: string | number): Promise<PPlusBars> {
  const config = configuration();
  const key = `${config.key}:${osuUserId}`;
  const existing = playerRefreshInflight.get(key);
  if (existing) return existing;
  const pending = (async () => {
    // Keep the last successful cache on failure, and prevent an older normal
    // calculation from committing its result after this forced refresh.
    await playerInflight.get(key)?.catch(() => undefined);
    const perf = await waitForPlayerJob(config, osuUserId, true);
    if (!perf) throw new PPlusError('NO_SCORES', 'PP+ 暂无可计算的标准模式成绩。');
    const bars = ppToBars(perf);
    writePPlusCache(osuUserId, bars, config.baseUrl);
    return bars;
  })();
  playerRefreshInflight.set(key, pending);
  try { return await pending; }
  finally { if (playerRefreshInflight.get(key) === pending) playerRefreshInflight.delete(key); }
}

// ── 24 小时缓存 ──
// 内存 + settings.pplusBarsCache 双层：进程重启后仍能命中，避免每条 info 都打 aggregate。
const PPLUS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const pplusMemCache = new Map<string, { bars: PPlusBars; at: number; baseUrl: string }>();
const playerInflight = new Map<string, Promise<PPlusBars | null>>();
const playerRefreshInflight = new Map<string, Promise<PPlusBars>>();

function readPPlusCache(osuUserId: string | number, baseUrl: string): { bars: PPlusBars; at: number } | null {
  const key = String(osuUserId);
  const memory = pplusMemCache.get(key);
  if (memory?.baseUrl === baseUrl) return memory;
  const stored = (readDb().settings as Record<string, any>)?.pplusBarsCache?.[key];
  if (stored?.baseUrl === baseUrl && stored.bars && Number.isFinite(Number(stored.at)) &&
      ['ppTotal', 'jump', 'flow', 'speed', 'stamina', 'precision', 'accuracy'].every(key =>
        typeof stored.bars[key] === 'number' && Number.isFinite(stored.bars[key]) && stored.bars[key] >= 0)) {
    const entry = { bars: stored.bars as PPlusBars, at: Number(stored.at), baseUrl };
    pplusMemCache.set(key, entry);
    return entry;
  }
  return null;
}

function writePPlusCache(osuUserId: string | number, bars: PPlusBars, baseUrl: string): void {
  const key = String(osuUserId);
  const entry = { bars, at: Date.now(), baseUrl };
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
  const config = configuration();
  const key = `${config.key}:${osuUserId}`;
  const refreshing = playerRefreshInflight.get(key);
  if (refreshing) return refreshing;
  const cached = readPPlusCache(osuUserId, config.baseUrl);
  if (cached && Date.now() - cached.at < PPLUS_CACHE_TTL_MS) return cached.bars;
  const existing = playerInflight.get(key);
  if (existing) return existing;
  const pending = (async () => {
    const perf = await waitForPlayerJob(config, osuUserId);
    if (!perf) return null;
    const bars = ppToBars(perf);
    writePPlusCache(osuUserId, bars, config.baseUrl);
    return bars;
  })();
  playerInflight.set(key, pending);
  try { return await pending; }
  finally { if (playerInflight.get(key) === pending) playerInflight.delete(key); }
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
