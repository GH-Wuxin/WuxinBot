#!/usr/bin/env node
// WUXINBOT_REWRITE_TELEMETRY_ANALYZER_V01
// Read-only analyzer for rewriteNormalReply telemetry.
//
// Usage:
//   node --import tsx tools/rewrite-telemetry-analyze.mjs [--since 7d] [--since 24h] [--from ISO] [--to ISO] [--output dir]
//
// Reads db.json (read-only), filters kind='rewrite-reply' events, computes
// metrics, outputs report.json + report.md.
// No network. No LLM. No DB mutation.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── CLI args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--') && i + 1 < args.length) {
    flags[args[i].slice(2)] = args[++i];
  }
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIR = flags.output || path.join(REPO_ROOT, 'tmp', 'rewrite_telemetry_report_v01');

// ── DB loading (read-only) ────────────────────────────────────────────────

function getDbPath() {
  const dataDir = process.env.DATA_DIR || path.join(
    process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:', 'AppData', 'Roaming'),
    'Wuxin'
  );
  return path.join(dataDir, 'db.json');
}

function loadDb() {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    return { _missing: true, usageEvents: [] };
  }
  try {
    const raw = fs.readFileSync(dbPath, 'utf8').replace(/^\uFEFF/, '');
    const db = JSON.parse(raw);
    db.usageEvents = Array.isArray(db.usageEvents) ? db.usageEvents : [];
    return db;
  } catch (error) {
    return { _corrupt: true, _error: error.message, usageEvents: [] };
  }
}

// ── Time window parsing ───────────────────────────────────────────────────

function parseSinceWindow(since) {
  const match = String(since || '').match(/^(\d+)\s*(m|h|d|w)$/i);
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  const ms = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit];
  return ms ? Date.now() - n * ms : null;
}

function parseISO(val) {
  if (!val) return null;
  const t = Date.parse(val);
  return Number.isFinite(t) ? t : null;
}

function getTimeWindow() {
  let since = null;
  let from = null;
  let to = null;
  if (flags.since) {
    since = parseSinceWindow(flags.since);
    if (since === null) {
      console.error(`ERROR: invalid --since value: "${flags.since}". Use e.g. 24h, 7d, 30m.`);
      process.exit(1);
    }
  }
  if (flags.from) {
    from = parseISO(flags.from);
    if (from === null) {
      console.error(`ERROR: invalid --from value: "${flags.from}". Use ISO 8601.`);
      process.exit(1);
    }
  }
  if (flags.to) {
    to = parseISO(flags.to);
    if (to === null) {
      console.error(`ERROR: invalid --to value: "${flags.to}". Use ISO 8601.`);
      process.exit(1);
    }
  }
  return { since, from, to };
}

// ── Filtering ─────────────────────────────────────────────────────────────

function filterRewriteEvents(db, window) {
  const hasWindow = window.since !== null || window.from !== null || window.to !== null;
  const events = (db.usageEvents || []).filter((e) => e && e.kind === 'rewrite-reply');
  return events.filter((e) => {
    if (!e.createdAt) return !hasWindow; // include only when no explicit window; unknowable membership
    const ts = Date.parse(e.createdAt);
    if (!Number.isFinite(ts)) return !hasWindow;
    if (window.since && ts < window.since) return false;
    if (window.from && ts < window.from) return false;
    if (window.to && ts > window.to) return false;
    return true;
  });
}

// ── Percentile helper ─────────────────────────────────────────────────────

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  const frac = idx - lower;
  return sorted[lower] * (1 - frac) + sorted[upper] * frac;
}

function safeStats(values, allowNegative = false) {
  const valid = values.filter((v) => typeof v === 'number' && Number.isFinite(v) && (allowNegative || v >= 0));
  if (valid.length === 0) return { count: 0, total: 0, mean: null, p50: null, p90: null, p95: null, max: null };
  valid.sort((a, b) => a - b);
  const total = valid.reduce((s, v) => s + v, 0);
  return {
    count: valid.length,
    total: round(total),
    mean: round(total / valid.length),
    p50: round(percentile(valid, 50)),
    p90: round(percentile(valid, 90)),
    p95: round(percentile(valid, 95)),
    max: round(valid[valid.length - 1]),
  };
}

