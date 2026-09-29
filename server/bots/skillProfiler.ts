import type { LlmTool, ToolResult } from './types.js';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../store.js';
import { traceEvent } from '../requestTrace.js';
import {
  PLAYER_SKILL_AXIS_LABELS,
  PLAYER_SKILL_AXIS_ORDER,
} from './playerSkillAxes.js';

export const SKILL_PROFILER_TOOL_NAME = 'osu_analyze_beatmap_skills';
const DEFAULT_SKILL_PROFILER_URL = 'http://127.0.0.1:8767';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_SKILL_PROFILER_CONCURRENCY = 6;
const MAX_SKILL_PROFILER_CONCURRENCY = 8;
let activeAnalyses = 0;
const analysisWaiters: Array<() => void> = [];
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_OSU_FILE_BYTES = 4 * 1024 * 1024;
const DEFAULT_OSU_FILE_BASE_URL = 'https://osu.ppy.sh/osu/';
const IDENTITY_CACHE_TTL_MS = 30_000;
const ANALYSIS_RESPONSE_SCHEMA_VERSION = 'map_demand_bid_analysis_v0.1.0';
const UNVERIFIED_AXIS_SCHEMA = 'UNVERIFIED_AXIS_SCHEMA';
const UNIFIED_SCHEMA_UNCONFIGURED = 'UNIFIED_SCHEMA_UNCONFIGURED';
const UNIFIED_SCALE_UNCONFIGURED = 'UNIFIED_SCALE_UNCONFIGURED';
const UNIFIED_CALIBRATION_UNCONFIGURED = 'UNIFIED_CALIBRATION_UNCONFIGURED';
const MAP_DEMAND_CALIBRATION_UNCONFIGURED = 'MAP_DEMAND_CALIBRATION_UNCONFIGURED';
const MOD_CONTEXT_ORDER = [
  'NF', 'EZ', 'HD', 'HR', 'SD', 'DT', 'RX', 'HT', 'NC', 'FL',
  'AT', 'SO', 'AP', 'PF', 'DC', 'DA', 'WU', 'WD', 'AS', 'TP',
];
const NEUTRAL_PROFILER_MODS = new Set(['NM', 'NF', 'SD', 'PF']);
let identityCache: { at: number; value: SkillProfilerIdentity } | null = null;
const analysisInflight = new Map<string, Promise<any>>();
const PREFETCH_CONCURRENCY = 4;
const beatmapPrefetchInflight = new Map<number, Promise<void>>();
let activePrefetches = 0;
const prefetchWaiters: Array<() => void> = [];

export interface SkillProfilerIdentity {
  algorithmId: string;
  mapDemandVersion: string;
  unifiedScaleId: string;
  unifiedCalibrationKey: string;
  /** The response schema is not returned by /api/state, so use the locked API contract. */
  analysisSchemaVersion?: string;
  /** Optional on older callers; populated by the current /api/state. */
  axisSchemaVersion?: string;
  /** Optional when the unified calibration lane is unavailable. */
  unifiedSchemaVersion?: string;
  /** Top-level map-demand calibration, distinct from unified per-context calibration. */
  mapDemandCalibrationId?: string;
}

const AXIS_LABELS = PLAYER_SKILL_AXIS_LABELS;
const AXIS_DESCRIPTION = PLAYER_SKILL_AXIS_ORDER.map((axis) =>
  axis === 'spatial_precision'
    ? `${AXIS_LABELS[axis]}（小目标容错、落点稳定与微修正）`
    : AXIS_LABELS[axis],
).join('、');

function profilerBaseUrl(): URL {
  const configured = String(process.env.SKILL_PROFILER_URL || DEFAULT_SKILL_PROFILER_URL).trim();
  const url = new URL(configured);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname.toLowerCase()) ||
    url.username ||
    url.password
  ) {
    throw new Error('SKILL_PROFILER_URL must be an unauthenticated loopback HTTP URL');
  }
  return url;
}

function profilerTimeoutMs(): number {
  const parsed = Number(process.env.SKILL_PROFILER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isFinite(parsed) ? Math.max(1_000, Math.min(60_000, Math.round(parsed))) : DEFAULT_TIMEOUT_MS;
}

export function skillProfilerConcurrency(): number {
  const parsed = Number(process.env.SKILL_PROFILER_CONCURRENCY);
  if (!Number.isFinite(parsed)) return DEFAULT_SKILL_PROFILER_CONCURRENCY;
  return Math.max(1, Math.min(MAX_SKILL_PROFILER_CONCURRENCY, Math.floor(parsed)));
}

function textField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
}

interface NormalizedSkillProfilerIdentity {
  algorithmId: string;
  mapDemandVersion: string;
  analysisSchemaVersion: string;
  axisSchemaVersion: string;
  unifiedSchemaVersion: string;
  unifiedScaleId: string;
  unifiedCalibrationKey: string;
  mapDemandCalibrationId: string;
}

