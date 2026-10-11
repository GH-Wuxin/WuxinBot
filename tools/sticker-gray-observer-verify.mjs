import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-sticker-gray-observer-'));
const requestMethods = [];
const requestCounts = new Map();
let server;

function counters(eligibleReplies, modelProposals, allowed, attempts, confirmedSuccess, confirmedFailure) {
  return {
    eligibleReplies,
    modelProposals,
    noStickerDecisions: Math.max(0, eligibleReplies - modelProposals),
    invalidSelections: 0,
    modeCounts: { none: Math.max(0, eligibleReplies - modelProposals) },
    byGroup: {},
    selected: modelProposals,
    allowed,
    rejected: {},
    attempts,
    confirmedSuccess,
    acceptedUnknown: 0,
    confirmedFailure,
    unknown: 0,
  };
}

function sendPayload(res, values) {
  const [eligible, proposals, allowed, attempts, success, failure] = values;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    policy: { mode: 'live', allGroups: true, groupIds: [] },
    delivery: {
      policy: { mode: 'live', allGroups: true, groupIds: [] },
      counters: counters(eligible, proposals, allowed, attempts, success, failure),
      activeRecords: 0,
      last24h: success,
      recent24hByGroup: { fixture: success },
      recent24hBySticker: { hello: success },
      stickerOutcomes: { hello: { reserved: 0, confirmed_success: success, accepted_unknown: 0, confirmed_failure: failure, unknown: 0 } },
      rates: {},
    },
  }));
}

server = http.createServer((req, res) => {
  requestMethods.push(req.method);
  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end();
    return;
  }
  const url = new URL(req.url, 'http://127.0.0.1');
  const scenario = url.searchParams.get('scenario') || 'insufficient';
  const index = requestCounts.get(scenario) || 0;
  requestCounts.set(scenario, index + 1);

  if (scenario === 'errors' && index === 0) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'fixture unavailable' }));
    return;
  }

  if (scenario === 'sufficient') {
    const snapshots = [
      [10, 2, 1, 1, 1, 0],
      [60, 9, 5, 5, 4, 1],
      [110, 14, 9, 9, 8, 1],
    ];
    sendPayload(res, snapshots[Math.min(index, snapshots.length - 1)]);
    return;
  }

  if (scenario === 'errors') {
    sendPayload(res, index === 1 ? [10, 1, 1, 1, 1, 0] : [60, 7, 5, 5, 4, 1]);
    return;
  }

  sendPayload(res, [20, 0, 0, 0, 0, 0]);
});

function runObserver({ scenario, durationMs, outputPath }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve('tools/sticker-gray-observe.mjs')], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        STICKER_GRAY_OBSERVE_URL: `http://127.0.0.1:${server.address().port}/api/sticker-policy?scenario=${scenario}`,
        STICKER_GRAY_OBSERVE_MS: String(durationMs),
        STICKER_GRAY_OBSERVE_INTERVAL_MS: '1000',
        STICKER_GRAY_OBSERVE_TIMEOUT_MS: '1000',
        STICKER_GRAY_OBSERVE_OUTPUT: outputPath,
        WUXIN_ADMIN_PASSWORD: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill(), 8_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`observer exited ${code}:\n${stdout}\n${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(fs.readFileSync(outputPath, 'utf8')));
      } catch (error) {
        reject(error);
      }
    });
  });
}

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const sufficient = await runObserver({
    scenario: 'sufficient',
    durationMs: 2_100,
    outputPath: path.join(tempDir, 'sufficient.json'),
  });
  assert.equal(sufficient.readOnly, true);
  // The observer samples immediately, then sleeps on a wall-clock interval.
  // Depending on timer scheduling, the final sample can land just before the
  // 2.1s deadline, so both three and four samples are valid. The contract is
  // the measured window and read-only behavior, not an exact timer tick count.
  assert.ok(sufficient.sampleCount >= 3 && sufficient.sampleCount <= 4);
  assert.equal(sufficient.errorCount, 0);
  assert.equal(sufficient.window.counters.eligibleReplies, 100);
  assert.equal(sufficient.window.counters.modelProposals, 12);
  assert.equal(sufficient.window.counters.allowed, 8);
  assert.equal(sufficient.window.calibration.status, 'sufficient');
  assert.equal(sufficient.window.calibration.mustNotClaimFrequencyCalibration, false);
  assert.equal(sufficient.window.rates.proposalRatePerEligibleReply, 0.12);

  const insufficient = await runObserver({
    scenario: 'insufficient',
    durationMs: 0,
    outputPath: path.join(tempDir, 'insufficient.json'),
  });
  assert.equal(insufficient.sampleCount, 1);
  assert.equal(insufficient.window.counters.eligibleReplies, 0);
  assert.equal(insufficient.window.calibration.status, 'insufficient_evidence');
  assert.equal(insufficient.window.calibration.mustNotClaimFrequencyCalibration, true);
  assert.equal(insufficient.window.rates.proposalRatePerEligibleReply, null);

  const withApiError = await runObserver({
    scenario: 'errors',
    durationMs: 1_100,
    outputPath: path.join(tempDir, 'api-error.json'),
  });
  assert.equal(withApiError.errorCount, 1);
  assert.ok(withApiError.sampleCount >= 1);
  assert.ok(withApiError.window.counters.eligibleReplies < 100);
  assert.equal(withApiError.window.calibration.status, 'insufficient_evidence');
  assert.equal(withApiError.readOnly, true);

  assert.ok(requestMethods.length >= 6);
  assert.deepEqual([...new Set(requestMethods)], ['GET']);
  console.log(JSON.stringify({
    ok: true,
    readOnlyMethods: [...new Set(requestMethods)],
    sufficientThreshold: `${sufficient.window.counters.eligibleReplies}/100`,
    insufficientThreshold: `${insufficient.window.counters.eligibleReplies}/100`,
    intermittentApiError: `${withApiError.errorCount} error; later successful samples still measured`,
  }, null, 2));
} finally {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
}