function round(v) {
  if (v === null || v === undefined) return null;
  return Math.round(v * 100) / 100;
}

function pct(num, den) {
  if (!den || den <= 0) return null;
  return round((num / den) * 100);
}

// ── Result classification ─────────────────────────────────────────────────

const KNOWN_RESULTS = ['SKIPPED', 'UNCHANGED', 'CHANGED', 'ERROR_FALLBACK', 'EMPTY_FALLBACK', 'TIMEOUT_FALLBACK', 'OTHER_FALLBACK'];

function classifyResult(e) {
  const r = e.result;
  if (KNOWN_RESULTS.includes(r)) return r;
  return 'UNKNOWN_RESULT';
}

function isFallback(r) {
  return ['ERROR_FALLBACK', 'EMPTY_FALLBACK', 'TIMEOUT_FALLBACK', 'OTHER_FALLBACK'].includes(r);
}

// ── Data quality ──────────────────────────────────────────────────────────

function analyzeDataQuality(events) {
  const dq = {
    total_records_seen: events.length,
    valid_records: 0,
    malformed_records: 0,
    unknown_result_records: 0,
    missing_created_at: 0,
    missing_usage: 0,
    invalid_negative_tokens: 0,
    invalid_negative_latency: 0,
    invalid_char_counts: 0,
  };

  for (const e of events) {
    if (!e || typeof e !== 'object') { dq.malformed_records++; continue; }
    if (typeof e.kind !== 'string') { dq.malformed_records++; continue; }
    if (!e.createdAt) dq.missing_created_at++;
    if (typeof e.result !== 'string') { dq.malformed_records++; continue; }
    if (!KNOWN_RESULTS.includes(e.result)) dq.unknown_result_records++;
    if (!e.usageAvailable && e.inputTokens == null && e.outputTokens == null) dq.missing_usage++;
    if (e.inputTokens != null && e.inputTokens < 0) dq.invalid_negative_tokens++;
    if (e.outputTokens != null && e.outputTokens < 0) dq.invalid_negative_tokens++;
    if (e.cachedInputTokens != null && e.cachedInputTokens < 0) dq.invalid_negative_tokens++;
    if (e.latencyMs != null && e.latencyMs < 0) dq.invalid_negative_latency++;
    if (e.originalChars < 0 || e.rewrittenChars < 0) dq.invalid_char_counts++;
    dq.valid_records++;
  }

  return dq;
}

// ── Core analysis ─────────────────────────────────────────────────────────