export function normalizeSkillProfilerIdentity(identity: SkillProfilerIdentity): NormalizedSkillProfilerIdentity {
  return {
    algorithmId: textField(identity?.algorithmId) || 'UNVERIFIED_ALGORITHM',
    mapDemandVersion: textField(identity?.mapDemandVersion) || 'UNVERIFIED_VERSION',
    analysisSchemaVersion: textField(identity?.analysisSchemaVersion) || ANALYSIS_RESPONSE_SCHEMA_VERSION,
    axisSchemaVersion: textField(identity?.axisSchemaVersion) || UNVERIFIED_AXIS_SCHEMA,
    unifiedSchemaVersion: textField(identity?.unifiedSchemaVersion) || UNIFIED_SCHEMA_UNCONFIGURED,
    unifiedScaleId: textField(identity?.unifiedScaleId) || UNIFIED_SCALE_UNCONFIGURED,
    unifiedCalibrationKey: textField(identity?.unifiedCalibrationKey) || UNIFIED_CALIBRATION_UNCONFIGURED,
    mapDemandCalibrationId: textField(identity?.mapDemandCalibrationId) || MAP_DEMAND_CALIBRATION_UNCONFIGURED,
  };
}

async function withAnalysisSlot<T>(run: () => Promise<T>): Promise<T> {
  // All profiles share the same Python workers. Wait outside the HTTP
  // execution deadline instead of timing out in the server's work queue.
  const concurrency = skillProfilerConcurrency();
  if (activeAnalyses >= concurrency || analysisWaiters.length > 0) {
    await new Promise<void>((resolve) => analysisWaiters.push(resolve));
  }
  activeAnalyses += 1;
  try {
    return await run();
  } finally {
    activeAnalyses -= 1;
    const next = analysisWaiters.shift();
    if (next) next();
  }
}

async function withPrefetchSlot<T>(run: () => Promise<T>): Promise<T> {
  if (activePrefetches >= PREFETCH_CONCURRENCY || prefetchWaiters.length > 0) {
    await new Promise<void>((resolve) => prefetchWaiters.push(resolve));
  }
  activePrefetches += 1;
  try {
    return await run();
  } finally {
    activePrefetches -= 1;
    const next = prefetchWaiters.shift();
    if (next) next();
  }
}

async function postProfiler(pathname: string, payload: Record<string, unknown>): Promise<any> {
  const url = new URL(pathname, profilerBaseUrl());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), profilerTimeoutMs());
  timer.unref?.();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > MAX_RESPONSE_BYTES) throw new Error('SKILL_PROFILER_RESPONSE_TOO_LARGE');
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new Error('SKILL_PROFILER_RESPONSE_TOO_LARGE');
    }
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`SKILL_PROFILER_INVALID_JSON (${response.status})`);
    }
    if (!response.ok) {
      const code = String(data?.error || `HTTP_${response.status}`).slice(0, 80);
      const message = String(data?.message || 'Skill Profiler request failed').slice(0, 300);
      throw new Error(`${code}: ${message}`);
    }
    return data;
  } catch (error: any) {
    if (error?.name === 'AbortError') throw new Error('SKILL_PROFILER_TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function getProfiler(pathname: string): Promise<any> {
  const url = new URL(pathname, profilerBaseUrl());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), profilerTimeoutMs());
  timer.unref?.();
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('SKILL_PROFILER_RESPONSE_TOO_LARGE');
    const data = JSON.parse(text);
    if (!response.ok) throw new Error(`SKILL_PROFILER_HTTP_${response.status}`);
    return data;
  } catch (error: any) {
    if (error?.name === 'AbortError') throw new Error('SKILL_PROFILER_TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function getSkillProfilerIdentity(): Promise<SkillProfilerIdentity> {
  if (identityCache && Date.now() - identityCache.at < IDENTITY_CACHE_TTL_MS) return identityCache.value;
  const state = await getProfiler('/api/state');
  const unified = state?.unified_measurements || {};
  const contexts = unified?.contexts && typeof unified.contexts === 'object' && !Array.isArray(unified.contexts)
    ? Object.entries(unified.contexts as Record<string, any>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([context, payload]) => `${context}:${String((payload as any)?.calibration_id || '')}:${String((payload as any)?.status || '')}`)
      .join('|')
    : '';
  const value = {
    algorithmId: String(state?.algorithm_id || 'UNVERIFIED_ALGORITHM'),
    mapDemandVersion: String(state?.map_demand_version || 'UNVERIFIED_VERSION'),
    analysisSchemaVersion: ANALYSIS_RESPONSE_SCHEMA_VERSION,
    axisSchemaVersion: String(state?.axis_schema_version || UNVERIFIED_AXIS_SCHEMA),
    unifiedSchemaVersion: String(unified?.schema_version || UNIFIED_SCHEMA_UNCONFIGURED),
    unifiedScaleId: String(unified?.scale_id || UNIFIED_SCALE_UNCONFIGURED),
    unifiedCalibrationKey: contexts || UNIFIED_CALIBRATION_UNCONFIGURED,
    mapDemandCalibrationId: String(state?.calibration_id || MAP_DEMAND_CALIBRATION_UNCONFIGURED),
  };
  identityCache = { at: Date.now(), value };
  return value;
}

function analysisCachePath(key: string): string {
  return path.join(getDataDir(), 'skill-profiler-analysis-cache', `${key}.json`);
}

function normalizedCacheMods(mods: string[]): string[] {
  const neutral = new Set(['NM', 'NF', 'SD', 'PF']);
  return [...new Set(mods.map((mod) => String(mod).toUpperCase()).map((mod) => mod === 'NC' ? 'DT' : mod)
    .map((mod) => mod === 'DC' ? 'HT' : mod).filter((mod) => !neutral.has(mod)))].sort();
}

// v1 keyed only [algorithmId, mapDemandVersion, beatmapId, mods] and silently
// served pre-recalibration results (finding F09). v2 added the first calibration
// fields. v3 namespaces the cache with the complete result identity and context,
// so entries written before this contract can never be a hit.
const ANALYSIS_CACHE_SCHEMA = 3;

export async function requestSkillProfilerAnalysisCachedWithFetch(
  beatmapId: number,
  mods: string[] = [],
  expectedIdentity?: SkillProfilerIdentity,
): Promise<any> {
  // Pinning the identity for a whole batch keeps one player profile on a single
  // calibration even if the workbench recalibrates mid-run (finding F09, §6.2).
  const identity = expectedIdentity ?? await getSkillProfilerIdentity();
  const canonicalMods = normalizedCacheMods(mods);
  const normalizedIdentity = normalizeSkillProfilerIdentity(identity);
  const source = JSON.stringify([
    ANALYSIS_CACHE_SCHEMA,
    normalizedIdentity.algorithmId,
    normalizedIdentity.mapDemandVersion,
    normalizedIdentity.analysisSchemaVersion,
    normalizedIdentity.axisSchemaVersion,
    normalizedIdentity.unifiedSchemaVersion,
    normalizedIdentity.unifiedScaleId,
    normalizedIdentity.unifiedCalibrationKey,
    normalizedIdentity.mapDemandCalibrationId,
    beatmapId,
    canonicalMods,
  ]);
  const key = createHash('sha256').update(source).digest('hex');
  const existing = analysisInflight.get(key);
  if (existing) return existing;
  const pending = (async () => {
    const file = analysisCachePath(key);
    let cachedPayload: any = null;
    try {
      cachedPayload = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* cache miss */
    }
    if (cachedPayload?.key === source && cachedPayload?.analysis?.status === 'OK') {
      try {
        assertAnalysisIdentity(cachedPayload.analysis, identity, canonicalMods);
        return cachedPayload.analysis;
      } catch (error: any) {
        if (!error?.message?.startsWith('ANALYSIS_IDENTITY_MISMATCH')) throw error;
        isolateInvalidAnalysisCache(file, error.message);
      }
    }
    const analysis = await requestSkillProfilerAnalysisWithFetch(beatmapId, canonicalMods);
    assertAnalysisIdentity(analysis, identity, canonicalMods);
    if (analysis?.status === 'OK') {
      let temporary = '';
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify({ key: source, analysis }), { encoding: 'utf8', flag: 'wx' });
        fs.copyFileSync(temporary, file);
      } catch (error: any) {
        // The cache is optional and rebuildable: a failed write must degrade to
        // a logged warning, never override the successful analysis (F11).
        traceEvent('TOOL', 'Skill：分析缓存写入失败，结果照常返回', {
          status: 'error', beatmapId, error: String(error?.message || error).slice(0, 160),
        });
      } finally {
        if (temporary) try { fs.unlinkSync(temporary); } catch { /* best effort */ }
      }
    }
    return analysis;
  })();
  analysisInflight.set(key, pending);
  try {
    return await pending;
  } finally {
    if (analysisInflight.get(key) === pending) analysisInflight.delete(key);
  }
}

