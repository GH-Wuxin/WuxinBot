/*
 * 把图片导入随机表情包图池，并做隐私归一化。
 *
 * 为什么需要工具而不是手动拷：源图是 ChatGPT 出来的，文件名带「ChatGPT 图像 …」，
 * 且每张都带 C2PA 块 —— 里面明写 softwareAgent=ChatGPT / version=gpt-image /
 * OpenAI Media Service API / digitalSourceType=trainedAlgorithmicMedia。QQ 收到
 * 图片通常会重编码改名，但那是 QQ 的行为、不是保证。所以在文件层面先处理掉。
 *
 * 归一化做两件事：
 *   1. 重命名为 Pippi_Random_NNN.png（编号稳定，已存在的号不动，新的往后接）
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
  // 源目录指向 pippi image 下的 pippi random 子目录：那里只放随机甩图的图。
  // 同级还有一个 pippi self 放贴纸，是另一套发送机制，不能混进随机池。
  const args = { source: 'G:/My pack/pippi image/pippi random', pool: '', dryRun: false };
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

// 图池文件的命名前缀。与贴纸区分：贴纸是 Pippi_Self_NNN，随机甩图是 Pippi_Random_NNN。
const NAME_PREFIX = 'Pippi_Random_';

function pad(number) {
  return String(number).padStart(3, '0');
}

/** 已存在的 Pippi_Random_NNN.png 占用哪些编号。早期的 pippi-NN 也认，方便过渡。 */
function takenNumbers(entries) {
  const taken = new Set();
  const note = (digits) => {
    if (digits.length && !Number.isNaN(Number(digits))) taken.add(Number(digits));
  };
  for (const entry of entries) {
    const base = entry.name.slice(0, entry.name.lastIndexOf('.'));
    if (base.startsWith(NAME_PREFIX)) note(base.slice(NAME_PREFIX.length));
    else if (base.startsWith('pippi-')) note(base.slice('pippi-'.length));
  }
  return taken;
}

if (!fs.existsSync(POOL)) fs.mkdirSync(POOL, { recursive: true });
const poolEntries = readImage(POOL);
// 源目录里若有子目录却没有图片，多半是 --source 指到了上层目录。这里直接报错，
// 免得静默地什么都不做（子目录不会被平铺扫描读到）。
if (fs.existsSync(SOURCE)) {
  const entries = fs.readdirSync(SOURCE, { withFileTypes: true });
  const hasImage = entries.some((e) => e.isFile() && hasImageExtension(e.name));
  const subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  if (!hasImage && subdirs.length) {
    console.error('源目录 ' + SOURCE + ' 下没有图片，只有子目录：' + subdirs.join('、'));
    console.error('请指向具体子目录，例如 ' + path.join(SOURCE, 'pippi random'));
    process.exit(2);
  }
}
const extras = SOURCE === POOL || !fs.existsSync(SOURCE) ? [] : readImage(SOURCE);

// 去重必须按**摘掉 caBX 之后**的内容算，不能按原始字节。
// 池里的文件是归一化过的、源文件还带着 caBX —— 按原始字节比，同一张图会被当成
// 两张（实测：26 张池内文件 + 26 张同源文件 = 53 张，一张都没去重掉）。
function contentKey(buffer) {
  return sha256(stripC2pa(buffer).buffer);
}

const knownHashes = new Map();
const duplicatePoolFiles = [];
for (const entry of poolEntries) {
  const key = contentKey(fs.readFileSync(entry.file));
  const seen = knownHashes.get(key);
  if (seen) {
    // 同一内容在池里有多个编号：保留编号小的，其余删掉。
    const keepNumber = Number(seen.name.slice(6, seen.name.lastIndexOf('.'))) || 0;
    const thisNumber = Number(entry.name.slice(6, entry.name.lastIndexOf('.'))) || 0;
    if (keepNumber && thisNumber && thisNumber < keepNumber) {
      duplicatePoolFiles.push(seen.file);
      knownHashes.set(key, { file: entry.file, name: entry.name });
    } else duplicatePoolFiles.push(entry.file);
    continue;
  }
  knownHashes.set(key, { file: entry.file, name: entry.name });
}

const taken = takenNumbers(poolEntries);
let next = 1;
function nextNumber() {
  while (taken.has(next)) next += 1;
  taken.add(next);
  return next;
}

