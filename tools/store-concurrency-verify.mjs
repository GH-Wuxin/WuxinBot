import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-store-lock-'));
process.env.DATA_DIR = dataDir;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const worker = path.join(root, 'tools', 'store-concurrency-worker.mjs');
const workerCount = 4;
const loops = 30;

function runWorker() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, worker, String(loops)], {
      cwd: root,
      env: { ...process.env, DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr || `worker exit ${code}`)));
  });
}

try {
  const { ensureStore, readDb } = await import('../server/store.ts');
  ensureStore();
  await Promise.all(Array.from({ length: workerCount }, runWorker));
  const db = readDb();
  const expected = workerCount * loops;
  if (db.concurrencyVerifyCount !== expected) {
    throw new Error(`并发写入丢失：期望 ${expected}，实际 ${db.concurrencyVerifyCount}`);
  }
  const leftovers = fs.readdirSync(dataDir).filter((name) => name === 'db.lock' || name.endsWith('.tmp'));
  if (leftovers.length) throw new Error(`遗留数据库临时文件：${leftovers.join(', ')}`);
  console.log(`PASS store concurrency: ${expected} atomic updates across ${workerCount} processes`);
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