function isolateInvalidAnalysisCache(file: string, reason: string): void {
  const isolated = `${file}.invalid-${process.pid}-${randomUUID()}`;
  try {
    fs.renameSync(file, isolated);
    traceEvent('TOOL', 'Skill：隔离身份不一致的分析缓存', {
      status: 'running', file: path.basename(file), isolated: path.basename(isolated),
      reason: reason.slice(0, 220),
    });
  } catch (error: any) {
    traceEvent('TOOL', 'Skill：身份异常缓存隔离失败，继续受控刷新', {
      status: 'error', file: path.basename(file), error: String(error?.message || error).slice(0, 160),
    });
  }
}

function canonicalProfilerModContext(mods: string[]): string {
  const order = new Map(MOD_CONTEXT_ORDER.map((mod, index) => [mod, index]));
  const effective = mods
    .map((mod) => {
      const upper = String(mod).toUpperCase();
      if (upper === 'NC') return 'DT';
      if (upper === 'DC') return 'HT';
      return upper;
    })
    .filter((mod) => !NEUTRAL_PROFILER_MODS.has(mod));
  return [...new Set(effective)]
    .sort((left, right) => (order.get(left) ?? MOD_CONTEXT_ORDER.length) - (order.get(right) ?? MOD_CONTEXT_ORDER.length) || left.localeCompare(right))
    .join('') || 'NM';
}

function unifiedCalibrationForContext(identity: NormalizedSkillProfilerIdentity, context: string): string | null {
  if (identity.unifiedCalibrationKey === UNIFIED_CALIBRATION_UNCONFIGURED) return null;
  const entries = identity.unifiedCalibrationKey.split('|').map((entry) => {
    const first = entry.indexOf(':');
    const last = entry.lastIndexOf(':');
    if (first <= 0 || last <= first) return null;
    return {
      context: entry.slice(0, first),
      calibrationId: entry.slice(first + 1, last),
      status: entry.slice(last + 1),
    };
  }).filter((entry): entry is { context: string; calibrationId: string; status: string } => Boolean(entry));
  const exact = entries.find((entry) => entry.context === context);
  if (exact) return exact.calibrationId || null;
  if (context === 'NM') {
    const defaultEntry = entries.find((entry) => entry.context.toLowerCase() === 'default');
    if (defaultEntry) return defaultEntry.calibrationId || null;
  }
  // A calibration explicitly scoped to another context must never become a
  // wildcard merely because it is the only configured entry. Missing context
  // configuration is a valid raw-axis-only lane; only an explicit exact or
  // protocol-defined default entry may attach a calibration.
  return null;
}