function analyze(events) {
  const total = events.length;

  // Counts
  const eligible = events.filter((e) => e.eligible).length;
  const notEligible = total - eligible;
  const invoked = events.filter((e) => e.invoked).length;
  const notInvoked = total - invoked;

  // Result distribution
  const resultCounts = {};
  for (const r of KNOWN_RESULTS) resultCounts[r] = 0;
  resultCounts.UNKNOWN_RESULT = 0;
  for (const e of events) resultCounts[classifyResult(e)]++;

  // Core rates
  const eligibilityRate = pct(eligible, total);
  const invocationRateOverall = pct(invoked, total);
  const invocationRateGivenEligible = pct(invoked, eligible);
  const changeRateOverall = pct(resultCounts.CHANGED, total);
  const changeRateGivenInvoked = pct(resultCounts.CHANGED, invoked);
  const unchangedRateGivenInvoked = pct(resultCounts.UNCHANGED, invoked);
  const fallbackCount = isFallback('ERROR_FALLBACK') ? resultCounts.ERROR_FALLBACK + resultCounts.EMPTY_FALLBACK + resultCounts.TIMEOUT_FALLBACK + resultCounts.OTHER_FALLBACK : 0;
  const fallbackRateGivenInvoked = pct(
    resultCounts.ERROR_FALLBACK + resultCounts.EMPTY_FALLBACK + resultCounts.TIMEOUT_FALLBACK + resultCounts.OTHER_FALLBACK,
    invoked
  );

  // Skip reason analysis
  const skippedEvents = events.filter((e) => !e.eligible || !e.invoked);
  const skipReasonMap = {};
  for (const e of skippedEvents) {
    const reason = e.skipReason || 'UNSPECIFIED';
    skipReasonMap[reason] = (skipReasonMap[reason] || 0) + 1;
  }
  const skipReasons = Object.entries(skipReasonMap)
    .map(([reason, count]) => ({
      skip_reason: reason,
      count,
      percentage_of_skipped: pct(count, skippedEvents.length),
      percentage_of_all_events: pct(count, total),
    }))
    .sort((a, b) => b.count - a.count);

  // Usage / token analysis (invoked only, usageAvailable=true)
  const invokedWithUsage = events.filter((e) => e.invoked && e.usageAvailable);
  const inputTokens = invokedWithUsage.map((e) => e.inputTokens).filter((v) => v != null && v >= 0);
  const outputTokens = invokedWithUsage.map((e) => e.outputTokens).filter((v) => v != null && v >= 0);
  const cachedTokens = invokedWithUsage.map((e) => e.cachedInputTokens).filter((v) => v != null && v >= 0);

  const usageStats = {
    usage_available_count: invokedWithUsage.length,
    usage_missing_count: invoked - invokedWithUsage.length,
    input_tokens: safeStats(inputTokens),
    output_tokens: safeStats(outputTokens),
    cached_input_tokens: safeStats(cachedTokens),
  };

  // Total known tokens (conservative: input + output, NOT adding cached which is a subset)
  const totalKnownTokens = (usageStats.input_tokens.total || 0) + (usageStats.output_tokens.total || 0);
  const meanKnownTokensPerInvocation = invoked > 0 ? round(totalKnownTokens / invoked) : null;

  // Latency analysis
  const allInvoked = events.filter((e) => e.invoked);
  const latencyAll = safeStats(allInvoked.map((e) => e.latencyMs));
  const latencyChanged = safeStats(allInvoked.filter((e) => classifyResult(e) === 'CHANGED').map((e) => e.latencyMs));
  const latencyUnchanged = safeStats(allInvoked.filter((e) => classifyResult(e) === 'UNCHANGED').map((e) => e.latencyMs));
  const latencyFallback = safeStats(
    allInvoked.filter((e) => isFallback(classifyResult(e))).map((e) => e.latencyMs)
  );

  // Character-length impact
  const invokedWithChars = events.filter((e) => e.invoked && typeof e.originalChars === 'number' && typeof e.rewrittenChars === 'number');
  const deltas = invokedWithChars.map((e) => e.rewrittenChars - e.originalChars);
  const changedOnly = invokedWithChars.filter((e) => classifyResult(e) === 'CHANGED');
  const unchangedOnly = invokedWithChars.filter((e) => classifyResult(e) === 'UNCHANGED');
  const changedDeltas = changedOnly.map((e) => e.rewrittenChars - e.originalChars);
  const unchangedDeltas = unchangedOnly.map((e) => e.rewrittenChars - e.originalChars);

  const charImpact = {
    total_with_char_data: invokedWithChars.length,
    delta_chars: safeStats(deltas, true),
    changed_only_delta: safeStats(changedDeltas, true),
    unchanged_only_delta: safeStats(unchangedDeltas, true),
    expansion_rate: pct(deltas.filter((d) => d > 0).length, deltas.length),
    shrink_rate: pct(deltas.filter((d) => d < 0).length, deltas.length),
    same_length_rate: pct(deltas.filter((d) => d === 0).length, deltas.length),
  };

  // Provider/model breakdown
  const providerMap = {};
  for (const e of events) {
    const key = `${e.provider || 'unknown'}|${e.model || 'unknown'}`;
    if (!providerMap[key]) providerMap[key] = { provider: e.provider || 'unknown', model: e.model || 'unknown', events: 0, invoked: 0, changed: 0, fallback: 0, usage_available: 0, latencies: [], inputTokens: [], outputTokens: [], cachedTokens: [] };
    const bucket = providerMap[key];
    bucket.events++;
    if (e.invoked) bucket.invoked++;
    if (classifyResult(e) === 'CHANGED') bucket.changed++;
    if (isFallback(classifyResult(e))) bucket.fallback++;
    if (e.usageAvailable) bucket.usage_available++;
    if (typeof e.latencyMs === 'number' && Number.isFinite(e.latencyMs) && e.latencyMs >= 0) bucket.latencies.push(e.latencyMs);
    if (e.inputTokens != null && e.inputTokens >= 0) bucket.inputTokens.push(e.inputTokens);
    if (e.outputTokens != null && e.outputTokens >= 0) bucket.outputTokens.push(e.outputTokens);
    if (e.cachedInputTokens != null && e.cachedInputTokens >= 0) bucket.cachedTokens.push(e.cachedInputTokens);
  }
  const providerBreakdown = Object.values(providerMap)
    .map((b) => {
      b.latencies.sort((a, c) => a - c);
      return {
        provider: b.provider,
        model: b.model,
        events: b.events,
        invoked: b.invoked,
        changed: b.changed,
        fallback: b.fallback,
        usage_available: b.usage_available,
        latency_p50: round(percentile(b.latencies, 50)),
        latency_p95: round(percentile(b.latencies, 95)),
        input_tokens_total: b.inputTokens.reduce((s, v) => s + v, 0),
        output_tokens_total: b.outputTokens.reduce((s, v) => s + v, 0),
        cached_tokens_total: b.cachedTokens.reduce((s, v) => s + v, 0),
      };
    })
    .sort((a, b) => b.events - a.events || a.provider.localeCompare(b.provider));

  return {
    counts: { total_events: total, eligible, not_eligible: notEligible, invoked, not_invoked: notInvoked },
    result_distribution: resultCounts,
    core_rates: {
      eligibility_rate: eligibilityRate,
      invocation_rate_overall: invocationRateOverall,
      invocation_rate_given_eligible: invocationRateGivenEligible,
      change_rate_overall: changeRateOverall,
      change_rate_given_invoked: changeRateGivenInvoked,
      unchanged_rate_given_invoked: unchangedRateGivenInvoked,
      fallback_rate_given_invoked: fallbackRateGivenInvoked,
    },
    skip_reasons: skipReasons,
    usage: usageStats,
    total_known_tokens: totalKnownTokens,
    mean_known_tokens_per_invocation: meanKnownTokensPerInvocation,
    latency: {
      all_invoked: latencyAll,
      changed: latencyChanged,
      unchanged: latencyUnchanged,
      fallback: latencyFallback,
    },
    char_impact: charImpact,
    provider_breakdown: providerBreakdown,
  };
}

