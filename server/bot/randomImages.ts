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
  low: RandomImageRates;
  standard: RandomImageRates;
  /** 最近这么多次发送会被降权（软规则，不是排除：仍然可能抽中，只是不常见）。 */
  recentWindow: number;
  /** 每往前退一次，权重乘以多少。1 = 不降权，0 = 退化成硬排除。 */
  recentDecay: number;
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
  standard: { base: 0.005, step: 0.0005 },
  low: { base: 0.001, step: 0.0002 },
  // 软规则：越靠近最近一次发送，权重越低 —— 最近一次 = 0.35^窗口长度，
  // 窗口内最远一次 = 0.35，窗口外一律 1。不归零，所以真人那种偶尔连着发
  // 同一张仍然保留，只是概率上被压得极低。
  recentWindow: 8,
  recentDecay: 0.35,
  // 另有硬规则：池子里还有没发过的图时只从没发过的里面选（见 pickWeighted）。
  // 实测旧逻辑 73 次发送只用到 77 张里的 39 张 —— 比均匀随机还差。
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
  const window = Number(raw.recentWindow);
  const decay = Number(raw.recentDecay);
  return {
    enabled: raw.enabled !== false,
    // Read the old names for backwards compatibility. They are only a data
    // migration alias; runtime selection comes from the group's own rate.
    standard: pick(raw.standard || raw.natural, DEFAULTS.standard),
    low: pick(raw.low || raw.light, DEFAULTS.low),
    recentWindow: Number.isFinite(window) && window >= 0 ? Math.floor(window) : DEFAULTS.recentWindow,
    recentDecay: Number.isFinite(decay) && decay >= 0 && decay <= 1 ? decay : DEFAULTS.recentDecay,
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

/**
 * 从图池里挑一张，最近发过的按倒数第几次降权（**软规则**）。
 *
 * 不用硬排除：真人也会偶尔连着发同一张，只是不常见。硬排除会让「重复」这件事
 * 彻底消失，反而不像人；而且池子比排除数小时还得写退让逻辑。
 * 降权则是概率上压低 —— 抽中的可能始终存在，池子再小也不会卡住。
 *
 * 权重：越靠近最近一次发送，抑制越强 —— 最近一次 = decay^窗口长度，最远一次 =
 * decay^1（同名取最强的那次抑制），窗口外 = 1。decay=0 时等价于硬排除，
 * decay=1 时等价于不降权。
 */
export function pickWeighted(files: string[], previous: any, window: number, decay: number): string {
  const nameOf = (file: unknown) => path.basename(String(file || ''));
  const suppress = new Map<string, number>();
  const note = (name: string, weight: number) => {
    if (!name) return;
    const existing = suppress.get(name);
    if (existing === undefined || weight < existing) suppress.set(name, weight);
  };
  // window = 0 表示关闭降权。注意不能写成 slice(-window)：slice(-0) 等于 slice(0)，
  // 会返回整个数组，于是「关闭」反而变成「全部降权」。
  const history = Array.isArray(previous?.recent) ? previous.recent : [];
  const recent = window > 0 ? history.slice(-window) : [];
  recent.forEach((entry, index) => {
    // 越靠近最近一次发送，指数越大、权重越小。
    //
    // 早先这里写的是 decay^(recent.length - index)，指数方向反了：最近一次拿到
    // 最小的指数 decay^1 = 0.35，而 8 次之前那张拿到 decay^8 ≈ 0.0002。
    // 抑制的总量还在，只是压错了对象 —— 于是「别重复」变成了「别发旧的」，
    // 整体退化成均匀随机（77 张的池子里 19 次发送出现 2~3 次重复，正是均匀随机的期望）。
    note(nameOf(entry?.file), Math.pow(decay, index + 1));
  });
  // 流水是后来才加的：窗口内没有流水时用 lastFile 兜底，否则升级那一刻会漏掉一张。
  if (window > 0 && !recent.length) note(nameOf(previous?.lastFile), Math.pow(decay, 1));

  // 第一阶段：池子里还有没发过的图时，只从没发过的里面选。
  //
  // 这一步是硬规则而不是加权：加权只是「偏向新的」，偏得不够仍会撞上 —— 实测
  // 4 倍权重下，73 次发送仍有 12 次重复，而池子有 77 张，本来不该重复。
  // 池子比发送次数还多的时候，「别重复」应当是保证，不是倾向。
  //
  // 全部发过一遍之后回落到下面的加权抽取，此时重复才是正常的。
  const everSent = new Set((Array.isArray(previous?.everSent) ? previous.everSent : []).map(nameOf));
  const unused = files.filter((file) => !everSent.has(path.basename(file)));
  const candidates = unused.length ? unused : files;

  let total = 0;
  const weights = candidates.map((file) => {
    const weight = suppress.get(path.basename(file)) ?? 1;
    total += weight;
    return { file, weight };
  });
  // 全被压到 0（decay=0 且每张都在窗口内）时退回均匀取，保证一定发得出去。
  if (!(total > 0)) return candidates[Math.floor(Math.random() * candidates.length)];
  let roll = Math.random() * total;
  for (const item of weights) {
    roll -= item.weight;
    if (roll <= 0) return item.file;
  }
  return weights[weights.length - 1].file;
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
 * rate 只接受 low / standard。群聊文字回复模式不参与这里的判断；一个群
 * 可以只关闭文字回复，继续独立运行随机发图模块。
 */
export function rollRandomImage(groupId: string, rate: string | undefined): RandomImageRoll {
  const result = { roll: NO_ROLL };
  updateDb((db) => {
    const config = randomImageConfig(db);
    const rates = rate === 'low' ? config.low : config.standard;
    if (!config.enabled || !rates) return;
    const files = listRandomImages(db);
    if (!files.length) return;

    const previous = (db.randomImageState && db.randomImageState[groupId]) || {};
    const chance = Number.isFinite(previous.chance) ? Number(previous.chance) : rates.base;
    const hit = Math.random() < chance;
    const picked = hit ? pickWeighted(files, previous, config.recentWindow, config.recentDecay) : null;
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

/**
 * 给控制台用的快照：哪些群参与、各自掷了多少次、命中几次、当前概率、最近发的是哪几张。
 *
 * 参与与否由每群自己的随机发图开关决定；群聊文字模式只作为展示信息保留。
 */
export interface RandomImageSnapshot {
  config: RandomImageConfig;
  pool: { dir: string; count: number };
  groups: Array<{
    groupId: string; name: string; mode: string; randomImageEnabled: boolean;
    randomImageRate: 'low' | 'standard'; participates: boolean;
    rolls: number; hits: number; chance: number;
    lastHitAt: string | null; lastFile: string | null; everSent: number;
    recent: Array<{ at: string; file: string }>;
  }>;
  totals: { rolls: number; hits: number };
  /** 各群流水合并后按时间倒序，供控制台直接渲染最近的发送。 */
  recent: Array<{ at: string; file: string; groupId: string; groupName: string }>;
}

export function randomImageSnapshot(db: any): RandomImageSnapshot {
  const state = randomImageStats(db);
  const totals = { rolls: 0, hits: 0 };
  const groups = (db?.groups || []).map((group: any) => {
    const groupId = String(group.groupId);
    const mode = String(group.mode || '');
    const randomImageEnabled = group.randomImageEnabled === true;
    const randomImageRate = group.randomImageRate === 'low' ? 'low' : 'standard';
    const entry = state[groupId] || {};
    const rolls = Number(entry.rolls || 0);
    const hits = Number(entry.hits || 0);
    totals.rolls += rolls;
    totals.hits += hits;
    return {
      groupId,
      name: String(group.name || ''),
      mode,
      randomImageEnabled,
      randomImageRate,
      participates: randomImageEnabled,
      rolls,
      hits,
      chance: Number.isFinite(entry.chance) ? Number(entry.chance) : 0,
      lastHitAt: entry.lastHitAt ? String(entry.lastHitAt) : null,
      lastFile: entry.lastFile ? path.basename(String(entry.lastFile)) : null,
      everSent: Array.isArray(entry.everSent) ? entry.everSent.length : 0,
      recent: (Array.isArray(entry.recent) ? entry.recent : []).map((item: any) => ({
        at: String(item?.at || ''),
        file: path.basename(String(item?.file || '')),
      })),
    };
  });
  // 最近发送：把各群的流水并起来按时间倒序，供控制台直接渲染缩略图。
  const merged = groups.flatMap((group: any) => group.recent.map((item: any) => ({
    at: String(item.at),
    file: String(item.file),
    groupId: String(group.groupId),
    groupName: String(group.name || ''),
  })));
  merged.sort((a: any, b: any) => Date.parse(b.at) - Date.parse(a.at));
  return {
    config: randomImageConfig(db),
    pool: { dir: randomImageDir(db), count: listRandomImages(db).length },
    groups,
    totals,
    recent: merged.slice(0, 24),
  };
}
