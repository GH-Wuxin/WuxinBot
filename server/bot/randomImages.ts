// 随机表情包：群里每有一条消息就掷一次骰子，命中就单独甩一张图。
//
// 为什么是代码而不是 LLM：这是"群友偶尔没理由地发张图"，不是对话的一部分。
// 走 LLM 既没有理由，也会把成本和延迟搭进去。模型完全不知道这个机制存在。
//
// 图池是**目录**而不是清单：往目录里丢文件就生效，不用改代码、不用重打包、
// 不用同步安装版。目录 mtime 变了就重扫，所以加图不需要重启。

import fs from 'node:fs';
import path from 'node:path';
import { updateDb } from '../store.js';

/** 只认这些后缀（字面比较，不做模式匹配）。 */
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif'];

export interface RandomImageRates {
  /** 命中概率的基础值，发出后回到这里。0.005 = 0.5% */
  base: number;
  /** 每次没命中累加多少。0.0005 = 0.05% */
  step: number;
}

export interface RandomImageConfig {
  enabled: boolean;
  natural: RandomImageRates;
  light: RandomImageRates;
}

/**
 * 默认值来自实测：真实群聊里 pippi 的文字发言是 1.35 / 2.25 条每小时，
 * 加上表情包后她在群友频率分布里排到前 23% / 前 11% —— 仍然是个正常活跃的
 * 群友，不是刷屏号。期望间隔 47.8 条（自然）/ 84.5 条（轻度），区分度 1.77 倍。
 */
// 每群保留多少条发送流水。一个群一天最多几十张，20 条够回溯最近一轮。
const RECENT_LIMIT = 20;

const DEFAULTS: RandomImageConfig = {
  enabled: true,
  natural: { base: 0.005, step: 0.0005 },
  light: { base: 0.001, step: 0.0002 },
};

function clampRate(value: unknown, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.min(1, number);
}

export function randomImageConfig(db: any): RandomImageConfig {
  const raw = db?.settings?.randomImage;
  if (!raw || typeof raw !== 'object') return DEFAULTS;
  const pick = (slot: any, fallback: RandomImageRates): RandomImageRates => ({
    base: clampRate(slot?.base, fallback.base),
    step: clampRate(slot?.step, fallback.step),
  });
  return {
    enabled: raw.enabled !== false,
    natural: pick(raw.natural, DEFAULTS.natural),
    light: pick(raw.light, DEFAULTS.light),
  };
}

/** 图池目录：默认在数据目录下，可用 settings.randomImageDir 指到别处。 */
export function randomImageDir(db: any): string {
  const configured = String(db?.settings?.randomImageDir || '').trim();
  if (configured) return path.resolve(configured);
  const dataDir = process.env.DATA_DIR
    || path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:', 'AppData', 'Roaming'), 'Wuxin');
  return path.join(dataDir, 'random-images');
}

// 目录签名 = 路径 + mtime。丢进一个文件就会变，于是自动重扫。
// mtime 的分辨率抓不到同一毫秒内的增删（实测：加一张再删掉，两次读到的 mtime
// 相同，缓存没失效），所以再加一道 TTL 兜底 —— 变动最迟 30 秒内生效。
const SCAN_TTL_MS = 30_000;
let cache = { dir: '', signature: '', files: [] as string[], scannedAt: 0 };

export function listRandomImages(db: any): string[] {
  const dir = randomImageDir(db);
  let modified = 0;
  let exists = false;
  try {
    const stat = fs.statSync(dir);
    exists = stat.isDirectory();
    modified = stat.mtimeMs;
  } catch { exists = false; }
  const now = Date.now();
  if (!exists) {
    cache = { dir, signature: '', files: [], scannedAt: now };
    return [];
  }
  const signature = dir + '|' + modified;
  if (cache.dir === dir && cache.signature === signature && now - cache.scannedAt < SCAN_TTL_MS) {
    return cache.files;
  }
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir)
      .filter((name) => IMAGE_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(extension)))
      .sort()
      .map((name) => path.join(dir, name))
      .filter((file) => {
        try { return fs.statSync(file).isFile(); } catch { return false; }
      });
  } catch { files = []; }
  cache = { dir, signature, files, scannedAt: now };
  return files;
}

