import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-usage-stats-'));
process.env.DATA_DIR = dataDir;

try {
  const { ensureStore, publicDb, readDb, writeDb } = await import('../server/store.ts');
  ensureStore();
  const db = readDb();
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12);
  const old = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 8, 12);
  db.usageEvents = [
    { createdAt: now.toISOString(), totalTokens: 100, promptTokens: 80, completionTokens: 20 },
    { createdAt: yesterday.toISOString(), totalTokens: 200, promptTokens: 150, completionTokens: 50 },
    { createdAt: old.toISOString(), totalTokens: 300, promptTokens: 250, completionTokens: 50 }
  ];
  writeDb(db);

  const stats = publicDb(readDb()).usageStats;
  if (stats.today.totalTokens !== 100 || stats.today.promptTokens !== 80 || stats.today.requests !== 1) {
    throw new Error('今日 Token 聚合错误');
  }
  if (stats.hourly24.length !== 24 || stats.daily7.length !== 7) throw new Error('趋势桶数量错误');
  const dailyTotal = stats.daily7.reduce((sum, item) => sum + item.totalTokens, 0);
  if (dailyTotal !== 300) throw new Error(`近 7 天聚合错误：${dailyTotal}`);
  if (stats.daily7.some((item, index, list) => index > 0 && item.start <= list[index - 1].start)) {
    throw new Error('趋势桶时间顺序错误');
  }
  console.log('PASS usage stats: today, hourly24 and daily7 aggregation');
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