// 先把池里不符合命名的文件编号（一次性迁移），再收源目录里的新图。
const toNumber = poolEntries.filter((entry) => {
  const base = entry.name.slice(0, entry.name.lastIndexOf('.'));
  return !base.startsWith(NAME_PREFIX);
});

const additions = [];
for (const entry of extras) {
  const buffer = fs.readFileSync(entry.file);
  const key = contentKey(buffer);
  if (knownHashes.has(key)) continue;
  knownHashes.set(key, { file: entry.file, name: entry.name });
  additions.push({ ...entry, buffer });
}

console.log('  图池   ' + POOL);
console.log('  源目录 ' + SOURCE + (extras.length ? '' : '（不存在或与图池相同，跳过）'));
console.log('');
console.log('  图池现有      ' + poolEntries.length + ' 张（其中 ' + toNumber.length + ' 张需要改名，' + duplicatePoolFiles.length + ' 张是同内容重复）');
console.log('  源目录        ' + extras.length + ' 张，按内容去重后新增 ' + additions.length + ' 张');
console.log('  计划结果      ' + (poolEntries.length - duplicatePoolFiles.length + additions.length) + ' 张');
console.log('');

if (args.dryRun) {
  for (const entry of toNumber) console.log('    改名 ' + entry.name + ' → ' + NAME_PREFIX + pad(nextNumber()) + '.png');
  for (const entry of additions) console.log('    新增 ' + entry.name + ' → ' + NAME_PREFIX + pad(nextNumber()) + '.png');
  console.log('');
  console.log('  （--dry-run，未写入）');
  process.exit(0);
}

let renamed = 0;
let added = 0;
let stripped = 0;
let pruned = 0;

// 0) 先清掉池内同内容的重复文件（保留编号最小的那个）
for (const file of duplicatePoolFiles) {
  if (fs.existsSync(file)) { fs.rmSync(file); pruned += 1; }
}

// 1) 池内不合规命名的：摘块 + 改名
for (const entry of toNumber) {
  const raw = fs.readFileSync(entry.file);
  const { buffer, removed } = stripC2pa(raw, entry.name);
  stripped += removed;
  const target = path.join(POOL, NAME_PREFIX + pad(nextNumber()) + '.png');
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
  fs.writeFileSync(path.join(POOL, NAME_PREFIX + pad(nextNumber()) + '.png'), buffer);
  added += 1;
}

// 4) 清掉重复后编号会有空洞，压紧一次。正常导入只是往后追加、不产生空洞，
//    所以这一步只在真删过东西时才动，不会每跑一次就重编号。
// 判据是「编号是否连续」，不是「这次有没有删过东西」—— 否则上一次清理留下的
// 空洞永远补不上（实测：删了 26 张重复后编号停在 …26, 53，重跑却报重编号 0）。
// 编号连续时这一步是空操作，所以幂等。
let compacted = 0;
{
  const remaining = readImage(POOL);
  const wanted = remaining.map((entry, index) => NAME_PREFIX + pad(index + 1) + '.png');
  const renames = [];
  remaining.forEach((entry, index) => {
    if (entry.name !== wanted[index]) renames.push({ from: entry.file, to: path.join(POOL, wanted[index]) });
  });
  if (renames.length) {
    const staged = [];
    // 先全部挪到临时名，避免目标名与尚未处理的文件撞车。
    renames.forEach((item, index) => {
      const temporary = path.join(POOL, '__compact_' + index + '.tmp');
      fs.renameSync(item.from, temporary);
      staged.push({ temporary, target: item.to });
    });
    for (const item of staged) {
      // 目标名可能正好被另一张占用，占用的那个此时已在临时名下。
      if (fs.existsSync(item.target)) fs.rmSync(item.target);
      fs.renameSync(item.temporary, item.target);
    }
    compacted = renames.length;
  }
}

const final = readImage(POOL);
console.log('  去重删除 ' + pruned + ' · 重编号 ' + compacted + ' · 改名 ' + renamed + ' · 新增 ' + added + ' · 摘掉 caBX ' + stripped + ' 个块');
console.log('  图池现在 ' + final.length + ' 张：' + final.slice(0, 3).map((e) => e.name).join(', ') + ' … ' + final.slice(-2).map((e) => e.name).join(', '));
