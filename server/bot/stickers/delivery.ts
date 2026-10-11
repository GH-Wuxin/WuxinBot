import crypto from 'node:crypto';
import { readDb, updateDb } from '../../store.js';
import { pickForModel } from './index.js';

export type StickerDeliveryMode = 'dry-run' | 'live' | 'off';
export type StickerDeliveryOutcome =
  | 'confirmed_success'
  | 'accepted_unknown'
  | 'confirmed_failure'
  | 'unknown';

export type StickerDeliveryRejectReason =
  | 'mode'
  | 'private'
  | 'group'
  | 'unknown_sticker'
  | 'cooldown'
  | 'user_cooldown'
  | 'hourly_limit'
  | 'daily_limit'
  | 'user_daily_limit'
  | 'duplicate'
  | 'duplicate_turn';

export interface StickerDeliveryRequest {
  eventType?: unknown;
  groupId?: unknown;
  userId?: unknown;
  messageId?: unknown;
  stickerId: string;
}

export interface StickerDeliveryReservation {
  ok: boolean;
  reason?: StickerDeliveryRejectReason;
  reservationId?: string;
  stickerId?: string;
  path?: string;
}

export interface StickerDeliveryPolicy {
  mode: StickerDeliveryMode;
  allGroups: boolean;
  groupIds: string[];
  groupCooldownMs: number;
  userCooldownMs: number;
  hourlyLimit: number;
  dailyLimit: number;
  userDailyLimit: number;
  duplicateStickerCooldownMs: number;
}

export interface StickerDeliveryRecord {
  reservationId: string;
  at: number;
  outcome: 'reserved' | StickerDeliveryOutcome;
  groupId: string;
  userId: string;
  messageId: string;
  stickerId: string;
  outcomeAt?: number;
}

export interface StickerGroupDecisionCounters {
  eligibleReplies: number;
  modelProposals: number;
  noStickerDecisions: number;
  invalidSelections: number;
  modeCounts: Record<string, number>;
}

export interface StickerDeliveryCounters {
  eligibleReplies: number;
  modelProposals: number;
  noStickerDecisions: number;
  invalidSelections: number;
  modeCounts: Record<string, number>;
  byGroup: Record<string, StickerGroupDecisionCounters>;
  selected: number;
  allowed: number;
  rejected: Record<string, number>;
  attempts: number;
  confirmedSuccess: number;
  acceptedUnknown: number;
  confirmedFailure: number;
  unknown: number;
}

export interface StickerDeliveryState {
  records: StickerDeliveryRecord[];
  counters: StickerDeliveryCounters;
}

export interface StickerDeliveryDbLike {
  settings?: Record<string, unknown>;
  stickerDeliveryState?: unknown;
}

export interface StickerDeliveryOptions {
  /** Plain test store injection; production uses the existing store lock. */
  db?: StickerDeliveryDbLike;
  /** Injectable clock for deterministic cooldown and window tests. */
  nowMs?: number;
}