// ── Trend buckets (optional, day-level) ──────────────────────────────────

function buildDayTrend(events) {
  const buckets = {};
  for (const e of events) {
    if (!e.createdAt) continue;
    const d = new Date(e.createdAt);
    if (!Number.isFinite(d.getTime())) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!buckets[key]) buckets[key] = { bucket_start: key, events: 0, eligible: 0, invoked: 0, changed: 0, fallback: 0, latencies: [], known_tokens: 0 };
    const b = buckets[key];
    b.events++;
    if (e.eligible) b.eligible++;
    if (e.invoked) b.invoked++;
    if (classifyResult(e) === 'CHANGED') b.changed++;
    if (isFallback(classifyResult(e))) b.fallback++;
    if (typeof e.latencyMs === 'number' && Number.isFinite(e.latencyMs) && e.latencyMs >= 0) b.latencies.push(e.latencyMs);
    if (e.inputTokens != null && e.inputTokens >= 0) b.known_tokens += e.inputTokens;
    if (e.outputTokens != null && e.outputTokens >= 0) b.known_tokens += e.outputTokens;
  }
  return Object.values(buckets)
    .sort((a, b) => a.bucket_start.localeCompare(b.bucket_start))
    .map((b) => ({
      bucket_start: b.bucket_start,
      events: b.events,
      eligible: b.eligible,
      invoked: b.invoked,
      changed: b.changed,
      fallback: b.fallback,
      latency_p50: round(percentile(b.latencies.sort((a, c) => a - c), 50)),
      known_tokens: b.known_tokens,
    }));
}

