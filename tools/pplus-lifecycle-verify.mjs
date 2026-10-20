import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-pplus-'));
Object.assign(process.env, { DATA_DIR: dataDir, NODE_ENV: 'test', PPLUS_REQUEST_TIMEOUT_MS: '100', PPLUS_JOB_TIMEOUT_MS: '450', PPLUS_POLL_INTERVAL_MS: '10' });
const performance = { pp: 1234, ppJumpAim: 1000, ppFlowAim: 900, ppSpeed: 800, ppStamina: 700, ppPrecision: 600, ppAcc: 500 };
let authCalls = 0;
let starts = 0;
let polls = 0;
let expireOnce = false;
let lostOnce = false;
const started = new Map();
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('content-type', 'application/json');
  const send = (code, data) => res.end(JSON.stringify({ code, data }));
  if (url.pathname === '/auth/token') {
    authCalls++;
    return send(url.searchParams.get('clientSecret') === 'correct' ? 200 : 401, 'fixture-token');
  }
  const id = Number(url.searchParams.get('id'));
  if (url.pathname === '/player/jobs') {
    assert.equal(req.method, 'POST');
    starts++;
    if (!started.has(id)) started.set(id, Date.now());
    return send(200, { id, status: 'queued' });
  }
  if (url.pathname === '/player/jobs/status') {
    polls++;
    if (expireOnce) { expireOnce = false; return send(401, null); }
    if (lostOnce) { lostOnce = false; return send(404, null); }
    if (id === 4) return send(200, { id, status: 'failed', errorCode: 'NO_SCORES' });
    if (id === 5) return send(200, { id, status: 'failed', errorCode: 'CALCULATION_FAILED' });
    if (id === 6) return send(200, { id, status: 'completed', result: { performances: { pp: 10 } } });
    if (id === 7) return send(200, { id, status: 'running' });
    if (id === 9) {
      res.write('{"code":200,"data":');
      const timer = setTimeout(() => res.end('null}'), 300);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    const status = Date.now() - started.get(id) < 130 ? 'running' : 'completed';
    return send(200, { id, status, result: status === 'completed' ? { id, performances: performance } : null });
  }
  assert.fail('Unexpected legacy info/update request: ' + url.pathname);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const { readDb, updateDb } = await import('../server/store.ts');
  const base = `http://127.0.0.1:${server.address().port}`;
  updateDb(db => Object.assign(db.settings, { pplusBaseUrl: base, pplusClientId: 1, pplusClientSecret: 'correct' }));
  const { getPlayerBars } = await import('../server/osu/pplus.ts');
  const bars = await Promise.all(Array.from({ length: 5 }, () => getPlayerBars(1)));
  assert.equal(starts, 1, 'same player starts one shared job');
  assert.equal(authCalls, 1, 'authentication is shared');
  assert.ok(polls > 1, 'cold initialization survives several short requests');
  assert.ok(bars.every(row => row.ppTotal === 1234 && row.accuracy > 0));
  assert.ok(readDb().settings.pplusBarsCache['1'].bars.jump > 0, 'successful result is persisted');
  const beforeCache = starts;
  await getPlayerBars(1);
  assert.equal(starts, beforeCache);
  const child = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    "const {getPlayerBars}=await import('./server/osu/pplus.ts'); console.log(JSON.stringify(await getPlayerBars(1)));"],
    { cwd: path.resolve(import.meta.dirname, '..'), env: process.env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(JSON.parse(child.trim()).ppTotal, 1234, 'cache survives a fresh Node process without HTTP');
  assert.equal(starts, beforeCache);

  updateDb(db => { db.settings.pplusClientSecret = 'wrong'; });
  await assert.rejects(getPlayerBars(2), { code: 'AUTH' });
  assert.equal(starts, beforeCache, 'invalid credentials must never start a player calculation');
  updateDb(db => { db.settings.pplusClientSecret = 'correct'; });
  expireOnce = true;
  assert.equal((await getPlayerBars(3)).ppTotal, 1234, 'business 401 reauthenticates once');
  assert.equal(await getPlayerBars(4), null, 'no scores is distinct from service failure');
  await assert.rejects(getPlayerBars(5), { code: 'UNAVAILABLE' });
  await assert.rejects(getPlayerBars(6), { code: 'INVALID_RESPONSE' });
  await assert.rejects(getPlayerBars(7), { code: 'TIMEOUT' });
  lostOnce = true;
  const beforeRestart = starts;
  assert.equal((await getPlayerBars(8)).ppTotal, 1234);
  assert.equal(starts - beforeRestart, 2, 'lost server job is restarted once');
  await assert.rejects(getPlayerBars(9), { code: 'TIMEOUT' }, 'response body has a deadline');
  assert.equal(readDb().settings.pplusBarsCache['6'], undefined, 'malformed result is not cached');
  console.log('PASS: cold jobs, deduplication, persistent cache, credential changes, business 401, errors, lost jobs and body timeout');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