function firstIdentityField(...values: unknown[]): string {
  for (const value of values) {
    const text = textField(value);
    if (text) return text;
  }
  return '';
}

// Cross-check the response's self-reported identity against the identity the
// result was requested under. A workbench that recalibrated mid-batch must not
// have its new-scale output silently mixed into a batch pinned to the old one.
function assertAnalysisIdentity(analysis: any, expected: SkillProfilerIdentity, requestedMods: string[] = []): void {
  if (!expected || !analysis || analysis.status !== 'OK') return;
  const normalized = normalizeSkillProfilerIdentity(expected);
  const reported = analysis.identity && typeof analysis.identity === 'object' ? analysis.identity : {};
  const unified = analysis.unified_measurements && typeof analysis.unified_measurements === 'object'
    ? analysis.unified_measurements : {};
  const mismatch = (field: string, expectedValue: string, actualValue: string): never => {
    throw new Error(`ANALYSIS_IDENTITY_MISMATCH: ${field} expected ${expectedValue}, got ${actualValue || '<missing>'}`);
  };
  const requireValue = (field: string, value: string): string => {
    if (!value) mismatch(field, 'present', '');
    return value;
  };

  const reportedAlgorithm = firstIdentityField(reported.algorithm_id, analysis.algorithm_id);
  const reportedVersion = firstIdentityField(reported.map_demand_version, analysis.map_demand_version);
  if (!reportedAlgorithm || !reportedVersion) {
    mismatch('algorithm/map_demand_version', `${normalized.algorithmId}/${normalized.mapDemandVersion}`, 'missing');
  }
  if (reportedAlgorithm !== normalized.algorithmId) mismatch('algorithm_id', normalized.algorithmId, reportedAlgorithm);
  if (reportedVersion !== normalized.mapDemandVersion) mismatch('map_demand_version', normalized.mapDemandVersion, reportedVersion);

  const reportedSchema = firstIdentityField(analysis.schema_version, reported.schema_version);
  if (reportedSchema !== normalized.analysisSchemaVersion) {
    mismatch('analysis_schema_version', normalized.analysisSchemaVersion, reportedSchema);
  }

  const reportedMapCalibration = firstIdentityField(reported.calibration_id, analysis.calibration_id);
  if (normalized.mapDemandCalibrationId !== MAP_DEMAND_CALIBRATION_UNCONFIGURED) {
    if (!reportedMapCalibration) mismatch('map_demand_calibration_id', normalized.mapDemandCalibrationId, 'missing');
    if (reportedMapCalibration !== normalized.mapDemandCalibrationId) {
      mismatch('map_demand_calibration_id', normalized.mapDemandCalibrationId, reportedMapCalibration);
    }
  } else if (reportedMapCalibration) {
    mismatch('map_demand_calibration_id', MAP_DEMAND_CALIBRATION_UNCONFIGURED, reportedMapCalibration);
  }

  const reportedAxisSchema = firstIdentityField(
    reported.axis_schema_version,
    analysis.axis_schema_version,
  );
  if (reportedAxisSchema && normalized.axisSchemaVersion !== UNVERIFIED_AXIS_SCHEMA
    && reportedAxisSchema !== normalized.axisSchemaVersion) {
    mismatch('axis_schema_version', normalized.axisSchemaVersion, reportedAxisSchema);
  }

  const requestedContext = canonicalProfilerModContext(requestedMods);
  const expectedUnifiedCalibration = unifiedCalibrationForContext(normalized, requestedContext);
  const unifiedStatus = firstIdentityField(unified.status).toUpperCase();
  const reportedUnifiedSchema = firstIdentityField(unified.schema_version, reported.unified_schema_version);
  const reportedScale = firstIdentityField(
    unified.scale_id,
    unified.unified_scale_id,
    reported.unified_scale_id,
    reported.scale_id,
  );
  const reportedContext = firstIdentityField(unified.mod_context, reported.mod_context);
  const reportedUnifiedCalibration = firstIdentityField(
    unified.calibration_id,
    analysis.unified_calibration_id,
    reported.unified_calibration_id,
  );
  const expectedScaleConfigured = normalized.unifiedScaleId !== UNIFIED_SCALE_UNCONFIGURED;
  const expectedUnifiedSchemaConfigured = normalized.unifiedSchemaVersion !== UNIFIED_SCHEMA_UNCONFIGURED;

  if (unifiedStatus === 'ATTACHED') {
    requireValue('unified.schema_version', reportedUnifiedSchema);
    requireValue('unified.scale_id', reportedScale);
    requireValue('unified.mod_context', reportedContext);
    requireValue('unified.calibration_id', reportedUnifiedCalibration);
    if (!expectedScaleConfigured) mismatch('unified.status', 'raw-axis-only', 'ATTACHED');
    if (reportedScale !== normalized.unifiedScaleId) mismatch('unified.scale_id', normalized.unifiedScaleId, reportedScale);
    if (expectedUnifiedSchemaConfigured && reportedUnifiedSchema !== normalized.unifiedSchemaVersion) {
      mismatch('unified.schema_version', normalized.unifiedSchemaVersion, reportedUnifiedSchema);
    }
    if (reportedContext !== requestedContext) mismatch('unified.mod_context', requestedContext, reportedContext);
    if (!expectedUnifiedCalibration) mismatch('unified.calibration_id', 'configured current context', reportedUnifiedCalibration);
    if (reportedUnifiedCalibration !== expectedUnifiedCalibration) {
      mismatch('unified.calibration_id', expectedUnifiedCalibration, reportedUnifiedCalibration);
    }
  } else {
    if (expectedUnifiedCalibration) {
      mismatch('unified.status', 'ATTACHED', unifiedStatus || 'missing');
    }
    if (reportedUnifiedCalibration) {
      mismatch('unified.calibration_id', 'unconfigured current context', reportedUnifiedCalibration);
    }
    if (reportedScale && expectedScaleConfigured && reportedScale !== normalized.unifiedScaleId) {
      mismatch('unified.scale_id', normalized.unifiedScaleId, reportedScale);
    }
    if (reportedUnifiedSchema && expectedUnifiedSchemaConfigured && reportedUnifiedSchema !== normalized.unifiedSchemaVersion) {
      mismatch('unified.schema_version', normalized.unifiedSchemaVersion, reportedUnifiedSchema);
    }
    if (reportedContext && reportedContext !== requestedContext) {
      mismatch('unified.mod_context', requestedContext, reportedContext);
    }
  }
}

