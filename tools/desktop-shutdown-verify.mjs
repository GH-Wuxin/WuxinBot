import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ProcessManager, buildDefaultDefinitions } from '../desktop/process-manager.mjs';
import { createTestDataDir, cleanupTestDir } from './test-isolation.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

test('Desktop restores live pause state and drains its backend before releasing the instance lock', { timeout: 40000 }, async () => {
  const dir = createTestDataDir('wuxin-desktop-shutdown');
  const { updateDb } = await import('../server/store.ts');
  let child;
  try {
    updateDb(db => Object.assign(db.settings, { adminPassword: '', oneBotWsUrl: '', oneBotHttpUrl: '',
      presenceEnabled: false, socialV2Enabled: false, pippiActivityEnabled: false }));
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    const def = buildDefaultDefinitions(projectRoot).find(service => service.id === 'wuxin');
    const manager = new ProcessManager({
      projectRoot, configDir: path.join(dir, 'desktop'), buildDefinitions: () => [{
        ...def, port: null, command: process.execPath,
        env: { DATA_DIR: dir, PORT: String(port), WUXIN_RENDER_PORT: '0', ADMIN_PASSWORD: '' },
      }],
      runtime: {
        listProcesses: async () => [], listListeners: async () => [], probePort: async () => false,
        spawn: (...args) => (child = spawn(...args)),
      },
    });
    manager.killPid = async () => { throw new Error('Graceful stop fell through to forced termination'); };
    await manager.initialize();
    await manager.start('wuxin');
    assert.ok(child.connected);
    async function api(route, body) {
      const response = await fetch('http://127.0.0.1:' + port + '/api/' + route, body === undefined ? {} : {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.ok(response.ok, route + ' returned ' + response.status);
      return response.json();
    }
    const deadline = Date.now() + 18000;
    while (true) {
      try { await api('health'); break; } catch (error) {
        if (child.exitCode !== null || Date.now() >= deadline) throw error;
        await delay(100);
      }
    }
    const lock = path.join(dir, 'server-instance.lock');
    assert.ok(fs.existsSync(lock));
    await api('settings', { globalPaused: true });
    const backup = (await api('backups', { type: 'manual' })).backup;
    await api('settings', { globalPaused: false });
    const snapshot = (await api('config-snapshots')).snapshots.at(-1);
    await api('config-snapshots/' + snapshot.index + '/restore', {});
    assert.equal((await api('health')).bot.globalPaused, true);
    await api('settings', { globalPaused: false });
    await api('backups/' + encodeURIComponent(backup.name) + '/restore', {});
    assert.equal((await api('health')).bot.globalPaused, true);
    const closed = once(child, 'close');
    assert.equal((await manager.stop('wuxin')).stopped, true);
    assert.deepEqual(await closed, [0, null]);
    assert.ok(!fs.existsSync(lock));
    assert.equal((await manager.stop('wuxin')).notManaged, true);
  } finally {
    if (child && child.exitCode === null && !child.signalCode) {
      const closed = once(child, 'close');
      child.kill();
      await closed;
    }
    cleanupTestDir(dir);
  }
});
