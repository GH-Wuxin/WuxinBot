import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-security-'));
const port = 19000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const password = 'security-verify-password';
process.env.DATA_DIR = dataDir;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForServer(child) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('security test server startup timeout')), 10_000);
    const onData = (chunk) => {
      if (!String(chunk).includes('server running')) return;
      clearTimeout(timer);
      resolve();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      if (/EADDRINUSE|SyntaxError|ERR_/.test(text)) {
        clearTimeout(timer);
        reject(new Error(text));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`security test server exited early: ${code}`));
    });
  });
}

async function request(pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
}

async function main() {
  const { ensureStore, updateDb } = await import('../server/store.ts');
  const { createBackup } = await import('../server/backup.ts');
  ensureStore();
  updateDb((db) => { db.settings.adminPassword = password; });

  let traversalRejected = false;
  try { createBackup('../escape'); } catch { traversalRejected = true; }
  assert(traversalRejected, 'backup traversal type must be rejected');
  assert(!fs.existsSync(path.join(dataDir, 'escape')), 'backup traversal must not create an outside file');

  const tsxCli = path.resolve('node_modules/tsx/dist/cli.mjs');
  const child = spawn(process.execPath, [tsxCli, 'server/index.ts'], {
    cwd: path.resolve('.'),
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(child);

    const anonymous = await request('/api/state');
    assert(anonymous.status === 401, 'anonymous API request must be rejected');

    const wrong = await request('/api/state', { headers: { 'X-Wuxin-Admin-Password': 'wrong' } });
    assert(wrong.status === 401, 'wrong admin password must be rejected');

    const authHeaders = { 'X-Wuxin-Admin-Password': password };
    const authorized = await request('/api/state', { headers: authHeaders });
    assert(authorized.status === 200, 'correct admin password must be accepted');
    const state = await authorized.json();
    assert(state.db.settings.adminPassword === '已设置', 'admin password must remain masked');

    const invalidGroup = await request('/api/groups', {
      method: 'POST',
      headers: authHeaders,
      body: { groupId: '', enabled: true }
    });
    assert(invalidGroup.status === 400, 'empty group id must be rejected');

    const invalidBackup = await request('/api/backups', {
      method: 'POST',
      headers: authHeaders,
      body: { type: '../../outside' }
    });
    assert(invalidBackup.status === 400, 'backup traversal request must be rejected');

    const manualBackup = await request('/api/backups', {
      method: 'POST',
      headers: authHeaders,
      body: { type: 'manual' }
    });
    assert(manualBackup.status === 200, 'manual backup must still work');
    assert(fs.readdirSync(path.join(dataDir, 'backups')).some((name) => /^manual-.*\.json$/.test(name)), 'manual backup must stay inside backups');

    console.log('PASS security: auth, input validation and backup path confinement');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

main()
  .finally(() => {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
