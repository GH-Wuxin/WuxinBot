import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-onebot-'));
process.env.DATA_DIR = testDataDir;
const port = 19877;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const { ensureStore, updateDb } = await import('../server/store.ts');
  const { sendOneBotMessage } = await import('../server/onebot.ts');
  ensureStore();
  updateDb((db) => {
    db.settings.oneBotHttpUrl = `http://127.0.0.1:${port}`;
    db.settings.oneBotAccessToken = '';
  });

  let mode = 'failed';
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(mode === 'failed'
      ? { status: 'failed', retcode: 100, message: 'mock failure' }
      : { status: 'ok', retcode: 0, data: { message_id: 1 } }));
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  try {
    let failed = false;
    try {
      await sendOneBotMessage({ type: 'group', groupId: '1', userId: '2' }, 'test');
    } catch (error) {
      failed = /retcode 100/.test(String(error?.message));
    }
    assert(failed, 'HTTP 200 with failed retcode must reject');

    mode = 'ok';
    await sendOneBotMessage({ type: 'group', groupId: '1', userId: '2' }, 'test');
    console.log('PASS: OneBot HTTP business status verification');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(testDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