const DEFAULT_GROUP_COOLDOWN_MS = 10 * 60_000;
const DEFAULT_USER_COOLDOWN_MS = 20 * 60_000;
const DEFAULT_HOURLY_LIMIT = 3;
const DEFAULT_DAILY_LIMIT = 16;
const DEFAULT_USER_DAILY_LIMIT = 4;
const DEFAULT_DUPLICATE_STICKER_COOLDOWN_MS = 2 * 60 * 60_000;
const MAX_RECORD_AGE_MS = 8 * 24 * 60 * 60_000;
const MAX_RECORDS = 2_048;
const MAX_GROUP_DECISION_ENTRIES = 256;
const MAX_METRIC_KEY_LENGTH = 80;
const DEFAULT_POLICY: StickerDeliveryPolicy = {
  mode: 'off',
  allGroups: false,
  groupIds: [],
  groupCooldownMs: DEFAULT_GROUP_COOLDOWN_MS,
  userCooldownMs: DEFAULT_USER_COOLDOWN_MS,
  hourlyLimit: DEFAULT_HOURLY_LIMIT,
  dailyLimit: DEFAULT_DAILY_LIMIT,
  userDailyLimit: DEFAULT_USER_DAILY_LIMIT,
  duplicateStickerCooldownMs: DEFAULT_DUPLICATE_STICKER_COOLDOWN_MS,
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function envValue(name: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(process.env, name)) return undefined;
  return String(process.env[name] || '').trim();
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function boundedLimit(value: unknown, fallback: number, max: number): number {
  return boundedNumber(value, fallback, 0, max);
}

function parseMode(value: unknown, fallback: StickerDeliveryMode): StickerDeliveryMode {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'off' || normalized === 'dry-run' || normalized === 'live'
    ? normalized
    : fallback;
}

function parseGroupIds(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : String(value || '').split(/[\s,]+/u);
  return [...new Set(values.map((id) => String(id || '').trim()).filter(Boolean))].slice(0, 256);
}

function parseBoolean(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function persistedPolicy(db: StickerDeliveryDbLike): Record<string, unknown> {
  return objectValue(objectValue(db.settings).stickerPolicy);
}

export function stickerDeliveryConfig(db: StickerDeliveryDbLike = readDb()): StickerDeliveryPolicy {
  const saved = persistedPolicy(db);
  const mode = parseMode(envValue('WUXIN_STICKER_DELIVERY_MODE') ?? saved.mode, DEFAULT_POLICY.mode);
  const allGroups = parseBoolean(envValue('WUXIN_STICKER_ALL_GROUPS') ?? saved.allGroups, DEFAULT_POLICY.allGroups);
  const groupIds = parseGroupIds(envValue('WUXIN_STICKER_LIVE_GROUP_IDS') ?? saved.groupIds);
  const groupCooldownMs = boundedNumber(
    envValue('WUXIN_STICKER_COOLDOWN_MS') ?? (Number(saved.groupCooldownSec) * 1000),
    DEFAULT_POLICY.groupCooldownMs,
    0,
    24 * 60 * 60_000,
  );
  const userCooldownMs = boundedNumber(
    envValue('WUXIN_STICKER_USER_COOLDOWN_MS') ?? (Number(saved.userCooldownSec) * 1000),
    DEFAULT_POLICY.userCooldownMs,
    0,
    7 * 24 * 60 * 60_000,
  );
  const hourlyLimit = boundedLimit(
    envValue('WUXIN_STICKER_HOURLY_LIMIT') ?? saved.hourlyLimit,
    DEFAULT_POLICY.hourlyLimit,
    10_000,
  );
  const dailyLimit = boundedLimit(
    envValue('WUXIN_STICKER_DAILY_LIMIT') ?? saved.dailyLimit,
    DEFAULT_POLICY.dailyLimit,
    100_000,
  );
  const userDailyLimit = boundedLimit(
    envValue('WUXIN_STICKER_USER_DAILY_LIMIT') ?? saved.userDailyLimit,
    DEFAULT_POLICY.userDailyLimit,
    100_000,
  );
  const duplicateStickerCooldownMs = boundedNumber(
    envValue('WUXIN_STICKER_DUPLICATE_WINDOW_MS') ?? (Number(saved.duplicateStickerCooldownSec) * 1000),
    DEFAULT_POLICY.duplicateStickerCooldownMs,
    0,
    30 * 24 * 60 * 60_000,
  );
  return {
    mode,
    allGroups,
    groupIds,
    groupCooldownMs,
    userCooldownMs,
    hourlyLimit,
    dailyLimit,
    userDailyLimit,
    duplicateStickerCooldownMs,
  };
}

function emptyCounters(): StickerDeliveryCounters {
  return {
    eligibleReplies: 0,
    modelProposals: 0,
    noStickerDecisions: 0,
    invalidSelections: 0,
    modeCounts: {},
    byGroup: {},
    selected: 0,
    allowed: 0,
    rejected: {},
    attempts: 0,
    confirmedSuccess: 0,
    acceptedUnknown: 0,
    confirmedFailure: 0,
    unknown: 0,
  };
}

function emptyGroupDecisionCounters(): StickerGroupDecisionCounters {
  return {
    eligibleReplies: 0,
    modelProposals: 0,
    noStickerDecisions: 0,
    invalidSelections: 0,
    modeCounts: {},
  };
}

function normalizeModeCounts(value: unknown): Record<string, number> {
  return Object.fromEntries(Object.entries(objectValue(value)).slice(0, 8).map(([key, count]) => [
    key.slice(0, 40), boundedLimit(count, 0, Number.MAX_SAFE_INTEGER),
  ]));
}

function normalizeGroupDecisionCounters(value: unknown): StickerGroupDecisionCounters {
  const counters = objectValue(value);
  return {
    eligibleReplies: boundedLimit(counters.eligibleReplies, 0, Number.MAX_SAFE_INTEGER),
    modelProposals: boundedLimit(counters.modelProposals, 0, Number.MAX_SAFE_INTEGER),
    noStickerDecisions: boundedLimit(counters.noStickerDecisions, 0, Number.MAX_SAFE_INTEGER),
    invalidSelections: boundedLimit(counters.invalidSelections, 0, Number.MAX_SAFE_INTEGER),
    modeCounts: normalizeModeCounts(counters.modeCounts),
  };
}

function normalizeOutcome(value: unknown): StickerDeliveryRecord['outcome'] | null {
  if (value === 'reserved' || value === 'confirmed_success' || value === 'accepted_unknown'
    || value === 'confirmed_failure' || value === 'unknown') return value;
  return null;
}

function normalizeState(value: unknown): StickerDeliveryState {
  const raw = objectValue(value);
  const rawRecords = Array.isArray(raw.records) ? raw.records : [];
  const records = rawRecords.map((item) => {
    const record = objectValue(item);
    const outcome = normalizeOutcome(record.outcome);
    const at = Number(record.at);
    if (!outcome || !Number.isFinite(at)) return null;
    return {
      reservationId: String(record.reservationId || '').trim(),
      at,
      outcome,
      groupId: String(record.groupId || '').trim(),
      userId: String(record.userId || '').trim(),
      messageId: String(record.messageId || '').trim(),
      stickerId: String(record.stickerId || '').trim(),
      ...(Number.isFinite(Number(record.outcomeAt)) ? { outcomeAt: Number(record.outcomeAt) } : {}),
    } satisfies StickerDeliveryRecord;
  }).filter((record): record is StickerDeliveryRecord => Boolean(
    record && record.reservationId && record.groupId && record.stickerId,
  ));
  const counters = objectValue(raw.counters);
  const rejected = objectValue(counters.rejected);
  return {
    records: records.slice(-MAX_RECORDS),
    counters: {
      eligibleReplies: boundedLimit(counters.eligibleReplies, 0, Number.MAX_SAFE_INTEGER),
      modelProposals: boundedLimit(counters.modelProposals, 0, Number.MAX_SAFE_INTEGER),
      noStickerDecisions: boundedLimit(counters.noStickerDecisions, 0, Number.MAX_SAFE_INTEGER),
      invalidSelections: boundedLimit(counters.invalidSelections, 0, Number.MAX_SAFE_INTEGER),
      modeCounts: normalizeModeCounts(counters.modeCounts),
      byGroup: Object.fromEntries(Object.entries(objectValue(counters.byGroup))
        .slice(0, MAX_GROUP_DECISION_ENTRIES)
        .map(([groupId, groupCounters]) => [
          groupId.slice(0, MAX_METRIC_KEY_LENGTH), normalizeGroupDecisionCounters(groupCounters),
        ])),
      selected: boundedLimit(counters.selected, 0, Number.MAX_SAFE_INTEGER),
      allowed: boundedLimit(counters.allowed, 0, Number.MAX_SAFE_INTEGER),
      rejected: Object.fromEntries(Object.entries(rejected).map(([key, count]) => [
        key.slice(0, 80), boundedLimit(count, 0, Number.MAX_SAFE_INTEGER),
      ])),
      attempts: boundedLimit(counters.attempts, 0, Number.MAX_SAFE_INTEGER),
      confirmedSuccess: boundedLimit(counters.confirmedSuccess, 0, Number.MAX_SAFE_INTEGER),
      acceptedUnknown: boundedLimit(counters.acceptedUnknown, 0, Number.MAX_SAFE_INTEGER),
      confirmedFailure: boundedLimit(counters.confirmedFailure, 0, Number.MAX_SAFE_INTEGER),
      unknown: boundedLimit(counters.unknown, 0, Number.MAX_SAFE_INTEGER),
    },
  };
}

export function recordStickerDecisionInDb(
  db: StickerDeliveryDbLike,
  input: {
    mode: 'none' | 'text_image' | 'image_only';
    stickerId?: unknown;
    validSelection?: boolean;
    groupId?: unknown;
  },
  nowMs = Date.now(),
): void {
  const state = pruneState(normalizeState(db.stickerDeliveryState), nowMs);
  const selected = Boolean(String(input.stickerId || '').trim());
  const updateCounters = (counters: StickerGroupDecisionCounters) => {
    counters.eligibleReplies += 1;
    counters.modeCounts[input.mode] = (counters.modeCounts[input.mode] || 0) + 1;
    if (selected) {
      counters.modelProposals += 1;
      if (input.validSelection === false) counters.invalidSelections += 1;
    } else {
      counters.noStickerDecisions += 1;
    }
  };
  updateCounters(state.counters);
  const groupId = String(input.groupId || '').trim().slice(0, MAX_METRIC_KEY_LENGTH);
  if (groupId) {
    if (!Object.prototype.hasOwnProperty.call(state.counters.byGroup, groupId)) {
      const entries = Object.keys(state.counters.byGroup);
      if (entries.length >= MAX_GROUP_DECISION_ENTRIES) delete state.counters.byGroup[entries[0]];
      state.counters.byGroup[groupId] = emptyGroupDecisionCounters();
    }
    updateCounters(state.counters.byGroup[groupId]);
  }
  db.stickerDeliveryState = state;
}

function pruneState(state: StickerDeliveryState, nowMs: number): StickerDeliveryState {
  const cutoff = nowMs - MAX_RECORD_AGE_MS;
  state.records = state.records.filter((record) => record.at >= cutoff).slice(-MAX_RECORDS);
  return state;
}

function isBudgetRecord(record: StickerDeliveryRecord): boolean {
  return record.outcome !== 'confirmed_failure';
}

function isWithinWindow(recordAt: number, nowMs: number, windowMs: number): boolean {
  const ageMs = nowMs - recordAt;
  return ageMs >= 0 && ageMs < windowMs;
}

function sameUser(record: StickerDeliveryRecord, groupId: string, userId: string): boolean {
  return record.groupId === groupId && record.userId === userId;
}

function countSince(records: StickerDeliveryRecord[], predicate: (record: StickerDeliveryRecord) => boolean, cutoff: number): number {
  return records.filter((record) => record.at >= cutoff && isBudgetRecord(record) && predicate(record)).length;
}

function reject(
  state: StickerDeliveryState,
  reason: StickerDeliveryRejectReason,
): StickerDeliveryReservation {
  state.counters.rejected[reason] = (state.counters.rejected[reason] || 0) + 1;
  return { ok: false, reason };
}

function reserveInDb(
  db: StickerDeliveryDbLike,
  input: StickerDeliveryRequest,
  nowMs: number,
): StickerDeliveryReservation {
  const config = stickerDeliveryConfig(db);
  const state = pruneState(normalizeState(db.stickerDeliveryState), nowMs);
  db.stickerDeliveryState = state;

  if (config.mode !== 'live') return reject(state, 'mode');
  if (String(input.eventType || '') !== 'group') return reject(state, 'private');

  const groupId = String(input.groupId || '').trim();
  const userId = String(input.userId || '').trim() || 'unknown';
  const messageId = String(input.messageId || '').trim();
  if (!groupId || (!config.allGroups && !config.groupIds.includes(groupId))) return reject(state, 'group');

  const picked = pickForModel(String(input.stickerId || '').trim());
  if (!picked) return reject(state, 'unknown_sticker');
  state.counters.selected += 1;

  if (messageId && state.records.some((record) => record.groupId === groupId
    && record.messageId === messageId && isBudgetRecord(record))) {
    return reject(state, 'duplicate_turn');
  }

  const latestGroup = state.records
    .filter((record) => record.groupId === groupId && isBudgetRecord(record))
    .sort((a, b) => b.at - a.at)[0];
  const repeatedStickerInWindow = state.records.some((record) => record.groupId === groupId
    && isBudgetRecord(record)
    && record.stickerId === picked.id
    && isWithinWindow(record.at, nowMs, config.duplicateStickerCooldownMs));
  if (repeatedStickerInWindow) {
    return reject(state, 'duplicate');
  }
  if (latestGroup && isWithinWindow(latestGroup.at, nowMs, config.groupCooldownMs)) {
    return reject(state, 'cooldown');
  }

  const latestUser = state.records
    .filter((record) => sameUser(record, groupId, userId) && isBudgetRecord(record))
    .sort((a, b) => b.at - a.at)[0];
  if (latestUser && isWithinWindow(latestUser.at, nowMs, config.userCooldownMs)) {
    return reject(state, 'user_cooldown');
  }

  const groupHourCount = countSince(state.records, (record) => record.groupId === groupId, nowMs - 60 * 60_000);
  if (config.hourlyLimit <= groupHourCount) return reject(state, 'hourly_limit');
  const groupDayCount = countSince(state.records, (record) => record.groupId === groupId, nowMs - 24 * 60 * 60_000);
  if (config.dailyLimit <= groupDayCount) return reject(state, 'daily_limit');
  const userDayCount = countSince(
    state.records,
    (record) => sameUser(record, groupId, userId),
    nowMs - 24 * 60 * 60_000,
  );
  if (config.userDailyLimit <= userDayCount) return reject(state, 'user_daily_limit');

  const reservationId = crypto.randomUUID();
  state.records.push({
    reservationId,
    at: nowMs,
    outcome: 'reserved',
    groupId,
    userId,
    messageId,
    stickerId: picked.id,
  });
  state.counters.allowed += 1;
  db.stickerDeliveryState = pruneState(state, nowMs);
  return { ok: true, reservationId, stickerId: picked.id, path: picked.path };
}

function mutateDb<T>(options: StickerDeliveryOptions, mutator: (db: StickerDeliveryDbLike) => T): T {
  if (options.db) return mutator(options.db);
  let result!: T;
  updateDb((db) => {
    result = mutator(db as StickerDeliveryDbLike);
  });
  return result;
}

/** Atomically reserve one model-selected sticker using the existing store lock. */
export function reserveStickerDelivery(
  input: StickerDeliveryRequest,
  options: StickerDeliveryOptions = {},
): StickerDeliveryReservation {
  return mutateDb(options, (db) => reserveInDb(db, input, options.nowMs ?? Date.now()));
}

function recordOutcomeInDb(
  db: StickerDeliveryDbLike,
  reservationId: string,
  outcome: StickerDeliveryOutcome,
  nowMs: number,
): boolean {
  const state = pruneState(normalizeState(db.stickerDeliveryState), nowMs);
  const record = state.records.find((item) => item.reservationId === reservationId);
  if (!record) return false;
  if (record.outcome !== 'reserved') return record.outcome === outcome;
  record.outcome = outcome;
  record.outcomeAt = nowMs;
  state.counters.attempts += 1;
  if (outcome === 'confirmed_success') state.counters.confirmedSuccess += 1;
  else if (outcome === 'accepted_unknown') state.counters.acceptedUnknown += 1;
  else if (outcome === 'confirmed_failure') state.counters.confirmedFailure += 1;
  else state.counters.unknown += 1;
  db.stickerDeliveryState = state;
  return true;
}

/** Finalize a reservation after the existing OneBot sender reports its outcome. */
export function completeStickerDelivery(
  reservationId: string,
  outcome: StickerDeliveryOutcome,
  options: StickerDeliveryOptions = {},
): boolean {
  const id = String(reservationId || '').trim();
  if (!id) return false;
  return mutateDb(options, (db) => recordOutcomeInDb(db, id, outcome, options.nowMs ?? Date.now()));
}

export function getStickerDeliveryState(options: StickerDeliveryOptions = {}): StickerDeliveryState {
  const db = options.db || readDb();
  return normalizeState(db.stickerDeliveryState);
}

export function getStickerDeliveryStats(options: StickerDeliveryOptions = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const db = options.db || readDb();
  const state = pruneState(normalizeState(db.stickerDeliveryState), nowMs);
  const config = stickerDeliveryConfig(db);
  const recentCutoff = nowMs - 24 * 60 * 60_000;
  const recentRecords = state.records.filter((record) => record.at >= recentCutoff);
  const recentBudgetRecords = recentRecords.filter(isBudgetRecord);
  const recentByGroup = new Map<string, number>();
  const recentBySticker = new Map<string, number>();
  const stickerOutcomes = new Map<string, Record<StickerDeliveryRecord['outcome'], number>>();
  for (const record of recentRecords) {
    if (isBudgetRecord(record)) recentByGroup.set(record.groupId, (recentByGroup.get(record.groupId) || 0) + 1);
    if (isBudgetRecord(record)) recentBySticker.set(record.stickerId, (recentBySticker.get(record.stickerId) || 0) + 1);
    const outcomes = stickerOutcomes.get(record.stickerId) || {
      reserved: 0,
      confirmed_success: 0,
      accepted_unknown: 0,
      confirmed_failure: 0,
      unknown: 0,
    };
    outcomes[record.outcome] += 1;
    stickerOutcomes.set(record.stickerId, outcomes);
  }
  const eligibleReplies = state.counters.eligibleReplies;
  const rate = (count: number) => eligibleReplies > 0 ? count / eligibleReplies : 0;
  return {
    policy: config,
    counters: structuredClone(state.counters),
    activeRecords: state.records.filter(isBudgetRecord).length,
    last24h: recentBudgetRecords.length,
    recent24hByGroup: Object.fromEntries(recentByGroup),
    recent24hBySticker: Object.fromEntries(recentBySticker),
    stickerOutcomes: Object.fromEntries(stickerOutcomes),
    rates: {
      proposalRate: rate(state.counters.modelProposals),
      allowedRate: rate(state.counters.allowed),
      confirmedSuccessRate: rate(state.counters.confirmedSuccess),
    },
  };
}

/** Test seam; requires an injected store so it cannot erase production state accidentally. */
export function clearStickerDeliveryState(options: StickerDeliveryOptions): void {
  if (!options.db) throw new Error('clearStickerDeliveryState requires an injected test store');
  options.db.stickerDeliveryState = { records: [], counters: emptyCounters() } satisfies StickerDeliveryState;
}

