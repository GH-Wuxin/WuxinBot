/**
 * Read-only observer for the authorized sticker gray rollout.
 *
 * This tool is deliberately limited to GET /api/sticker-policy. It never
 * changes policy, sends QQ messages, replays history, or invokes an LLM.
 * The output contains bounded counters and rates only; it does not copy chat
 * text or model prompts.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const endpoint = String(process.env.STICKER_GRAY_OBSERVE_URL || 'http://127.0.0.1:8787/api/sticker-policy').trim();
const durationMs = Math.max(0, Number(process.env.STICKER_GRAY_OBSERVE_MS || 0) || 0);
const intervalMs = Math.max(1_000, Number(process.env.STICKER_GRAY_OBSERVE_INTERVAL_MS || 30_000) || 30_000);
const requestTimeoutMs = Math.max(1_000, Number(process.env.STICKER_GRAY_OBSERVE_TIMEOUT_MS || 5_000) || 5_000);
const MIN_ELIGIBLE_REPLIES_FOR_CALIBRATION = 100;
const defaultOutput = path.join(
  'docs',
  'sticker-release',
  'evidence',
  `gray-observation-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}.json`,
);
const outputPath = path.resolve(process.env.STICKER_GRAY_OBSERVE_OUTPUT || defaultOutput);

const COUNTER_KEYS = [
  'eligibleReplies',
  'modelProposals',
  'noStickerDecisions',
  'invalidSelections',
  'selected',
  'allowed',
  'attempts',
  'confirmedSuccess',
  'acceptedUnknown',
  'confirmedFailure',
  'unknown',
];

function numberValue(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function compactCounters(counters = {}) {
  return Object.fromEntries(COUNTER_KEYS.map((key) => [key, numberValue(counters[key])]));
}

function compactPayload(payload) {
  const delivery = payload?.delivery && typeof payload.delivery === 'object' ? payload.delivery : {};
  return {
    observedAt: new Date().toISOString(),
    policy: payload?.policy ?? delivery.policy ?? null,
    counters: compactCounters(delivery.counters),
    activeRecords: numberValue(delivery.activeRecords),
    last24h: numberValue(delivery.last24h),
    recent24hByGroup: delivery.recent24hByGroup && typeof delivery.recent24hByGroup === 'object'
      ? delivery.recent24hByGroup
      : {},
    recent24hBySticker: delivery.recent24hBySticker && typeof delivery.recent24hBySticker === 'object'
      ? delivery.recent24hBySticker
      : {},
    stickerOutcomes: delivery.stickerOutcomes && typeof delivery.stickerOutcomes === 'object'
      ? delivery.stickerOutcomes
      : {},
    rates: delivery.rates && typeof delivery.rates === 'object' ? delivery.rates : {},
  };
}

async function fetchSnapshot() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const headers = {};
    if (process.env.WUXIN_ADMIN_PASSWORD) headers['x-wuxin-admin-password'] = process.env.WUXIN_ADMIN_PASSWORD;
    const response = await fetch(endpoint, { method: 'GET', headers, signal: controller.signal });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`observer endpoint returned non-JSON HTTP ${response.status}`);
    }
    if (!response.ok || payload?.ok === false) {
      throw new Error(`observer endpoint returned HTTP ${response.status}`);
    }
    return compactPayload(payload);
  } finally {
    clearTimeout(timeout);
  }
}

function diffCounters(first, last) {
  return Object.fromEntries(COUNTER_KEYS.map((key) => [key, numberValue(last?.[key]) - numberValue(first?.[key])]));
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function deriveWindow(first, last) {
  const delta = diffCounters(first?.counters, last?.counters);
  const calibration = {
    status: delta.eligibleReplies >= MIN_ELIGIBLE_REPLIES_FOR_CALIBRATION ? 'sufficient' : 'insufficient_evidence',
    eligibleReplies: delta.eligibleReplies,
    minimumEligibleReplies: MIN_ELIGIBLE_REPLIES_FOR_CALIBRATION,
    mustNotClaimFrequencyCalibration: delta.eligibleReplies < MIN_ELIGIBLE_REPLIES_FOR_CALIBRATION,
  };
  return {
    counters: delta,
    calibration,
    rates: {
      proposalRatePerEligibleReply: ratio(delta.modelProposals, delta.eligibleReplies),
      allowedRatePerEligibleReply: ratio(delta.allowed, delta.eligibleReplies),
      confirmedSuccessRatePerAttempt: ratio(delta.confirmedSuccess, delta.attempts),
      confirmedFailureRatePerAttempt: ratio(delta.confirmedFailure, delta.attempts),
      uncertainRatePerAttempt: ratio(delta.acceptedUnknown + delta.unknown, delta.attempts),
    },
    latestRecent24hByGroup: last?.recent24hByGroup || {},
    latestRecent24hBySticker: last?.recent24hBySticker || {},
    latestStickerOutcomes: last?.stickerOutcomes || {},
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const startedAt = new Date().toISOString();
const samples = [];
const errors = [];
const deadline = Date.now() + durationMs;

do {
  try {
    samples.push(await fetchSnapshot());
  } catch (error) {
    errors.push({ at: new Date().toISOString(), error: String(error?.message || error) });
  }
  if (durationMs <= 0 || Date.now() >= deadline) break;
  await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
} while (Date.now() <= deadline);

const first = samples[0] || null;
const last = samples.at(-1) || null;
const report = {
  schemaVersion: 1,
  readOnly: true,
  endpoint,
  startedAt,
  finishedAt: new Date().toISOString(),
  requestedDurationMs: durationMs,
  intervalMs,
  requestTimeoutMs,
  sampleCount: samples.length,
  errorCount: errors.length,
  policyAtStart: first?.policy || null,
  policyAtEnd: last?.policy || null,
  samples,
  window: first && last ? deriveWindow(first, last) : null,
  errors,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

if (errors.length > 0 && samples.length === 0) {
  console.error(`gray observation failed: ${errors[0].error}`);
  process.exitCode = 1;
} else {
  const window = report.window;
  console.log(JSON.stringify({
    ok: true,
    readOnly: true,
    outputPath,
    sampleCount: samples.length,
    errorCount: errors.length,
    policy: report.policyAtEnd,
    window: window ? {
      eligibleReplies: window.counters.eligibleReplies,
      modelProposals: window.counters.modelProposals,
      allowed: window.counters.allowed,
      attempts: window.counters.attempts,
      confirmedSuccess: window.counters.confirmedSuccess,
      confirmedFailure: window.counters.confirmedFailure,
      acceptedUnknown: window.counters.acceptedUnknown,
      unknown: window.counters.unknown,
      calibration: window.calibration,
      rates: window.rates,
    } : null,
  }, null, 2));
}
