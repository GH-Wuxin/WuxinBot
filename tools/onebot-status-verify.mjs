// onebot-status-verify.mjs — P0-A connection observer simulation.
//
// Verifies the four-dimensional status (transport / NapCat API / QQ session /
// heartbeat), the flight recorder dump on accountOnline true->false, send
// statistics, and the hard constraint that session offline NEVER triggers a
// reconnect or any automatic recovery action.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-onebot-status-'));
process.env.DATA_DIR = tmpRoot;

let failed = 0;
let passed = 0;

function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`PASS: ${message}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

const { createConnectionStatus } = await import('../server/onebotStatus.ts');
const {
  recordSendSuccess,
  recordSendError,
  markActiveProcessing,
  recordGroupActivity,
  getConnectionAggregates,
  resetRecentGroupSample,
  setOneBotDetail,
  setOneBotConnected,
  getHealth,
} = await import('../server/health.ts');

let fakeNow = new Date('2026-08-08T10:00:00.000Z');
const dumpDir = path.join(tmpRoot, 'flight');

const status = createConnectionStatus({
  now: () => fakeNow,
  dumpDir,
  getAggregates: () => getConnectionAggregates(),
});

console.log('=== initial state ===');
{
  const s = status.snapshot();
  assertEqual(s.transportConnected, false, 'transport starts disconnected');
  assertEqual(s.apiReachable, null, 'apiReachable starts unknown');
  assertEqual(s.accountOnline, null, 'accountOnline starts unknown');
  assertEqual(s.heartbeatFresh, false, 'heartbeat starts stale');
  assertEqual(s.connected, false, 'compat connected starts false');
  assertEqual(s.reconnectCount, 0, 'reconnect count starts 0');
}

console.log('\n=== transport open ===');
{
  const s = status.markTransportOpen();
  assertEqual(s.transportConnected, true, 'WS open -> transportConnected true');
  assertEqual(s.connected, true, 'WS open with unknown account -> compat connected true');
}

console.log('\n=== heartbeat online ===');
{
  const s = status.handleHeartbeat({ online: true, good: true });
  assertEqual(s.accountOnline, true, 'heartbeat online=true -> accountOnline true');
  assertEqual(s.heartbeatFresh, true, 'fresh heartbeat -> heartbeatFresh true');
  assertEqual(s.heartbeatGood, true, 'heartbeat good=true -> heartbeatGood true');
  assertEqual(s.connected, true, 'online heartbeat keeps compat connected true');
}

console.log('\n=== get_status probing ===');
{
  let s = status.applyGetStatus({ ok: true, online: true, good: true });
  assertEqual(s.apiReachable, true, 'get_status ok -> apiReachable true');
  assertEqual(s.accountOnline, true, 'get_status online=true -> accountOnline true');

  s = status.applyGetStatus({ ok: false, error: 'mock timeout 1' });
  assertEqual(s.apiReachable, true, 'single probe failure does not flip apiReachable');

  s = status.applyGetStatus({ ok: false, error: 'mock timeout 2' });
  assertEqual(s.apiReachable, false, 'two consecutive failures -> apiReachable false');
  assertEqual(s.accountOnline, true, 'probe failure must not invent account offline');

  s = status.applyGetStatus({ ok: true, online: true, good: true });
  assertEqual(s.apiReachable, true, 'recovery probe -> apiReachable true again');
}

console.log('\n=== WS close code/reason recorded, no auto-recovery ===');
{
  const s = status.markTransportClosed(1006, 'socket hang up');
  assertEqual(s.transportConnected, false, 'WS close -> transportConnected false');
  assertEqual(s.connected, false, 'WS close -> compat connected false');
  const closeEvents = status.getEvents().filter((e) => e.kind === 'transport_close');
  assert(closeEvents.length >= 1, 'transport_close event recorded');
  assertEqual(closeEvents[closeEvents.length - 1].detail.code, 1006, 'close code recorded');
  assertEqual(closeEvents[closeEvents.length - 1].detail.reason, 'socket hang up', 'close reason recorded');
  status.markTransportOpen();
}

console.log('\n=== account online -> offline dumps flight recorder ===');
{
  const before = status.snapshot();
  const s = status.handleHeartbeat({ online: false, good: false });
  assertEqual(s.accountOnline, false, 'heartbeat online=false -> accountOnline false');
  assertEqual(s.connected, false, 'account offline -> compat connected false');
  const after = status.snapshot();
  assertEqual(after.reconnectCount, before.reconnectCount, 'account offline must NOT trigger reconnect');
  assertEqual(after.transportConnected, before.transportConnected, 'account offline must NOT close the WS transport');

  const files = fs.readdirSync(dumpDir).filter((name) => name.startsWith('onebot-flight-'));
  assert(files.length === 1, `flight dump file created (found ${files.length})`);
  const payload = JSON.parse(fs.readFileSync(path.join(dumpDir, files[0]), 'utf8'));
  assertEqual(payload.reason, 'account_offline', 'dump reason is account_offline');
  assertEqual(payload.snapshot.accountOnline, false, 'dump snapshot shows account offline');
  assert(payload.events.some((e) => e.kind === 'heartbeat' && e.detail.online === false), 'dump events contain the offline heartbeat');
  const raw = JSON.stringify(payload);
  assert(!raw.includes('"content"') && !raw.includes('groupId') && !raw.includes('nickname'), 'dump contains no chat content or group ids');
}

console.log('\n=== heartbeat stale window ===');
{
  const status2 = createConnectionStatus({
    now: () => fakeNow,
    dumpDir: path.join(tmpRoot, 'flight2'),
  });
  status2.markTransportOpen();
  status2.handleHeartbeat({ online: true, good: true });
  assertEqual(status2.snapshot().heartbeatFresh, true, 'fresh heartbeat within window');
  fakeNow = new Date(fakeNow.getTime() + 120_000);
  assertEqual(status2.snapshot().heartbeatFresh, false, 'heartbeat older than 90s -> stale');
}

console.log('\n=== only online->offline triggers dump ===');
{
  const dumpDir2 = path.join(tmpRoot, 'flight3');
  const status3 = createConnectionStatus({
    now: () => fakeNow,
    dumpDir: dumpDir2,
  });
  status3.markTransportOpen();
  status3.handleHeartbeat({ online: true, good: true });
  status3.applyGetStatus({ ok: false, error: 'e1' });
  status3.applyGetStatus({ ok: false, error: 'e2' });
  status3.markTransportClosed(1000, 'normal');
  const dumped = fs.existsSync(dumpDir2) ? fs.readdirSync(dumpDir2).length : 0;
  assertEqual(dumped, 0, 'no dump for probe failure or WS close (only account online->offline)');
}

console.log('\n=== send statistics + recentFailures reset ===');
{
  recordSendError(new Error('mock send failure 1'), 100);
  recordSendError(new Error('mock send failure 2'), 200);
  assertEqual(getHealth().sendMessage.recentFailures, 2, 'two send failures -> recentFailures 2');
  assertEqual(getHealth().sendMessage.failureCount, 2, 'failure count 2');
  recordSendSuccess(150);
  assertEqual(getHealth().sendMessage.recentFailures, 0, 'send success resets recentFailures');
  assertEqual(getHealth().sendMessage.successCount, 1, 'success count 1');
  assertEqual(getHealth().sendMessage.callCount, 3, 'call count 3');
  assertEqual(getHealth().sendMessage.totalLatencyMs, 450, 'total latency accumulated');
}

console.log('\n=== active processing / active groups aggregates ===');
{
  markActiveProcessing(1);
  markActiveProcessing(1);
  assertEqual(getConnectionAggregates().activeProcessing, 2, 'two concurrent processIncoming counted');
  markActiveProcessing(-1);
  assertEqual(getConnectionAggregates().activeProcessing, 1, 'one finished -> one remains');
  markActiveProcessing(-5);
  assertEqual(getConnectionAggregates().activeProcessing, 0, 'counter never goes negative');

  recordGroupActivity('111111');
  recordGroupActivity('222222');
  recordGroupActivity('111111');
  assertEqual(getConnectionAggregates().activeGroups, 2, 'distinct groups counted once');
  resetRecentGroupSample();
  assertEqual(getConnectionAggregates().activeGroups, 0, 'sample reset clears group window');
}

console.log('\n=== health detail sync ===');
{
  setOneBotConnected(true);
  setOneBotDetail({
    transportConnected: true,
    apiReachable: true,
    accountOnline: true,
    heartbeatFresh: true,
    heartbeatGood: true,
    reconnectCount: 3,
  });
  const h = getHealth();
  assertEqual(h.onebot.accountOnline, true, 'health carries accountOnline');
  assertEqual(h.onebot.transportConnected, true, 'health carries transportConnected');
  assertEqual(h.onebot.apiReachable, true, 'health carries apiReachable');
  assertEqual(h.onebot.heartbeatFresh, true, 'health carries heartbeatFresh');
  assertEqual(h.onebot.reconnectCount, 3, 'health carries reconnectCount');
  assertEqual(h.activeProcessing, getConnectionAggregates().activeProcessing, 'health exposes activeProcessing');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