// ── Markdown generation ───────────────────────────────────────────────────

function fmtPct(v) { return v === null ? 'N/A' : `${v}%`; }
function fmtNum(v) { return v === null ? 'N/A' : String(v); }
function fmtSmallN(v, n) { return v === null ? 'N/A' : (n < 5 ? `${v} (SMALL_N=${n})` : String(v)); }

function generateMarkdown(report) {
  const { window: win, event_count, data_quality: dq, analysis: a } = report;
  const lines = [];
  lines.push('# Rewrite Telemetry Analysis Report');
  lines.push('');
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Window: ${win.since_label || 'all time'}${win.from ? ` from ${win.from}` : ''}${win.to ? ` to ${win.to}` : ''}`);
  lines.push('');

  if (report.status === 'NO_DATA') {
    lines.push('**No rewrite-reply telemetry is available in the selected window.**');
    lines.push('Analyzer is ready; deploy/traffic data is required before evaluating rewrite effectiveness.');
    lines.push('');
    lines.push(`Data quality: ${dq.total_records_seen} records seen, ${dq.valid_records} valid.`);
    return lines.join('\n');
  }

  // Summary
  lines.push('## Summary');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Total events | ${event_count} |`);
  lines.push(`| Eligible | ${a.counts.eligible} (${fmtPct(a.core_rates.eligibility_rate)}) |`);
  lines.push(`| Invoked | ${a.counts.invoked} (${fmtPct(a.core_rates.invocation_rate_overall)}) |`);
  lines.push(`| CHANGED | ${a.result_distribution.CHANGED} (${fmtPct(a.core_rates.change_rate_given_invoked)} of invoked) |`);
  lines.push(`| UNCHANGED | ${a.result_distribution.UNCHANGED} (${fmtPct(a.core_rates.unchanged_rate_given_invoked)} of invoked) |`);
  lines.push(`| Fallbacks (all) | ${a.result_distribution.ERROR_FALLBACK + a.result_distribution.EMPTY_FALLBACK + a.result_distribution.TIMEOUT_FALLBACK + a.result_distribution.OTHER_FALLBACK} (${fmtPct(a.core_rates.fallback_rate_given_invoked)} of invoked) |`);
  lines.push('');

  // Result distribution
  lines.push('## Result Distribution');
  lines.push('');
  lines.push(`| Result | Count |`);
  lines.push(`|---|---|`);
  for (const r of [...KNOWN_RESULTS, 'UNKNOWN_RESULT']) {
    if (a.result_distribution[r] > 0) lines.push(`| ${r} | ${a.result_distribution[r]} |`);
  }
  lines.push('');

  // Skip reasons
  if (a.skip_reasons.length > 0) {
    lines.push('## Skip Reasons');
    lines.push('');
    lines.push(`| Reason | Count | % of Skipped | % of All |`);
    lines.push(`|---|---|---|---|`);
    for (const s of a.skip_reasons) {
      lines.push(`| ${s.skip_reason} | ${s.count} | ${fmtPct(s.percentage_of_skipped)} | ${fmtPct(s.percentage_of_all_events)} |`);
    }
    lines.push('');
  }

  // Usage
  lines.push('## Token Usage (invoked + usageAvailable)');
  lines.push('');
  lines.push(`Usage available: ${a.usage.usage_available_count}, missing: ${a.usage.usage_missing_count}`);
  lines.push('');
  lines.push(`| Token Type | Total | Mean | P50 | P90 | P95 | Max |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  const printTokenRow = (label, s) => {
    lines.push(`| ${label} | ${fmtNum(s.total)} | ${fmtNum(s.mean)} | ${fmtNum(s.p50)} | ${fmtNum(s.p90)} | ${fmtNum(s.p95)} | ${fmtNum(s.max)} |`);
  };
  printTokenRow('Input', a.usage.input_tokens);
  printTokenRow('Output', a.usage.output_tokens);
  printTokenRow('Cached Input', a.usage.cached_input_tokens);
  lines.push('');
  lines.push(`Total known tokens (input+output): ${fmtNum(a.total_known_tokens)}`);
  lines.push(`Mean known tokens per invocation: ${fmtNum(a.mean_known_tokens_per_invocation)}`);
  lines.push('');

  // Latency
  lines.push('## Latency (ms)');
  lines.push('');
  lines.push(`| Category | Count | Mean | P50 | P90 | P95 | Max |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  const printLatRow = (label, s) => {
    const smallN = s.count > 0 && s.count < 5;
    lines.push(`| ${label} | ${s.count} | ${fmtSmallN(s.mean, s.count)} | ${fmtSmallN(s.p50, s.count)} | ${fmtSmallN(s.p90, s.count)} | ${fmtSmallN(s.p95, s.count)} | ${fmtSmallN(s.max, s.count)} |`);
  };
  printLatRow('All invoked', a.latency.all_invoked);
  printLatRow('CHANGED', a.latency.changed);
  printLatRow('UNCHANGED', a.latency.unchanged);
  printLatRow('Fallback', a.latency.fallback);
  lines.push('');

  // Character impact
  lines.push('## Character-Length Impact');
  lines.push('');
  lines.push(`Events with char data: ${a.char_impact.total_with_char_data}`);
  lines.push('');
  lines.push(`| Metric | Count | Mean | P50 | P90 | P95 | Max |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  printLatRow('Delta (rewritten - original)', a.char_impact.delta_chars);
  printLatRow('CHANGED only delta', a.char_impact.changed_only_delta);
  printLatRow('UNCHANGED only delta', a.char_impact.unchanged_only_delta);
  lines.push('');
  lines.push(`Expansion rate (delta > 0): ${fmtPct(a.char_impact.expansion_rate)}`);
  lines.push(`Shrink rate (delta < 0): ${fmtPct(a.char_impact.shrink_rate)}`);
  lines.push(`Same length rate (delta = 0): ${fmtPct(a.char_impact.same_length_rate)}`);
  lines.push('');
  lines.push('**Note:** Character count changes do not equal semantic changes or token savings.');
  lines.push('');

  // Provider/model
  if (a.provider_breakdown.length > 0) {
    lines.push('## Provider/Model Breakdown');
    lines.push('');
    lines.push(`| Provider | Model | Events | Invoked | Changed | Fallback | Usage Avail | Lat P50 | Lat P95 | Input Tok | Output Tok | Cached Tok |`);
    lines.push(`|---|---|---|---|---|---|---|---|---|---|---|---|`);
    for (const p of a.provider_breakdown) {
      lines.push(`| ${p.provider} | ${p.model} | ${p.events} | ${p.invoked} | ${p.changed} | ${p.fallback} | ${p.usage_available} | ${fmtNum(p.latency_p50)} | ${fmtNum(p.latency_p95)} | ${p.input_tokens_total} | ${p.output_tokens_total} | ${p.cached_tokens_total} |`);
    }
    lines.push('');
  }

  // Day trend
  if (report.day_trend && report.day_trend.length > 0) {
    lines.push('## Daily Trend');
    lines.push('');
    lines.push(`| Day | Events | Eligible | Invoked | Changed | Fallback | Lat P50 | Tokens |`);
    lines.push(`|---|---|---|---|---|---|---|---|`);
    for (const d of report.day_trend) {
      lines.push(`| ${d.bucket_start} | ${d.events} | ${d.eligible} | ${d.invoked} | ${d.changed} | ${d.fallback} | ${fmtNum(d.latency_p50)} | ${d.known_tokens} |`);
    }
    lines.push('');
  }

  // Data quality
  lines.push('## Data Quality');
  lines.push('');
  lines.push(`| Metric | Count |`);
  lines.push(`|---|---|`);
  lines.push(`| Total records seen | ${dq.total_records_seen} |`);
  lines.push(`| Valid records | ${dq.valid_records} |`);
  lines.push(`| Malformed records | ${dq.malformed_records} |`);
  lines.push(`| Unknown result | ${dq.unknown_result_records} |`);
  lines.push(`| Missing createdAt | ${dq.missing_created_at} |`);
  lines.push(`| Missing usage | ${dq.missing_usage} |`);
  lines.push(`| Invalid negative tokens | ${dq.invalid_negative_tokens} |`);
  lines.push(`| Invalid negative latency | ${dq.invalid_negative_latency} |`);
  lines.push(`| Invalid char counts | ${dq.invalid_char_counts} |`);
  lines.push('');

  // Interpretation limits
  lines.push('## Interpretation Limits');
  lines.push('');
  lines.push('This tool computes metrics only. It does not evaluate whether rewriteNormalReply');
  lines.push('should be kept, conditionalized, or removed.');
  lines.push('');
  lines.push('Decision requires product review.');
  lines.push('');

  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────

function main() {
  const db = loadDb();
  const window = getTimeWindow();
  const windowLabel = flags.since
    ? flags.since
    : (flags.from || flags.to)
      ? `${flags.from || '...'} — ${flags.to || '...'}`
      : 'all time';

  if (db._missing) {
    console.error(`WARNING: DB not found at ${getDbPath()}`);
  } else if (db._corrupt) {
    console.error(`WARNING: DB is corrupt: ${db._error}`);
  }

  const allRewriteEvents = (db.usageEvents || []).filter((e) => e && e.kind === 'rewrite-reply');
  const filteredEvents = filterRewriteEvents(db, window);

  const dataQuality = analyzeDataQuality(allRewriteEvents);

  let report;
  if (filteredEvents.length === 0) {
    report = {
      status: 'NO_DATA',
      generated_at: new Date().toISOString(),
      window: { since_label: windowLabel, from: flags.from || null, to: flags.to || null },
      event_count: 0,
      data_quality: dataQuality,
      analysis: null,
      day_trend: [],
    };
  } else {
    const analysis = analyze(filteredEvents);
    const dayTrend = buildDayTrend(filteredEvents);
    report = {
      status: 'OK',
      generated_at: new Date().toISOString(),
      window: { since_label: windowLabel, from: flags.from || null, to: flags.to || null },
      event_count: filteredEvents.length,
      total_rewrite_events_in_db: allRewriteEvents.length,
      data_quality: dataQuality,
      analysis,
      day_trend: dayTrend,
    };
  }

  // Write outputs
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const jsonPath = path.join(OUTPUT_DIR, 'report.json');
  const mdPath = path.join(OUTPUT_DIR, 'report.md');

  // Strict JSON: no NaN/Infinity
  const jsonStr = JSON.stringify(report, (_key, value) => {
    if (typeof value === 'number' && (!Number.isFinite(value) || Number.isNaN(value))) return null;
    return value;
  }, 2);

  fs.writeFileSync(jsonPath, jsonStr, 'utf8');
  fs.writeFileSync(mdPath, generateMarkdown(report), 'utf8');

  console.log(`Report written to:`);
  console.log(`  JSON: ${jsonPath}`);
  console.log(`  MD:   ${mdPath}`);
  console.log(`Status: ${report.status}, events: ${report.event_count}`);
}

main();
