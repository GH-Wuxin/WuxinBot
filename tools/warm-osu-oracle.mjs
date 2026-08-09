// warm-osu-oracle.mjs — pre-download .osu files for bound players' Top100 so
// the first BP type analysis answers in seconds instead of minutes.
// Usage: node --import tsx tools/warm-osu-oracle.mjs [--user <qq|osuId>] [--concurrency 4]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDb } from '../server/store.ts';
import { getUser, getUserById, getUserBestScores } from '../server/osu/api.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(__dirname, '..', '..', 'My pack', 'osu_oracle', 'cache', 'beatmaps');
const DOWNLOAD_URL = (id) => `https://osu.direct/api/osu/${id}`;

const args = process.argv.slice(2);
const concurrency = Math.max(1, Math.min(12, Number(args.find((a) => a.startsWith('--concurrency'))?.split('=')[1] || 4)));
const userFilter = [];
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--user') {
    const value = args[index + 1];
    if (value && !value.startsWith('--')) userFilter.push(value);
  } else if (arg.startsWith('--user=')) {
    userFilter.push(arg.split('=')[1]);
  }
}

fs.mkdirSync(CACHE_DIR, { recursive: true });

async function downloadOne(id) {
  const file = path.join(CACHE_DIR, `${id}.osu`);
  if (fs.existsSync(file)) return 'skip';
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(DOWNLOAD_URL(id), { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      fs.writeFileSync(file, text, 'utf8');
      return 'downloaded';
    } catch (err) {
      lastError = err;
      if (!String(err.message).includes('429') || attempt >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function runPool(ids) {
  const queue = [...ids];
  let downloaded = 0;
  let skipped = 0;
  const failed = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const id = queue[cursor++];
      try {
        const result = await downloadOne(id);
        if (result === 'downloaded') downloaded++;
        else skipped++;
      } catch (err) {
        failed.push(`${id}: ${err.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return { downloaded, skipped, failed };
}

const db = readDb();
const bindings = db.osuBindings || {};
const targets = [];
for (const [qq, binding] of Object.entries(bindings)) {
  const osuUserId = typeof binding === 'number'
    ? binding
    : Number(binding?.osuUserId ?? binding?.userId ?? binding?.id ?? 0);
  if (osuUserId > 0) targets.push({ qq, osuUserId });
}

const selected = userFilter.length
  ? targets.filter((t) => userFilter.includes(String(t.qq)) || userFilter.includes(String(t.osuUserId)))
  : targets;

if (selected.length === 0) {
  console.log('没有找到可预热的绑定玩家。');
  process.exit(0);
}

let grandDownloaded = 0;
let grandSkipped = 0;
let grandFailed = 0;
for (const target of selected) {
  let user;
  try {
    user = await getUserById(target.osuUserId);
  } catch {
    console.log(`[${target.qq}] 找不到 osu 用户 ${target.osuUserId}，跳过`);
    continue;
  }
  const scores = await getUserBestScores(user.id, 'osu', 100);
  const ids = [...new Set(scores.map((s) => Number(s.beatmap?.id || 0)).filter((id) => id > 0))];
  const { downloaded, skipped, failed } = await runPool(ids);
  grandDownloaded += downloaded;
  grandSkipped += skipped;
  grandFailed += failed.length;
  console.log(`[${user.username}] 目标 ${ids.length} 张 | 新下载 ${downloaded} | 已缓存 ${skipped} | 失败 ${failed.length}`);
  if (failed.length) console.log('  ' + failed.slice(0, 5).join('\n  '));
}

console.log(`预热完成：新下载 ${grandDownloaded}，已缓存 ${grandSkipped}，失败 ${grandFailed}`);
process.exit(grandFailed > 0 && grandDownloaded === 0 ? 1 : 0);
