import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createTestDataDir, assertNotProduction, cleanupTestDir } from './test-isolation.mjs';

const dataDir = createTestDataDir('wuxin-sticker-api');
assertNotProduction(dataDir);
const port = 19_500 + Math.floor(Math.random() * 300);
const renderPort = 19_900 + Math.floor(Math.random() * 300);
const baseUrl = `http://127.0.0.1:${port}`;
const password = 'sticker-api-fixture-password';
const tsxCli = path.resolve('node_modules/tsx/dist/cli.mjs');
const childEnv = {
  ...process.env,
  DATA_DIR: dataDir,
  PORT: String(port),
  WUXIN_RENDER_PORT: String(renderPort),
  ADMIN_PASSWORD: password,
};
delete childEnv.WUXIN_STICKER_DELIVERY_MODE;
delete childEnv.WUXIN_STICKER_LIVE_GROUP_IDS;
const child = spawn(process.execPath, [tsxCli, 'server/index.ts'], {
  cwd: path.resolve('.'),
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

async function waitForServer() {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sticker API source server startup timeout')), 15_000);
    const onData = (chunk) => {
      if (!String(chunk).includes('server running')) return;
      clearTimeout(timer);
      resolve();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      if (/EADDRINUSE|SyntaxError|ERR_|uncaught/i.test(text)) {
        clearTimeout(timer);
        reject(new Error(text));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`sticker API source server exited early: ${code}`));
    });
  });
}

async function request(pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Wuxin-Admin-Password': password,
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

try {
  await waitForServer();
  const anonymous = await fetch(`${baseUrl}/api/sticker-debug`);
  assert.equal(anonymous.status, 401);

  const debug = await request('/api/sticker-debug');
  assert.equal(debug.status, 200);
  const debugBody = await debug.json();
  assert.equal(debugBody.ok, true);
  // 断言「API 报的条数 = 清单的真实条数」，而不是写死一个数字。
  // 写死会让每次增删表情包都误报，而这里真正要保的是两者一致。
  const manifestStickers = JSON.parse(fs.readFileSync(path.resolve('server/bot/stickers/manifest.json'), 'utf8')).stickers;
  assert.equal(debugBody.catalog.manifestCount, manifestStickers.length);
  assert.equal(debugBody.delivery.policy.mode, 'off');

  const policy = await request('/api/sticker-policy');
  assert.equal(policy.status, 200);
  const policyBody = await policy.json();
  assert.equal(policyBody.policy.mode, 'off');

  const missingAllowlist = await request('/api/sticker-policy', {
    method: 'POST',
    body: { mode: 'live', groupIds: [] },
  });
  assert.equal(missingAllowlist.status, 400);

  const allGroups = await request('/api/sticker-policy', {
    method: 'POST',
    body: { mode: 'live', allGroups: true, groupIds: [] },
  });
  assert.equal(allGroups.status, 200);
  const allGroupsBody = await allGroups.json();
  assert.equal(allGroupsBody.policy.mode, 'live');
  assert.equal(allGroupsBody.policy.allGroups, true);
  assert.deepEqual(allGroupsBody.policy.groupIds, []);

  const enabled = await request('/api/sticker-policy', {
    method: 'POST',
    body: {
      mode: 'live',
      allGroups: false,
      groupIds: ['1083681153'],
      groupCooldownSec: 600,
      userCooldownSec: 1200,
      hourlyLimit: 3,
      dailyLimit: 16,
      userDailyLimit: 4,
      duplicateStickerCooldownSec: 7200,
    },
  });
  assert.equal(enabled.status, 200);
  const enabledBody = await enabled.json();
  assert.equal(enabledBody.policy.mode, 'live');
  assert.deepEqual(enabledBody.policy.groupIds, ['1083681153']);

  const disabled = await request('/api/sticker-policy', {
    method: 'POST',
    body: { mode: 'off', groupIds: [] },
  });
  assert.equal(disabled.status, 200);
  const disabledBody = await disabled.json();
  assert.equal(disabledBody.policy.mode, 'off');

  console.log(JSON.stringify({
    ok: true,
    catalog: debugBody.catalog.manifestCount,
    auth: 'protected',
    liveAllowlist: 'validated',
    allGroups: 'explicit switch validated and reset to allowlist',
    rollback: 'off verified',
  }, null, 2));
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  cleanupTestDir(dataDir);
}
