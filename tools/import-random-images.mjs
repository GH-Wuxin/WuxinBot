/*
 * 把图片导入随机表情包图池，并做隐私归一化。
 *
 * 为什么需要工具而不是手动拷：源图是 ChatGPT 出来的，文件名带「ChatGPT 图像 …」，
 * 且每张都带 C2PA 块 —— 里面明写 softwareAgent=ChatGPT / version=gpt-image /
 * OpenAI Media Service API / digitalSourceType=trainedAlgorithmicMedia。QQ 收到
 * 图片通常会重编码改名，但那是 QQ 的行为、不是保证。所以在文件层面先处理掉。
 *
 * 归一化做两件事：
 *   1. 重命名为 pippi-NN.png（编号稳定，已存在的号不动，新的往后接）
 *   2. 摘掉 caBX 块 —— 只删一个 PNG 数据块，像素一字节不动，不重编码
 *
 * 按内容哈希去重，所以反复运行是安全的：新增几张就只处理那几张。
 *
 * 用法：
 *   node --import tsx tools/import-random-images.mjs
 *   node --import tsx tools/import-random-images.mjs --source <目录> --pool <目录> [--dry-run]
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

function parseArgs(argv) {
  const args = { source: 'G:/My pack/pippi image', pool: '', dryRun: false };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--dry-run') { args.dryRun = true; continue; }
    if (token === '--source') { args.source = argv[index + 1]; index += 1; continue; }
    if (token === '--pool') { args.pool = argv[index + 1]; index += 1; continue; }
  }
  if (!args.pool) {
    const root = process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:', 'AppData', 'Roaming');
    args.pool = path.join(root, 'Wuxin', 'random-images');
  }
  return args;
}

const args = parseArgs(process.argv);
const SOURCE = path.resolve(args.source);
const POOL = path.resolve(args.pool);

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function hasImageExtension(name) {
  const lower = name.toLowerCase();
  return IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function readImage(dir) {
  return fs.readdirSync(dir)
    .filter(hasImageExtension)
    .sort()
    .map((name) => ({ name, file: path.join(dir, name) }));
}

/** 摘掉 PNG 的 caBX 块。非 PNG 或没有该块时原样返回。 */
function stripC2pa(buffer, name) {
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return { buffer, removed: 0 };
  const parts = [PNG_SIGNATURE];
  let index = 8;
  let removed = 0;
  while (index + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(index);
    const type = buffer.toString('ascii', index + 4, index + 8);
    const end = index + 8 + length + 4;
    if (end > buffer.length) break;
    const chunk = buffer.subarray(index, end);
    if (type === 'caBX') removed += 1;
    else parts.push(chunk);
    index = end;
    if (type === 'IEND') break;
  }
  if (!removed) return { buffer, removed: 0 };
  void name;
  return { buffer: Buffer.concat(parts), removed };
}

function pad(number) {
  return String(number).padStart(2, '0');
}

/** 已存在的 pippi-NN.png 占用哪些编号 */
function takenNumbers(entries) {
  const taken = new Set();
  for (const entry of entries) {
    const base = entry.name.slice(0, entry.name.lastIndexOf('.'));
    if (!base.startsWith('pippi-')) continue;
    const digits = base.slice('pippi-'.length);
    if (digits.length && !Number.isNaN(Number(digits))) taken.add(Number(digits));
  }
  return taken;
}

if (!fs.existsSync(POOL)) fs.mkdirSync(POOL, { recursive: true });
const poolEntries = readImage(POOL);
const extras = SOURCE === POOL || !fs.existsSync(SOURCE) ? [] : readImage(SOURCE);

// 池里已有的内容哈希：用来去重，也让重复运行变成无操作。
const knownHashes = new Map();
for (const entry of poolEntries) {
  knownHashes.set(sha256(fs.readFileSync(entry.file)), { file: entry.file, name: entry.name });
}

const taken = takenNumbers(poolEntries);
let next = 1;
function nextNumber() {
  while (taken.has(next)) next += 1;
  taken.add(next);
  return next;
}

// 先把池里不符合 pippi-NN 命名的文件编号（一次性迁移），再收源目录里的新图。
const toNumber = poolEntries.filter((entry) => {
  const base = entry.name.slice(0, entry.name.lastIndexOf('.'));
  return !base.startsWith('pippi-');
});

const additions = [];
for (const entry of extras) {
  const buffer = fs.readFileSync(entry.file);
  const hash = sha256(buffer);
  if (knownHashes.has(hash)) continue;
  knownHashes.set(hash, { file: entry.file, name: entry.name });
  additions.push({ ...entry, buffer });
}

console.log('  图池   ' + POOL);
console.log('  源目录 ' + SOURCE + (extras.length ? '' : '（不存在或与图池相同，跳过）'));
console.log('');
console.log('  图池现有      ' + poolEntries.length + ' 张（其中 ' + toNumber.length + ' 张需要改成 pippi-NN）');
console.log('  源目录        ' + extras.length + ' 张，按内容去重后新增 ' + additions.length + ' 张');
console.log('  计划结果      ' + (poolEntries.length + additions.length) + ' 张');
console.log('');

if (args.dryRun) {
  for (const entry of toNumber) console.log('    改名 ' + entry.name + ' → pippi-' + pad(nextNumber()) + '.png');
  for (const entry of additions) console.log('    新增 ' + entry.name + ' → pippi-' + pad(nextNumber()) + '.png');
  console.log('');
  console.log('  （--dry-run，未写入）');
  process.exit(0);
}

let renamed = 0;
let added = 0;
let stripped = 0;

// 1) 池内不合规命名的：摘块 + 改名
for (const entry of toNumber) {
  const raw = fs.readFileSync(entry.file);
  const { buffer, removed } = stripC2pa(raw, entry.name);
  stripped += removed;
  const target = path.join(POOL, 'pippi-' + pad(nextNumber()) + '.png');
  fs.writeFileSync(target, buffer);
  fs.rmSync(entry.file);
  renamed += 1;
}

// 2) 池内已合规命名的：只摘块（内容变了才重写）
for (const entry of poolEntries) {
  if (toNumber.includes(entry)) continue;
  const raw = fs.readFileSync(entry.file);
  const { buffer, removed } = stripC2pa(raw, entry.name);
  if (removed) { fs.writeFileSync(entry.file, buffer); stripped += removed; }
}

// 3) 源目录新增的：摘块 + 编号写入
for (const entry of additions) {
  const { buffer, removed } = stripC2pa(entry.buffer, entry.name);
  stripped += removed;
  fs.writeFileSync(path.join(POOL, 'pippi-' + pad(nextNumber()) + '.png'), buffer);
  added += 1;
}

const final = readImage(POOL);
console.log('  改名 ' + renamed + ' · 新增 ' + added + ' · 摘掉 caBX ' + stripped + ' 个块');
console.log('  图池现在 ' + final.length + ' 张：' + final.slice(0, 3).map((e) => e.name).join(', ') + ' … ' + final.slice(-2).map((e) => e.name).join(', '));