export interface RandomImageRoll {
  /** 命中的图片路径；没命中或有任何前置条件不满足时为 null。 */
  file: string | null;
  /** 这次用的概率，便于观测。 */
  chance: number;
  /** 图池里有几张，0 表示目录空或不存在。 */
  poolSize: number;
  /** 掷骰后写回的概率（命中则回到基础值）。 */
  nextChance: number;
}

const NO_ROLL: RandomImageRoll = { file: null, chance: 0, poolSize: 0, nextChance: 0 };

/**
 * 掷一次骰子并把新概率写回 db。
 *
 * mode 只接受 natural / light —— mention 与 osu 档的群不参与，因为在
 * "只在 @ 时回复"的群里随手发图跟该约定直接冲突（实测有个 161 条/小时的群
 * 她从不说话，若也掷骰子就会每 18 分钟甩一张图）。
 */
export function rollRandomImage(groupId: string, mode: string | undefined): RandomImageRoll {
  const result = { roll: NO_ROLL };
  updateDb((db) => {
    const config = randomImageConfig(db);
    const rates = mode === 'natural' ? config.natural : mode === 'light' ? config.light : null;
    if (!config.enabled || !rates) return;
    const files = listRandomImages(db);
    if (!files.length) return;

    const previous = (db.randomImageState && db.randomImageState[groupId]) || {};
    const chance = Number.isFinite(previous.chance) ? Number(previous.chance) : rates.base;
    const hit = Math.random() < chance;
    const picked = hit ? files[Math.floor(Math.random() * files.length)] : null;
    // 未命中时必须**继承**上次命中的记录。早先只在命中那一支里写这两个字段，
    // 结果命中后只要再掷一次骰子，lastFile / lastHitAt 就被抹掉了 —— 于是
    // 「刚才发出去的是哪张」变得无从查证（发出的图不进消息库）。
    const next: Record<string, unknown> = {
      chance: hit ? rates.base : Math.min(1, chance + rates.step),
      rolls: Number(previous.rolls || 0) + 1,
      hits: Number(previous.hits || 0) + (hit ? 1 : 0),
    };
    if (previous.lastHitAt) next.lastHitAt = previous.lastHitAt;
    if (previous.lastFile) next.lastFile = previous.lastFile;
    // 最近若干次发送的流水。只留最后一张是不够用的：「发了几张、分别是什么」
    // 是会被问的问题，而发出的图不进消息库、也没有发送日志可回溯。
    // 注意必须赋一个**新数组**：store 在赋值那一刻对值做快照，原地 push 不会落盘。
    const history = Array.isArray(previous.recent) ? previous.recent.slice(-(RECENT_LIMIT - 1)) : [];
    // 累计已发集合：只增不减。流水会被截断、记录会按时间裁剪，只有这个是
    // 「这张到底发出去过没有」的可靠依据 —— 而这正是会被人问的问题。
    const everSent = Array.isArray(previous.everSent) ? previous.everSent : [];
    if (hit) {
      next.lastHitAt = new Date().toISOString();
      next.lastFile = picked;
      next.recent = [...history, { at: next.lastHitAt, file: picked }];
      const name = picked ? path.basename(picked) : '';
      next.everSent = name && !everSent.includes(name) ? [...everSent, name] : everSent;
    } else {
      if (history.length) next.recent = history;
      if (everSent.length) next.everSent = everSent;
    }
    // 必须整体赋值。store 在赋值那一刻对值做快照：先赋一个空对象、之后再往
    // 同一个对象上加属性，那些属性不会落盘（实测 db.x = {}; db.x.a = 1 得到 {}）。
    db.randomImageState = { ...(db.randomImageState || {}), [groupId]: next };
    result.roll = { file: picked, chance, poolSize: files.length, nextChance: Number(next.chance) };
  });
  return result.roll;
}

/** 每群的当前概率与累计，供 GUI / 排查用。 */
export function randomImageStats(db: any): Record<string, any> {
  return db?.randomImageState && typeof db.randomImageState === 'object' ? db.randomImageState : {};
}