export function resetSkillProfilerIdentityCacheForTests(): void {
  identityCache = null;
}

function beatmapFileBaseUrl(): URL {
  const url = new URL(String(process.env.OSU_BEATMAP_FILE_BASE_URL || DEFAULT_OSU_FILE_BASE_URL).trim());
  const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname.toLowerCase());
  const official = url.protocol === 'https:' && url.hostname.toLowerCase() === 'osu.ppy.sh';
  if ((!loopback && !official) || url.username || url.password) {
    throw new Error('OSU_BEATMAP_FILE_BASE_URL must be official osu! HTTPS or loopback HTTP');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

async function downloadOsuFile(beatmapId: number): Promise<{ content: string; expected_md5?: string }> {
  const url = new URL(String(beatmapId), beatmapFileBaseUrl());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      headers: { Accept: 'text/plain, application/octet-stream;q=0.9' },
      redirect: 'follow',
      signal: controller.signal,
    });
    const finalUrl = new URL(response.url);
    const finalLoopback = finalUrl.protocol === 'http:'
      && ['127.0.0.1', 'localhost'].includes(finalUrl.hostname.toLowerCase());
    const finalOfficial = finalUrl.protocol === 'https:'
      && finalUrl.hostname.toLowerCase() === 'osu.ppy.sh';
    if (!finalLoopback && !finalOfficial) throw new Error('OSU_FILE_DOWNLOAD_REDIRECT_REJECTED');
    if (!response.ok) throw new Error(`OSU_FILE_DOWNLOAD_HTTP_${response.status}`);
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > MAX_OSU_FILE_BYTES) throw new Error('OSU_FILE_TOO_LARGE');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_OSU_FILE_BYTES) throw new Error('OSU_FILE_TOO_LARGE');
    const text = bytes.toString('utf8');
    if (!text.replace(/^\uFEFF/, '').startsWith('osu file format v')) throw new Error('OSU_FILE_INVALID_HEADER');
    if (!bytes.equals(Buffer.from(text, 'utf8'))) throw new Error('OSU_FILE_INVALID_ENCODING');
    const embedded = /^BeatmapID\s*:[ \t]*([^\r\n]*)/im.exec(text);
    const declaredBid = embedded ? Number(embedded[1]) : 0;
    if (declaredBid === beatmapId) return { content: text };
    if (declaredBid !== 0) throw new Error('OSU_FILE_BID_MISMATCH');
    // Official v9 files may omit BeatmapID. Verify the requested map's API
    // checksum and preserve the raw bytes; never insert an invented ID.
    const { getBeatmap } = await import('../osu/api.js');
    const metadata = await getBeatmap(beatmapId);
    const checksum = String(metadata.checksum || '').toLowerCase();
    if (metadata.id !== beatmapId || !/^[a-f0-9]{32}$/.test(checksum)
      || createHash('md5').update(bytes).digest('hex') !== checksum) {
      throw new Error('OSU_FILE_CHECKSUM_MISMATCH');
    }
    return { content: text, expected_md5: checksum };
  } catch (error: any) {
    if (error?.name === 'AbortError') throw new Error('OSU_FILE_DOWNLOAD_TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export interface SkillProfilerBeatmapPreflight {
  supported: boolean;
  available: number[];
  missing: number[];
}

export interface SkillProfilerBeatmapPrefetchResult {
  supported: boolean;
  requested: number;
  alreadyAvailable: number;
  missing: number;
  downloaded: number;
  failed: Array<{ beatmapId: number; reason: string }>;
}

function uniqueBeatmapIds(beatmapIds: readonly number[]): number[] {
  return [...new Set(beatmapIds
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0))];
}

