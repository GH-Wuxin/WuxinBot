// analyze-lifecycle-verify.mjs — Analyze job lifecycle contract (findings
// F04/F05/F07). Deterministic concurrency via synchronous reservation checks;
// restart recovery verified in an isolated child process. Fully offline.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createTestDataDir, cleanupTestDir, assertNotProduction } from './test-isolation.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = createTestDataDir('wuxin-analyze-lifecycle');
assertNotProduction(dataDir);

let failed = 0;
function assert(condition, label, detail = '') {
  if (condition) console.log(`PASS [${label}]`);
  else {
    console.error(`FAIL [${label}] ${detail}`);
    failed++;
  }
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  const store = await import('../server/store.ts');
  const commands = await import('../server/osu/commands.ts');

  // Pause the bot up front so accepted jobs fail fast at the execution gate
  // (§5.3) without touching the network. The eligibility re-check runs inside
  // each job's own trace, which the F04 assertions below depend on.
  store.updateDb((db) => {
    db.settings.globalPaused = true;
    db.settings.selfQq = '10000';
    db.osuBindings = db.osuBindings || {};
    for (let index = 0; index < 12; index += 1) {
      const userId = String(40000 + index);
      db.osuBindings[userId] = { id: 900 + index, username: `fixture-${index}` };
      db.groups.push({ groupId: String(5000 + index), name: `g${index}`, enabled: true, mode: 'natural', maxPerHour: 100, cooldownSec: 0 });
    }
  });

  // ── F05: dedupe + capacity are reserved synchronously, before any await ──
  const sent = [];
  const sendMessage = async (event, text) => {
    // The await here used to open an acceptance window between the capacity
    // check and the queue push; the reservation must already have happened.
    await pause(20);
    sent.push(`${event.userId}:${String(text).slice(0, 24)}`);
  };
  const submit = (index) => {
    const userId = String(40000 + index);
    return commands.handleOsuAnalyze({
      event: { type: 'group', groupId: '5000', userId, nickname: `n${index}`, text: '/w osu analyze' },
      sendMessage,
      permissions: null,
      subCommand: 'analyze',
      args: '',
      subFree: '',
      options: { bypassCooldown: true },
      db: store.readDb(),
    });
  };
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => submit(index)));
  const accepted = results.filter((result) => !/重复提交|队列已满/.test(String(result.reason))).length;
  const rejected = results.length - accepted;
  assert(accepted === 9 && rejected === 3, 'f05:capacity-respected-under-concurrency', `accepted=${accepted} rejected=${rejected}`);

  // Same-user double submit is still refused.
  const duplicate = await submit(0);
  assert(/重复提交|队列已满|分析失败/.test(String(duplicate.reason)), 'f05:same-user-dedupe-intact', String(duplicate.reason));

  // ── F04: each job runs under its own trace id, linked to its request ──
  const { listRequestTraces } = await import('../server/requestTrace.ts');
  await pause(100); // let the drained jobs settle their traces
  const traces = listRequestTraces(60);
  const jobTraces = traces.filter((trace) => String(trace?.id || '').includes(':job'));
  assert(jobTraces.length > 0, 'f04:jobs-own-trace-context', String(traces.map((trace) => trace?.id).slice(0, 4)));
  const startedEvents = jobTraces.flatMap((trace) => trace.events || []).filter((event) => event?.name === 'osu_analyze_job_started');
  assert(startedEvents.every((event) => String(event.data?.originalRequestId || '').length > 0),
    'f04:job-trace-links-original-request', JSON.stringify(startedEvents[0] || null));

  // ── F07: a persisted running flag from a dead process becomes interrupted ──
  const restartDir = path.join(os.tmpdir(), `wuxin-analyze-restart-${Date.now()}`);
  fs.mkdirSync(restartDir, { recursive: true });
  fs.writeFileSync(path.join(restartDir, 'osu-console-profiles.json'), JSON.stringify({
    '123': { analysis: { status: 'running', at: '2026-01-01T00:00:00.000Z' } },
  }), 'utf8');
  const childCode = `
    import { getStoredAnalysis } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, 'server', 'osu', 'profileStore.ts')).href)};
    process.stdout.write(JSON.stringify(getStoredAnalysis(123)));
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childCode], {
    encoding: 'utf8',
    env: { ...process.env, DATA_DIR: restartDir },
  });
  let restartedState = null;
  try { restartedState = JSON.parse(child.stdout || 'null'); } catch { /* handled below */ }
  assert(restartedState?.status === 'error' && /ANALYSIS_INTERRUPTED/.test(String(restartedState?.error)),
    'f07:stale-running-marked-interrupted', `${child.status} ${child.stdout} ${child.stderr}`.slice(0, 220));
  fs.rmSync(restartDir, { recursive: true, force: true });

  // ── F08: console profile store follows DATA_DIR, isolated per root ──
  const { setStoredProfile, getStoredProfile } = await import('../server/osu/profileStore.ts');
  setStoredProfile(456, { username: 'root-a' });
  assert(fs.existsSync(path.join(dataDir, 'osu-console-profiles.json')), 'f08:store-lives-in-data-root');
  const dirB = path.join(os.tmpdir(), `wuxin-analyze-rootb-${Date.now()}`);
  fs.mkdirSync(dirB, { recursive: true });
  process.env.DATA_DIR = dirB;
  assert(getStoredProfile(456) === null, 'f08:second-data-root-does-not-see-root-a');
  process.env.DATA_DIR = dataDir;
  assert(getStoredProfile(456)?.user?.username === 'root-a', 'f08:first-data-root-intact');
  fs.rmSync(dirB, { recursive: true, force: true });
} finally {
  cleanupTestDir(dataDir);
}

if (failed > 0) {
  console.error(`ANALYZE-LIFECYCLE-VERIFY FAILED (${failed})`);
  process.exit(1);
}
console.log('analyze lifecycle checks passed');
