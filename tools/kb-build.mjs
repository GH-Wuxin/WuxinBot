// kb-build.mjs — WuxinBot knowledge base v4.1 builder.
//
// Builds three collections into `<data-dir>/knowledge/builds/<content-sha>/`
// and atomically switches the `CURRENT` pointer:
//   wuxin_self.json       (hand-authored command/feature entries)
//   osu_domain.json       (derived from server/osu/knowledge entries)
//   community_style.jsonl (approved V2 windows, privacy-filtered)
//   manifest.json         (content + volatile build metadata)
//
// Reproducibility: `content` (schema, tokenizer, queryBuilder, BM25,
// retrievalConfig, collection shas) is deterministic; only `build` carries
// generatedAt/git commit. `lastVerifiedAt` is manual and never auto-touched.
//
// Usage:
//   npx tsx tools/kb-build.mjs                # production data dir (DATA_DIR or %APPDATA%\Wuxin)
//   npx tsx tools/kb-build.mjs --data-dir D  # explicit data dir (tests)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertSafeBaseDir, assertSafeDeleteTarget } from '../server/fsSafe.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--data-dir' || key === '--out') {
      args[key.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      args[key.replace(/^--/, '')] = true;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const dataDir = args['data-dir']
  || process.env.DATA_DIR
  || path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:', 'AppData', 'Roaming'), 'Wuxin');
const knowledgeRoot = args.out || path.join(dataDir, 'knowledge');
const buildsDir = path.join(knowledgeRoot, 'builds');
const currentPath = path.join(knowledgeRoot, 'CURRENT');

const SCHEMA_VERSION = 1;
const TOKENIZER_VERSION = 'v1-cjk-bigram';
const QUERY_BUILDER_VERSION = 1;
const LAST_VERIFIED_AT = '2026-08-06'; // manual human verification date, not auto-updated

const RETRIEVAL_CONFIG = {
  wuxin_self: { topK: 3, minScore: 2.8, minScoreGap: 0.2, minDistinctQueryTokens: 2, requireLexicalOverlap: true },
  osu_domain: { topK: 2, minScore: 2.2, minScoreGap: 0.2, minDistinctQueryTokens: 2, requireLexicalOverlap: true },
  community_style: { topK: 1, minScore: 3.5, minScoreGap: 0.3, minDistinctQueryTokens: 2, requireLexicalOverlap: true },
};

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function canonicalJson(value) {
  const sort = (input) => {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sort(v)])
      );
    }
    return input;
  };
  return JSON.stringify(sort(value));
}

function gitShortCommit() {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
  if (result.status === 0 && result.stdout) return result.stdout.trim();
  return 'unknown';
}

// ── wuxin_self (hand-authored) ──