/**
 * Ask the local workbench which .osu files are already available. This is a
 * cheap index lookup and never enters the Python analysis worker pool.
 * Older workbench processes do not expose /api/preflight, so callers retain
 * the old lazy-import path when the endpoint is unavailable.
 */
export async function scanSkillProfilerBeatmaps(
  beatmapIds: readonly number[],
): Promise<SkillProfilerBeatmapPreflight> {
  const ids = uniqueBeatmapIds(beatmapIds);
  if (!ids.length) return { supported: true, available: [], missing: [] };
  try {
    const result = await postProfiler('/api/preflight', { beatmap_ids: ids });
    const rows = Array.isArray(result?.beatmaps) ? result.beatmaps : [];
    const available = ids.filter((beatmapId) => rows.some((row: any) =>
      Number(row?.beatmap_id) === beatmapId && row?.available === true));
    return {
      supported: true,
      available,
      missing: ids.filter((beatmapId) => !available.includes(beatmapId)),
    };
  } catch (error: any) {
    const message = String(error?.message || error);
    if (/\b(?:NOT_FOUND|HTTP_404|SKILL_PROFILER_HTTP_404)\b/i.test(message)) {
      return { supported: false, available: [], missing: [] };
    }
    throw error;
  }
}

async function importBeatmapWithDownload(beatmapId: number): Promise<void> {
  const existing = beatmapPrefetchInflight.get(beatmapId);
  if (existing) return existing;
  const pending = withPrefetchSlot(async () => {
    const imported = await downloadOsuFile(beatmapId);
    await postProfiler('/api/import', { beatmap_id: beatmapId, ...imported });
  });
  beatmapPrefetchInflight.set(beatmapId, pending);
  try {
    await pending;
  } finally {
    if (beatmapPrefetchInflight.get(beatmapId) === pending) {
      beatmapPrefetchInflight.delete(beatmapId);
    }
  }
}

export async function prefetchSkillProfilerBeatmaps(
  beatmapIds: readonly number[],
  knownMissingIds?: readonly number[],
): Promise<SkillProfilerBeatmapPrefetchResult> {
  const ids = uniqueBeatmapIds(beatmapIds);
  const preflight = knownMissingIds
    ? { supported: true, available: ids.filter((id) => !knownMissingIds.includes(id)), missing: uniqueBeatmapIds(knownMissingIds) }
    : await scanSkillProfilerBeatmaps(ids);
  if (!preflight.supported) {
    return {
      supported: false,
      requested: ids.length,
      alreadyAvailable: 0,
      missing: 0,
      downloaded: 0,
      failed: [],
    };
  }
  const missing = preflight.missing.filter((beatmapId) => ids.includes(beatmapId));
  const outcomes = await Promise.all(missing.map(async (beatmapId) => {
    try {
      await importBeatmapWithDownload(beatmapId);
      return { beatmapId, ok: true as const };
    } catch (error: any) {
      return {
        beatmapId,
        ok: false as const,
        reason: String(error?.message || error).slice(0, 160),
      };
    }
  }));
  return {
    supported: true,
    requested: ids.length,
    alreadyAvailable: preflight.available.length,
    missing: missing.length,
    downloaded: outcomes.filter((outcome) => outcome.ok).length,
    failed: outcomes
      .filter((outcome): outcome is { beatmapId: number; ok: false; reason: string } => !outcome.ok)
      .map(({ beatmapId, reason }) => ({ beatmapId, reason })),
  };
}

export async function ensureSkillProfilerBeatmap(beatmapId: number): Promise<void> {
  const preflight = await scanSkillProfilerBeatmaps([beatmapId]);
  if (preflight.supported && preflight.available.includes(beatmapId)) return;
  await importBeatmapWithDownload(beatmapId);
}

