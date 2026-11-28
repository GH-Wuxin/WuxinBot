import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createTestDataDir, assertNotProduction, cleanupTestDir } from './test-isolation.mjs';

const dataDir = createTestDataDir('wuxin-draw-group-api');
assertNotProduction(dataDir);
async function freePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}
const port = await freePort();
let renderPort = await freePort();
while (renderPort === port) renderPort = await freePort();
const password = 'draw-route-fixture';
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(path|systemroot|windir|temp|tmp|comspec|userprofile|appdata|localappdata|pathext)$/i.test(key)));
Object.assign(env, { DATA_DIR: dataDir, PORT: String(port), WUXIN_RENDER_PORT: String(renderPort), ADMIN_PASSWORD: password, WUXIN_PRODUCTION_DATA_DIR: process.env.WUXIN_PRODUCTION_DATA_DIR });
let child;
async function start() {
  child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  await new Promise((resolve, reject) => {
    let stderr = '', stdout = '';
    const timer = setTimeout(() => fail(new Error('start timeout: ' + stderr.slice(-1500))), 20_000);
    function fail(error) { clearTimeout(timer); reject(error); }
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('server running')) { clearTimeout(timer); resolve(); }
    });
    child.once('error', fail);
    child.once('exit', (status) => fail(new Error('exit ' + status + ': ' + stderr.slice(-1500))));
  });
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const stopped = once(child, 'exit');
  child.kill();
  await stopped;
}
async function check(url, method, body, status, auth = true) {
  const response = await fetch('http://127.0.0.1:' + port + url, {
    method, headers: { 'Content-Type': 'application/json', ...(auth ? { 'X-Wuxin-Admin-Password': password } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const result = await response.json();
  assert.equal(response.status, status, method + ' ' + url + ': ' + JSON.stringify(result).slice(0,400));
  return result;
}
const pathA = '/api/groups/9001/draw';
const draw = async (groupId) => (await check('/api/state','GET',undefined,200)).db.groups.find((group) => String(group.groupId) === groupId)?.pippiDrawEnabled;
try {
  await start();
  for (const groupId of ['9001','9002']) await check('/api/groups','POST',{groupId,name:groupId,mode:'mention'},200);
  assert.notEqual(await draw('9001'),true);
  await check(pathA,'PATCH',{pippiDrawEnabled:true},401,false);
  await check(pathA,'PATCH',{pippiDrawEnabled:'true'},400);
  await check('/api/groups/9876/draw','PATCH',{pippiDrawEnabled:true},404);
  await check(pathA,'PATCH',{pippiDrawEnabled:true},200);
  assert.equal(await draw('9001'),true);
  assert.notEqual(await draw('9002'),true);
  await check('/api/groups','POST',{groupId:'9001',name:'renamed',mode:'light'},200);
  assert.equal(await draw('9001'),true);
  await stop();
  await start();
  assert.equal(await draw('9001'),true);
  await check(pathA,'PATCH',{pippiDrawEnabled:false},200);
  assert.equal(await draw('9001'),false);
  console.log('Draw group HTTP: admin auth, strict boolean, 404, group isolation, legacy save, restart persistence and turning off passed.');
} finally {
  await stop();
  cleanupTestDir(dataDir);
}