const WUXIN_SELF = [
  {
    id: 'bind_osu',
    title: '绑定 osu! 账号',
    tags: ['bind', '绑定', '解绑'],
    content: [
      '命令：/w osu bind <osu用户名>',
      '把当前 QQ 绑定到 osu! 账号，之后查成绩、分析、推图默认使用该账号。绑定前需要用户提供正确的 osu! 用户名；不要绑定他人账号。解绑用 /w osu clear bind。',
    ].join('\n'),
    commandExamples: [
      { command: '/w osu bind ElicyAnn', verifier: 'wuxin' },
      { command: '/w osu clear bind', verifier: 'wuxin' },
    ],
    implementationRefs: [
      { path: 'server/osu/commands.ts', symbol: 'handleOsuCommand' },
      { path: 'server/bots/bindingSync.ts', symbol: 'syncLazybotBinding' },
    ],
    lastVerifiedAt: LAST_VERIFIED_AT,
  },
  {
    id: 'analyze_player',
    title: '完整玩家分析',
    tags: ['analyze', '分析', '画像'],
    content: [
      '命令：/w osu analyze [用户名] [--mode=std/taiko/catch/mania]',
      '对玩家进行完整分析：BP、PP+、技能与结论。同一玩家同一模式有约 4 小时冷却，重复请求会显示上次结果；分析在后台队列生成，完成后会 @ 请求者。默认模式 osu!std。',
    ].join('\n'),
    commandExamples: [
      { command: '/w osu analyze mrekk', verifier: 'wuxin' },
      { command: '/w osu analyze', verifier: 'wuxin' },
    ],
    implementationRefs: [
      { path: 'server/osu/commands.ts', symbol: 'handleOsuCommand' },
      { path: 'server/osu/analyzer.ts', symbol: 'analyzeData' },
    ],
    lastVerifiedAt: LAST_VERIFIED_AT,
  },
  {
    id: 'recent_comment',
    title: '近期成绩短评',
    tags: ['recent', '近期', '短评'],
    content: [
      '命令：/w osu recent [用户名] [--mode=std/taiko/catch/mania]',
      '对比近期成绩与完整档案给出短评。需要该玩家先有 /w osu analyze 建立的完整档案；没有时先引导建立档案，不要凭空评价。',
    ].join('\n'),
    commandExamples: [
      { command: '/w osu recent', verifier: 'wuxin' },
    ],
    implementationRefs: [
      { path: 'server/osu/commands.ts', symbol: 'handleOsuCommand' },
    ],
    lastVerifiedAt: LAST_VERIFIED_AT,
  },
  {
    id: 'clear_commands',
    title: '清除绑定、冷却与历史',
    tags: ['clear', '清除', '冷却', '历史'],
    content: [
      '命令：/w osu clear bind（删除绑定）',
      '/w osu clear history（删除分析历史）',
      '/w osu clear cooldown <玩家>（取消指定玩家分析/近期/推图冷却，仅 owner）',
      '/w osu clear recommend <玩家>（清除推图历史与冷却，仅 owner）',
      '/w osu clear cache（清除缓存，仅管理员）',
      '普通群友只能清除自己的绑定和分析历史；冷却与推图历史清除涉及他人，仅 owner 可执行。',
    ].join('\n'),
    commandExamples: [
      { command: '/w osu clear cooldown ElicyAnn', verifier: 'wuxin' },
      { command: '/w osu clear recommend ElicyAnn', verifier: 'wuxin' },
    ],
    implementationRefs: [
      { path: 'server/osu/commands.ts', symbol: 'handleOsuCommand' },
    ],
    lastVerifiedAt: LAST_VERIFIED_AT,
  },
  {
    id: 'quick_score_commands',
    title: '快捷查分指令',
    tags: ['!p', '!bp', '!s', '!i', '!pp', '!k', '快捷指令'],
    content: [
      '常用快捷指令：',
      '!p / !pr / !r — 最近成绩（雨沐/猫猫）',
      '!bp / !bs 1-100 或 #5 — 最佳成绩',
      '!s <BID> [玩家名] — 指定谱面成绩',
      '!i / !info — 玩家信息',
      '!pp / /ppp — PP+ 维度',
      '!k — 技能雷达',
      '!rec / 荐图 / /rd — 推图',
      '!ml — 比赛观战；!ra — 系列 rating',
      '未绑定的玩家会先提示用 /w osu bind 绑定；目标玩家名可以直接写在指令后面。',
    ].join('\n'),
    commandExamples: [
      { command: '!p', verifier: 'quick' },
      { command: '!bp 1-100', verifier: 'quick' },
      { command: '!s 4270382', verifier: 'quick' },
      { command: '!pp', verifier: 'quick' },
      { command: '/ppp', verifier: 'quick' },
      { command: '荐图', verifier: 'quick' },
      { command: '/rd', verifier: 'quick' },
      { command: '!ml 123', verifier: 'quick' },
      { command: '!ra', verifier: 'quick' },
    ],
    implementationRefs: [
      { path: 'server/bot/quickRouter.ts', symbol: 'matchQuickCommand' },
      { path: 'server/bots/executor.ts', symbol: 'executeInternalBotCommand' },
    ],
    lastVerifiedAt: LAST_VERIFIED_AT,
  },
  {
    id: 'recommend_maps',
    title: '推图 / 谱面推荐',
    tags: ['recommend', '推图', '推荐', 'rd', 'rec'],
    content: [
      '触发：玩家说“推图/推荐谱面/打什么图/有没有适合我的图”，或 !rec、荐图、/rd。',
      '推荐基于玩家真实 top 成绩做同分段协同过滤，数据不足时用官方搜索兜底；只支持 osu!std，其他模式如实拒绝。',
      '每人约 10 分钟冷却；已推荐过的图不会在短期内重复出现；支持 BPM、AR、星数等自然语言筛选，筛选无结果时如实说明。',
      '推荐理由只能使用真实数据（同分段人数、星数/pp 区间、mod 偏好），禁止编造“别人都在推荐”这类无来源表述。',
    ].join('\n'),
    commandExamples: [
      { command: '!rec', verifier: 'quick' },
      { command: '/rd', verifier: 'quick' },
      { command: '荐图', verifier: 'quick' },
    ],
    implementationRefs: [
      { path: 'server/osu/recommender.ts', symbol: 'recommendBeatmaps' },
      { path: 'server/bots/executor.ts', symbol: 'executeInternalBotCommand' },
    ],
    lastVerifiedAt: LAST_VERIFIED_AT,
  },
  {
    id: 'level_system',
    title: '群友等级与经验',
    tags: ['lv', 'exp', 'top', '等级', '经验'],
    content: [
      '命令：/w lv（我的等级）、/w top（群排行榜）、/w exp（管理经验，仅 owner）',
      '等级按 pp 数命名：1 级对应 100pp、2 级对应 200pp，无上限。等级 pp 是 bot 内的等级设定，不等于玩家真实 pp；升级提示由 pippi 自然生成，不会生硬播报。',
    ].join('\n'),
    commandExamples: [
      { command: '/w lv', verifier: 'wuxin' },
      { command: '/w top', verifier: 'wuxin' },
    ],
    implementationRefs: [
      { path: 'server/bot/experience.ts', symbol: 'getExperience' },
    ],
    lastVerifiedAt: LAST_VERIFIED_AT,
  },
  {
    id: 'profile_notes',
    title: '画像、备注与称呼',
    tags: ['profile', 'note', 'me', 'nick', 'style', '画像', '备注'],
    content: [
      '命令：/w me（查看 pippi 对我的画像）、/w profile show @某人（查看画像）、/w note @某人 内容（备注）、/w nick 称呼（自定义称呼）、/w style 内容（交互风格）',
      '普通群友可以查看自己的画像与称呼；管理他人画像、备注和风格需要对应权限。画像来自聊天记忆，不能声称知道用户没有提供过的现实经历。',
    ].join('\n'),
    commandExamples: [
      { command: '/w me', verifier: 'wuxin' },
      { command: '/w profile show', verifier: 'wuxin' },
      { command: '/w nick 阿然', verifier: 'wuxin' },
    ],
    implementationRefs: [
      { path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' },
    ],
    lastVerifiedAt: LAST_VERIFIED_AT,
  },
  {
    id: 'persona_prompt',
    title: '人设与提示词管理',
    tags: ['prompt', '人设', '提示词'],
    content: [
      '命令：/w prompt show（查看人设摘要）、/w prompt add 内容（追加）、/w prompt set 内容（覆盖）、/w prompt reset（重置基线）、/w prompt savebase（保存基线，仅 owner）',
      '人设编辑权限按控制台“权限”页配置；pippi 不会在普通聊天里主动谈论自己的内部提示词，被问到内部实现时引导找后台。',
    ].join('\n'),
    commandExamples: [
      { command: '/w prompt show', verifier: 'wuxin' },
      { command: '/w prompt reset', verifier: 'wuxin' },
    ],
    implementationRefs: [
      { path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' },
    ],
    lastVerifiedAt: LAST_VERIFIED_AT,
  },
  {
    id: 'group_settings',
    title: '群聊设置',
    tags: ['mode', 'rate', 'cooldown', 'status', '群设置'],
    content: [
      '命令：/w mode silent|mention|light|natural（回复模式）、/w rate 数字（每小时上限）、/w cooldown 秒数（冷却）、/w status（群参数）、/w group profile show/update/clear（群画像）',
      '这些设置影响当前群的回复节奏；普通群友不能修改，权限不足时如实告知。',
    ].join('\n'),
    commandExamples: [
      { command: '/w mode light', verifier: 'wuxin' },
      { command: '/w status', verifier: 'wuxin' },
    ],
    implementationRefs: [
      { path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' },
    ],
    lastVerifiedAt: LAST_VERIFIED_AT,
  },
  {
    id: 'member_management',
    title: '成员管理',
    tags: ['op', 'ban', 'trust', 'focus', '成员管理'],
    content: [
      '命令：/w op/deop（管理员）、/w ban/unban（黑名单）、/w trust（优先回应）、/w focus（重点关注）、/w quiet（少回应）、/w normal（恢复正常）',
      '成员策略决定 pippi 对谁优先回应、对谁少回应或不回应；操作需要管理员以上权限。',
    ].join('\n'),
    commandExamples: [
      { command: '/w ban @某人', verifier: 'wuxin' },
      { command: '/w trust @某人', verifier: 'wuxin' },
    ],
    implementationRefs: [
      { path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' },
    ],
    lastVerifiedAt: LAST_VERIFIED_AT,
  },
  {
    id: 'model_search_settings',
    title: '模型与搜索',
    tags: ['model', 'search', '模型', '搜索'],
    content: [
      '命令：/w model 模型名（切换模型）、/w model list（模型列表）、/w search on|off|status|fast|balanced|deep（搜索开关与模式）、/w thinking off|simple|detail|slow（思考提示）、/w summarize 条数（总结群聊）',
      '模型与搜索属于系统级设置，普通群友只能查看部分状态，修改需要管理员权限。',
    ].join('\n'),
    commandExamples: [
      { command: '/w model list', verifier: 'wuxin' },
      { command: '/w search status', verifier: 'wuxin' },
    ],
    implementationRefs: [
      { path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' },
    ],
    lastVerifiedAt: LAST_VERIFIED_AT,
  },
  {
    id: 'group_bot_switch',
    title: '群内 bot 开关',
    tags: ['bot开关', '群开关', 'yumu', 'kanon', 'hydrant', 'lazybot'],
    content: [
      '在控制台的 osu 界面可以按群单独开启/关闭雨沐（yumu）、猫猫（kanon）、消防栓（hydrant）和 LazyBot 的合并功能。',
      '某个群里 bot 不回应时，先确认该群对应 bot 开关是否开启；这是按群配置，不是全局开关。',
    ].join('\n'),
    commandExamples: [],
    implementationRefs: [
      { path: 'server/index.ts', symbol: 'group-bot-config' },
      { path: 'server/bot.ts', symbol: 'processIncoming' },
    ],
    lastVerifiedAt: LAST_VERIFIED_AT,
  },
  {
    id: 'wuxin_help',
    title: 'Wuxin 指令帮助',
    tags: ['help', '帮助', '指令'],
    content: [
      '命令：/w help（或 /w help 成员|人设|群聊|系统）与 /w osu help',
      '完整指令以实际权限为准；控制台“权限”页是最终依据。',
    ].join('\n'),
    commandExamples: [
      { command: '/w help', verifier: 'wuxin' },
      { command: '/w osu help', verifier: 'wuxin' },
    ],
    implementationRefs: [
      { path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' },
      { path: 'server/osu/commands.ts', symbol: 'handleOsuCommand' },
    ],
    lastVerifiedAt: LAST_VERIFIED_AT,
  },
];

// ── osu_domain (from server/osu/knowledge) ──

const OSU_DOMAIN_TITLES = {
  objects_score_beatmap: '谱面与成绩',
  bp_pp_rank: 'BP、PP 与排名',
  attributes: 'AR/OD/CS/HP 与星数',
  score_judgement: 'Acc/Combo/Miss/评级',
  mods_core: 'Mod 基础',
  modded_attributes: 'Mod 后属性',
  beatmap_status: '谱面状态',
  patterns: '谱面类型',
  client_versions: 'stable 与 lazer',
  performance_detail: 'PP 与 BP 加权',
  dt_ht_clock: 'DT/HT 与时钟速度',
  ar_detail: 'AR 与读图',
  od_detail: 'OD 与判定窗口',
  grade_detail: 'SS/S 评级',
  pattern_detail: '图型细分',
  analysis_evidence: '画像证据边界',
};

function modTitle(id, acronym) {
  return `${acronym} Mod`;
}

async function buildOsuDomain() {
  const { OSU_CORE_ENTRIES, MOD_ANALYSIS_ENTRIES, TOPIC_ENTRIES } = await import('../server/osu/knowledge/index.ts');
  const entries = [];
  for (const entry of [...OSU_CORE_ENTRIES, ...TOPIC_ENTRIES]) {
    entries.push({
      id: entry.id,
      title: OSU_DOMAIN_TITLES[entry.id] || entry.id.replace(/_/g, ' '),
      tags: [...entry.tags],
      content: entry.fact,
      source: entry.source,
      authority: entry.authority,
    });
  }
  for (const [acronym, entry] of Object.entries(MOD_ANALYSIS_ENTRIES)) {
    entries.push({
      id: entry.id,
      title: modTitle(entry.id, acronym),
      tags: [...entry.tags],
      content: entry.fact,
      source: entry.source,
      authority: entry.authority,
    });
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  return entries;
}

// ── community_style (approved V2 windows, privacy-filtered) ──

const PLACEHOLDER_RE = /<[A-Z][A-Z0-9_]{1,32}>/;
const URL_RE = /https?:\/\/|www\./i;
const QQ_NUMBER_RE = /\b\d{8,12}\b/;
const FORWARD_RE = /\[(?:转发消息|Forwarded Messages)\s*[:：]/;
const EMOJI_PLACEHOLDER_RE = /\[表情\d+\]/g;

function buildCommunityStyle() {
  const sourcePath = path.join(root, 'community-corpus', 'reports', 'V2-style-ready-candidates.jsonl');
  const lines = fs.readFileSync(sourcePath, 'utf8').split(/\r?\n/).filter(Boolean);
  const entries = [];
  const skipped = [];
  for (const line of lines) {
    const row = JSON.parse(line);
    if (row.approved !== true) {
      skipped.push({ id: row.window_id, reason: 'not_approved' });
      continue;
    }
    const raw = String(row.text_sanitized || '');
    if (PLACEHOLDER_RE.test(raw)) {
      skipped.push({ id: row.window_id, reason: 'placeholder' });
      continue;
    }
    if (URL_RE.test(raw)) {
      skipped.push({ id: row.window_id, reason: 'url' });
      continue;
    }
    if (QQ_NUMBER_RE.test(raw)) {
      skipped.push({ id: row.window_id, reason: 'qq_number' });
      continue;
    }
    if (FORWARD_RE.test(raw)) {
      skipped.push({ id: row.window_id, reason: 'forward_block' });
      continue;
    }
    const content = raw.replace(EMOJI_PLACEHOLDER_RE, '').replace(/\n{3,}/g, '\n\n').trim();
    if (!content || content.split(/\r?\n/).filter((l) => l.trim()).length === 0) {
      skipped.push({ id: row.window_id, reason: 'empty' });
      continue;
    }
    entries.push({
      id: row.window_id,
      title: '社区表达参考',
      tags: ['community', 'style'],
      content,
    });
  }
  return { entries, skipped };
}

// ── Build / write ──

function writeJsonLines(filePath, rows) {
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

const BUILD_DIR_RE = /^[0-9a-f]{64}$/;
const KEEP_OLD_BUILDS = 2;

function cleanupStaleTmp() {
  if (!fs.existsSync(buildsDir)) return;
  for (const name of fs.readdirSync(buildsDir)) {
    if (!name.startsWith('.tmp-')) continue;
    const target = path.join(buildsDir, name);
    assertSafeDeleteTarget(target, { base: buildsDir, label: '遗留构建临时目录' });
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  if (fs.existsSync(knowledgeRoot)) {
    for (const name of fs.readdirSync(knowledgeRoot)) {
      if (!(name.startsWith('CURRENT.') && name.endsWith('.tmp'))) continue;
      const target = path.join(knowledgeRoot, name);
      assertSafeDeleteTarget(target, { base: knowledgeRoot, label: '遗留 CURRENT 临时指针' });
      try { fs.unlinkSync(target); } catch { /* best-effort */ }
    }
  }
}

function pruneOldBuilds(keepSha) {
  if (!fs.existsSync(buildsDir)) return;
  const candidates = fs.readdirSync(buildsDir)
    .filter((name) => BUILD_DIR_RE.test(name) && name !== keepSha)
    .map((name) => {
      const full = path.join(buildsDir, name);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(full).mtimeMs; } catch { /* unreadable dir, skip */ }
      return { name, full, mtimeMs };
    })
    .filter((item) => item.mtimeMs > 0)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const item of candidates.slice(KEEP_OLD_BUILDS)) {
    assertSafeDeleteTarget(item.full, { base: buildsDir, label: '旧知识库构建版本' });
    try { fs.rmSync(item.full, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

async function main() {
  const osuDomain = await buildOsuDomain();
  const community = buildCommunityStyle();

  const collections = {
    wuxin_self: WUXIN_SELF,
    osu_domain: osuDomain,
    community_style: community.entries,
  };

  assertSafeBaseDir(knowledgeRoot, '知识库构建目录');
  cleanupStaleTmp();
  fs.mkdirSync(buildsDir, { recursive: true });
  const tmpBase = path.join(buildsDir, `.tmp-${process.pid}-${Date.now()}`);
  const tmpDir = fs.mkdtempSync(tmpBase);
  const fileNames = {
    wuxin_self: 'wuxin_self.json',
    osu_domain: 'osu_domain.json',
    community_style: 'community_style.jsonl',
  };
  const filePaths = {};
  for (const collection of Object.keys(collections)) {
    const filePath = path.join(tmpDir, fileNames[collection]);
    if (collection === 'community_style') writeJsonLines(filePath, collections[collection]);
    else fs.writeFileSync(filePath, JSON.stringify(collections[collection], null, 2) + '\n', 'utf8');
    filePaths[collection] = filePath;
  }

  const collectionMeta = {};
  for (const collection of Object.keys(collections)) {
    collectionMeta[collection] = {
      docCount: collections[collection].length,
      sha256: sha256File(filePaths[collection]),
    };
  }
  const outputSha256 = sha256(Object.values(collectionMeta).map((m) => m.sha256).sort().join(''));

  const content = {
    schemaVersion: SCHEMA_VERSION,
    tokenizerVersion: TOKENIZER_VERSION,
    queryBuilderVersion: QUERY_BUILDER_VERSION,
    bm25: { k1: 1.2, b: 0.75, idf: 'log(1+(N-df+0.5)/(df+0.5))' },
    retrievalConfig: RETRIEVAL_CONFIG,
    collections: collectionMeta,
    outputSha256,
  };
  const contentSha = sha256(canonicalJson(content), 'utf8');
  const manifest = {
    content,
    build: {
      generatedAt: new Date().toISOString(),
      generatorGitCommit: gitShortCommit(),
    },
  };
  fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const finalDir = path.join(buildsDir, contentSha);
  if (!fs.existsSync(finalDir)) {
    fs.renameSync(tmpDir, finalDir);
  } else {
    assertSafeDeleteTarget(tmpDir, { base: buildsDir, label: '知识库构建临时目录' });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const currentTmp = `${currentPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(currentTmp, contentSha + '\n', 'utf8');
  fs.renameSync(currentTmp, currentPath);
  pruneOldBuilds(contentSha);

  console.log(JSON.stringify({
    ok: true,
    dataDir,
    knowledgeRoot,
    contentSha,
    docCounts: Object.fromEntries(Object.entries(collections).map(([k, v]) => [k, v.length])),
    communitySkipped: community.skipped.map((s) => `${s.id}:${s.reason}`),
    generatorGitCommit: manifest.build.generatorGitCommit,
  }, null, 2));
}

main();