function finiteNumber(value: unknown): number | null {
  // Measurement contract: only finite numbers are real values. null and
  // missing fields must stay missing — Number(null) is 0, which would disguise
  // unknown evidence as a genuine zero measurement (finding F10). Strings are
  // accepted only as explicit numeric literals; booleans, arrays and objects
  // are never measurements.
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || !/^-?\d+(?:\.\d+)?$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function skillProfilerAxisValue(
  analysis: any,
  axis: string,
): { value: number | null; scale: 'unified' | 'v040_axis'; status: string } {
  const item = analysis?.axes?.[axis] || {};
  const unifiedStatus = String(item?.unified_star_status || '').toUpperCase();
  const unifiedReady = analysis?.unified_measurements?.status === 'ATTACHED'
    && unifiedStatus === 'ADMITTED';
  const unifiedValue = finiteNumber(item?.unified_star_equivalent);
  if (unifiedReady && unifiedValue !== null) {
    return { value: unifiedValue, scale: 'unified', status: unifiedStatus };
  }
  const candidateAttached = analysis?.unified_measurements?.status === 'ATTACHED'
    && unifiedStatus === 'CANDIDATE'
    && unifiedValue !== null;
  return {
    value: finiteNumber(item?.stars),
    scale: 'v040_axis',
    // An ADMITTED axis with an unusable unified value falls back to the legacy
    // axis, and the status must say why: the number shown is legacy-scale, not
    // an admitted unified measurement.
    status: candidateAttached ? 'CANDIDATE_NOT_ADMITTED'
      : unifiedReady ? 'UNIFIED_VALUE_INVALID_LEGACY'
      : String(item?.confidence || 'UNVERIFIED'),
  };
}

function formatBeatmapTitle(beatmap: any): string {
  const artist = String(beatmap?.artist || '').trim();
  const title = String(beatmap?.title || '').trim();
  const version = String(beatmap?.version || '').trim();
  const creator = String(beatmap?.creator || '').trim();
  return [
    [artist, title].filter(Boolean).join(' - ') || `BID ${beatmap?.beatmap_id || '?'}`,
    version ? `[${version}]` : '',
    creator ? `(mapped by ${creator})` : '',
  ].filter(Boolean).join(' ');
}

export function formatSkillProfilerAnalysis(analysis: any): string {
  if (analysis?.status !== 'OK' || !analysis?.axes || !analysis?.beatmap) {
    throw new Error(`SKILL_PROFILER_ANALYSIS_NOT_OK: ${String(analysis?.status || 'UNVERIFIED')}`);
  }
  const beatmap = analysis.beatmap;
  const modContext = analysis.mod_context || {};
  const requestedMods = Array.isArray(modContext.requested_mods) ? modContext.requested_mods : [];
  const neutralMods = Array.isArray(modContext.neutral_mods) ? modContext.neutral_mods : [];
  const mods = requestedMods.length
    ? requestedMods.join('')
    : Array.isArray(modContext.effective_mods) && modContext.effective_mods.length
      ? modContext.effective_mods.join('')
    : 'NM';
  const difficulty = analysis.analysis_context?.effective_difficulty
    || analysis.analysis_context?.difficulty
    || beatmap.metadata?.difficulty
    || {};
  const bpm = finiteNumber(analysis.analysis_context?.bpm_max);
  const durationMs = finiteNumber(analysis.analysis_context?.duration_ms);
  const localStars = finiteNumber(beatmap.local_nm_stars);
  const identity = analysis.identity || {};
  const release = analysis.release || {};
  const sliderPressure = analysis.slider_pressure || analysis.map_demand?.slider_pressure || {};
  const sliderPressureScalar = finiteNumber(sliderPressure.scalar);
  const unified = analysis.unified_measurements || {};
  const unifiedAttached = unified.status === 'ATTACHED';
  const candidateUnifiedCount = unifiedAttached
    ? PLAYER_SKILL_AXIS_ORDER.filter((axis) => {
        const item = analysis.axes?.[axis] || {};
        return String(item.unified_star_status || '').toUpperCase() === 'CANDIDATE'
          && finiteNumber(item.unified_star_equivalent) !== null;
      }).length
    : 0;
  const lines = [
    'Skill Profiler 本地确定性谱面需求分析（正式 v0.40；各维是谱面需求，不是 osu! 官方总星数，也不是玩家能力评价）',
    `谱面：${formatBeatmapTitle(beatmap)}`,
    `BID：${beatmap.beatmap_id} · Mods：${mods}${neutralMods.length ? `（${neutralMods.join('/')} 对谱面需求分值无影响）` : ''}`,
    `发布：${String(identity.algorithm_id || 'UNVERIFIED_ALGORITHM')} · v${String(identity.map_demand_version || 'UNVERIFIED_VERSION')}${identity.formal_release_id || release.release_id ? ` · ${String(identity.formal_release_id || release.release_id)}` : ''}`,
    `环境：AR ${finiteNumber(difficulty.ApproachRate ?? difficulty.AR)?.toFixed(1) ?? '未知'} · OD ${finiteNumber(difficulty.OverallDifficulty ?? difficulty.OD)?.toFixed(1) ?? '未知'} · CS ${finiteNumber(difficulty.CircleSize ?? difficulty.CS)?.toFixed(1) ?? '未知'}${bpm === null ? '' : ` · BPM ${bpm.toFixed(1)}`}${durationMs === null ? '' : ` · 时长 ${(durationMs / 1000).toFixed(0)}s`}${localStars === null ? '' : ` · 本地 NM 总星数 ${localStars.toFixed(2)}★`}`,
    '九维需求：',
  ];
  if (candidateUnifiedCount > 0) {
    lines.push(`统一量尺：${candidateUnifiedCount} 个维度为 CANDIDATE，尚未进入正式输出；以下使用 v0.40 原轴值。`);
  }
  if (sliderPressureScalar === null) {
    lines.push(`SliderPressure：${String(sliderPressure.status || '未通过发布门')}（单位 normalized px/ms；不折算为加权星数）`);
  } else {
    lines.push(`SliderPressure：${sliderPressureScalar.toFixed(3)} normalized px/ms（支撑门通过；不折算为加权星数）`);
  }
  for (const axis of PLAYER_SKILL_AXIS_ORDER) {
    const item = analysis.axes[axis] || {};
    const measurement = skillProfilerAxisValue(analysis, axis);
    const legacy = finiteNumber(item.stars);
    const unit = measurement.scale === 'unified' ? '★（统一量尺）' : item.unit === 'bounded_0_10' ? '/10' : '★';
    const legacyNote = measurement.scale === 'unified' && legacy !== null ? `；v0.40 原轴 ${legacy.toFixed(1)}${item.unit === 'bounded_0_10' ? '/10' : '★'}` : '';
    lines.push(`- ${AXIS_LABELS[axis]}：${measurement.value === null ? '暂未输出' : `${measurement.value.toFixed(2)}${unit}`}${legacyNote}（置信度 ${String(item.confidence || 'UNVERIFIED')}）`);
  }
  const archetype = analysis.archetype || {};
  if (archetype.status === 'CLASSIFIED') {
    lines.push(
      `类型判断：${String(archetype.primary_type || 'UNVERIFIED')}` +
      `${Array.isArray(archetype.dominant_axes) && archetype.dominant_axes.length ? `；主导维度 ${archetype.dominant_axes.map((axis: string) => AXIS_LABELS[axis] || axis).join('、')}` : ''}` +
      `（置信度 ${String(archetype.confidence || 'UNVERIFIED')}）`,
    );
  }
  const experimentalType = analysis.experimental_type || {};
  const typeSummary = experimentalType.summary || {};
  if (experimentalType.stage === 'EXPERIMENTAL' && typeSummary.status === 'PROPOSED') {
    const primary = String(typeSummary.primary_type || 'UNVERIFIED').replaceAll('_', ' ');
    const secondary = Array.isArray(typeSummary.secondary_types)
      ? typeSummary.secondary_types.map((item: unknown) => String(item).replaceAll('_', ' ')).join('、')
      : '';
    lines.push(`实验性谱面类型：${primary}${secondary ? `；次类型 ${secondary}` : ''}（机器初判，可能有误）`);
  } else {
    lines.push('实验性谱面类型：暂无明确结论（机器选择弃权）');
  }
  const warnings = Array.isArray(analysis.warnings) ? analysis.warnings.filter(Boolean).slice(0, 5) : [];
  if (warnings.length) lines.push(`警告：${warnings.map((warning: unknown) => String(warning)).join('；')}`);
  lines.push('解释时优先描述“哪些维度相对突出/这张图难在哪里”；证据不足的维度和实验性类型必须保留边界，不要包装成官方定论。');
  return lines.join('\n');
}

export async function requestSkillProfilerAnalysis(
  beatmapId: number,
  mods: string[] = [],
): Promise<any> {
  return withAnalysisSlot(() => postProfiler('/api/analyze', {
    beatmap_id: beatmapId,
    mods,
  }));
}

export async function requestSkillProfilerAnalysisWithFetch(
  beatmapId: number,
  mods: string[] = [],
): Promise<any> {
  try {
    return await requestSkillProfilerAnalysis(beatmapId, mods);
  } catch (error: any) {
    const message = String(error?.message || error);
    if (!/^(?:BID_NOT_FOUND|OSU_FILE_MISSING):/.test(message)) throw error;
    await ensureSkillProfilerBeatmap(beatmapId);
    return requestSkillProfilerAnalysis(beatmapId, mods);
  }
}

export function buildSkillProfilerToolSchema(): LlmTool {
  return {
    type: 'function',
    function: {
      name: SKILL_PROFILER_TOOL_NAME,
      description: `使用正式 v0.40 分析一张本地已有的 osu!standard 谱面在 ${AXIS_DESCRIPTION} 九个维度上的谱面需求，并返回 SliderPressure 与实验性谱面类型。用户问“这图难在哪/是什么类型/某维度多难”时调用；结果不是玩家能力分析，也不是官方星数。`,
      parameters: {
        type: 'object',
        properties: {
          beatmap_id: { type: 'integer', minimum: 1, description: 'osu! beatmap ID（BID），不是 beatmapset ID' },
          mods: {
            type: 'array',
            items: { type: 'string', enum: ['NM', 'NF', 'EZ', 'HD', 'HR', 'SD', 'HT', 'DT', 'NC', 'PF', 'DC'] },
            maxItems: 4,
            uniqueItems: true,
            description: '要分析的 Mod 列表；不填表示 NM。PF/SD/NF 会保留但不改变谱面需求分值；FL 暂不支持。只传用户明确指定的 Mod。',
          },
        },
        required: ['beatmap_id'],
      },
    },
  };
}

export async function executeSkillProfilerAnalysis(
  toolCallId: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const analysis = await requestSkillProfilerAnalysis(
      Number(args.beatmap_id),
      Array.isArray(args.mods) ? args.mods.map((mod) => String(mod)) : [],
    );
    return {
      toolCallId,
      ok: true,
      content: formatSkillProfilerAnalysis(analysis),
      metadata: {
        requestedCapability: 'beatmap_skill_profile',
        actualExecutor: 'osu_skill_profiler_v040',
        dataSource: 'local_osu_manifest',
        renderer: 'none',
        command: SKILL_PROFILER_TOOL_NAME,
        success: true,
      },
    };
  } catch (error: any) {
    const message = String(error?.message || error).slice(0, 500);
    return {
      toolCallId,
      ok: false,
      content: `Skill Profiler 分析失败：${message}`,
      error: message,
      metadata: {
        requestedCapability: 'beatmap_skill_profile',
        actualExecutor: 'osu_skill_profiler_v040',
        dataSource: 'local_osu_manifest',
        renderer: 'none',
        command: SKILL_PROFILER_TOOL_NAME,
        success: false,
      },
    };
  }
}
