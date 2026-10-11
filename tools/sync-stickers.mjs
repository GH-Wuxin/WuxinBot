/**
 * 把表情包从素材目录同步进 bot 本体，作为内置资源。
 *
 * 资源布局照抄仓库既有的约定（server/bots/skillCard/assets/tier-*.png）：
 *   server/bot/stickers/assets/pippi_<id>.png    ← 512 发送版，随 server/ 一起进安装包
 *   server/bot/stickers/manifest.json            ← 精简清单（只留运行时需要的字段）
 * 运行时用 new URL('./assets/x.png', import.meta.url) 解析，不依赖 cwd。
 *
 * 用法: node tools/sync-stickers.mjs [素材包目录]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DEST_DIR = path.join(REPO, 'server', 'bot', 'stickers');
const ASSETS = path.join(DEST_DIR, 'assets');

const PACK = process.argv[2] || 'G:/My pack/Agent Work/wuxin-bot-artifacts/stickers/source-packs/Pippi_%E8%A1%A8%E6%83%85%E5%8C%85%E5%85%A8%E9%9B%86_2026-10-09';

// 哪些进 bot 库由素材包清单的 state 字段决定（未入库的跳过），不在这里另维护名单。
// group / mode 由素材包清单携带，本脚本只读取，不再内置映射表。
//   random  同义差分池 —— 随机取一条；各张姿势应有区别（两两差 15~40%）
//           太像（<6%）随机切换会像画面抖了一下。
//   context 语境分支 —— 由语境决定取哪张；除区分物外画面应完全相同
//           （同一张脸、同一姿势、同一构图），画面一变就暗示了不同意思。
// 现有串/跳、鼠/板都是 context。

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const manifestPath = path.join(PACK, 'bot_stickers.json');
if (!fs.existsSync(manifestPath)) { console.error('找不到清单: ' + manifestPath); process.exit(1); }
const src = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

fs.mkdirSync(ASSETS, { recursive: true });
// 先清掉上一轮的图，避免残留（比如被弃用的那两张）
for (const f of fs.readdirSync(ASSETS)) fs.rmSync(path.join(ASSETS, f), { force: true });

const out = [];
const skipped = [];
let bytes = 0;
for (const s of src.stickers) {
  if (s.state && s.state !== '入库') { skipped.push(s.id + ' (' + s.state + ')'); continue; }
  const from = path.join(PACK, s.image_path);
  if (!fs.existsSync(from)) { skipped.push(s.id + ' (文件缺失)'); continue; }
  const file = 'pippi_' + s.id + '.png';
  const to = path.join(ASSETS, file);
  fs.copyFileSync(from, to);
  bytes += fs.statSync(to).size;
  out.push({
    id: s.id,
    name: s.name,
    category: s.category,
    emotion: s.emotion,
    description: s.description,
    risk: s.social_risk,
    caption: Boolean(s.has_caption),
    group: s.group || s.id,
    mode: s.mode || 'random',
    // 触发门槛：code 只由代码触发（LLM 不可选）／loose 只查氛围／topic 还要话题匹配
    gate: s.gate || 'loose',
    ...(Array.isArray(s.topics) && s.topics.length ? { topics: s.topics } : {}),
    file,
    sha256: sha256(to),
    size: '512x512',
  });
}

const manifest = {
  version: 1,
  generatedFrom: path.basename(PACK),
  count: out.length,
  stickers: out,
};
fs.writeFileSync(path.join(DEST_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log('  来源      ' + PACK);
console.log('  写入      ' + path.relative(REPO, ASSETS));
console.log('  张数      ' + out.length + (skipped.length ? '   跳过 ' + skipped.length + ': ' + skipped.join(', ') : ''));
console.log('  资源体积  ' + (bytes / 1048576).toFixed(1) + ' MB');
console.log('  清单      ' + path.relative(REPO, path.join(DEST_DIR, 'manifest.json')));
