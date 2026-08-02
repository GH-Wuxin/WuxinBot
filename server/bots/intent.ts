// Pure intent classifier for osu! data queries.
// No DB access, no config reads, no side effects — only regex on the user's text.
//
// Returns a RequiredTool for clear data-retrieval requests (BP, recent, profile).
// Returns null when the message is analysis, memory recall, casual chat, or ambiguous.
// The LLM keeps full autonomy for anything this classifier does not claim.

export interface RequiredTool {
  toolName: 'query_osu';
  args: {
    capability: string;
    username?: string;
    bp_rank?: number;
    bp_start?: number;
    bp_end?: number;
    /** yumu official !bs style → compact five-column panel at ≥10 scores. */
    compact?: boolean;
  };
}

// yumu's official instruction family uses "bs" (e.g. !bs / bs 1-100) and
// renders ≥10 scores as a compact five-column panel. Ordinary "bp" queries
// keep yumu's QQ double-column layout.
function usesOfficialBsStyle(text: string): boolean {
  return /(?:^|[^a-z0-9_])bs(?=$|[\d#\s])/i.test(String(text || ''));
}

// ── BP range extraction (pure regex, no external dependencies) ──

function extractBpRange(text: string): { bp_rank?: number; bp_start?: number; bp_end?: number } | null {
  const match = /(?:BP|BS)\s*#?\s*(\d{1,3})(?:\s*(?:-|~|到|至)\s*(?:BP\s*#?\s*)?(\d{1,3}))?(?!\d)/iu.exec(String(text || ''));
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : start;
  if (start < 1 || end > 100 || start > end) return null;
  if (start === end) return { bp_rank: start };
  return { bp_start: start, bp_end: end };
}

// ── Exclusion: analysis / memory / opinion ──
// When any of these keywords appear, the message is not a simple data lookup.
// We return null so the LLM handles it normally (may still choose to call tools).

const EXCLUDE_RE =
  /为什么|怎么(?:回事|办|样|搞|了)?|如何|分析|结构|原因|偏科|记得|记住|回忆|知道吗|知不知道|教(?:我|你)|推荐|建议|帮忙选|该不该|要不要|能不能|可以(?:吗|不)|算(?:了|吧)|不用|别查|不要查|不会|不行|不对|不准/;

function excluded(text: string): boolean {
  return EXCLUDE_RE.test(text);
}

// ── BP queries ──
// "bp"/"bs" must be followed by a digit, #, whitespace, or end-of-string.
// This naturally excludes compound words like "bp结构" or "bp偏科".

const BP_PATTERNS: RegExp[] = [
  // "看看我bp1" "查一下我的bp" "帮查bp" "show my bp" "!bs 1-100"
  /(?:看看|看|查|查查|查一下|查下|搜|搜搜|搜一下|显示|展示|查看|帮我查|帮我看看|帮查|帮看|拉一下|拉下|来一张|来张|给一张|给张|show|get|fetch)(?:一下|一哈|下)?\s*(?:我(?:的|最近|最新)?)?\s*(?:bp|bs)(?=[\d#\s]|$)/i,
  // "我的bp1" "我的bp" "我的bs"
  /(?:我(?:的|最近|最新)?)\s*(?:bp|bs)(?=[\d#\s]|$)/i,
  // Standalone "bp1" "bp #1" "bp1-10" "!bs 1-100"
  /^\s*[!/]?\s*(?:bp|bs)\s*#?\s*\d{1,3}(?:\s*(?:-|~|到|至)\s*\d{1,3})?\s*$/i,
  // "my bp" "my bs"
  /\bmy\s+(?:bp|bs)(?=[\d#\s]|$)/i,
];

function hasBpIntent(text: string): boolean {
  return BP_PATTERNS.some((re) => re.test(text));
}

// ── Recent queries ──

// Word-end anchor: prevents matching prefixes of English words (info↛information)
// while allowing Chinese characters (\W in JS regex) to terminate the match.
const _E = '(?![a-zA-Z0-9_])';

const RECENT_PATTERNS: RegExp[] = [
  // "看看我最近一次成绩" "查一下我的recent" "帮我查recent" "最近成绩"
  new RegExp(`(?:看看|看|查|查查|查一下|查下|搜|搜搜|搜一下|显示|查看|帮我查|帮我看看|帮查|show|get)(?:一下|一哈|下)?\\s*(?:我(?:的)?)?\\s*(?:最近(?:一次|的|几[次个])?|最新(?:一次|的)?)?\\s*(?:成绩|recent)${_E}`, 'i'),
  // "看看我最近的recent" "show my recent"
  new RegExp(`(?:看看|看|查|查查|查一下|查下|搜|显示|查看|帮我查|帮我看看|show|get)(?:一下|一哈|下)?\\s*(?:我(?:的)?)?\\s*(?:最近|最新)?\\s*recent${_E}`, 'i'),
  // "我的recent" "我的re"
  new RegExp(`我(?:的)?\\s*(?:recent|re)${_E}`, 'i'),
  // "看看我的re" "查我的re"
  new RegExp(`(?:看看|看|查|查查|查一下|查下|搜|显示|查看|帮我查|帮我看看|show|get)(?:一下|一哈|下)?\\s*(?:我(?:的)?)?\\s*re${_E}`, 'i'),
  // Bare "最近成绩" — no action verb needed when temporal keyword is explicit
  /(?:最近(?:一次|的|几[次个])?|最新(?:一次|的)?)\s*成绩/,
];

function hasRecentIntent(text: string): boolean {
  return RECENT_PATTERNS.some((re) => re.test(text));
}

// ── Profile / Info queries ──

const PROFILE_PATTERNS: RegExp[] = [
  // "看看我的玩家资料" "查一下我的info" "查我的osu资料"
  new RegExp(`(?:看看|看|查|查查|查一下|查下|搜|搜搜|搜一下|显示|查看|帮我查|帮我看看|帮查|show|get)(?:一下|一哈|下)?\\s*(?:我(?:的)?)?\\s*(?:玩家资料|osu资料|个人信息|info|信息卡|资料卡|玩家信息|profile|osu信息)${_E}`, 'i'),
  // "我的info" "我的玩家资料"
  new RegExp(`我(?:的)?\\s*(?:玩家资料|osu资料|个人信息|info|信息卡|资料卡|玩家信息|profile|osu信息)${_E}`, 'i'),
];

function hasProfileIntent(text: string): boolean {
  return PROFILE_PATTERNS.some((re) => re.test(text));
}

// ── Recommend queries ──
// "推图 / 推荐谱面 / 荐图 / 打什么图 / 有没有适合我的图" are unambiguous
// recommendation requests. Analysis-flavored variants ("你觉得我适合打什么图",
// "建议我打什么") stay with the LLM.

const RECOMMEND_PATTERNS: RegExp[] = [
  /推(?:一|几|两|点|张)?图/,
  /推荐/,
  /荐图/,
  /打什么图/,
  /有没有(?:适合我的|我能打的|什么)图/,
  /有什么(?:图|谱面|歌)(?:推荐|可以打|能打)/,
  /推荐的(?:图|谱面|歌)/,
  /来(?:一|几|两)?张(?:图|谱面)/,
  /找(?:一|几|两)?张(?:图|谱面)/,
];

function hasRecommendIntent(text: string): boolean {
  if (/你觉得|我该|我应该|应该|建议|分析|怎么提升|如何提升|怎么样|适合打什么/.test(text)) return false;
  if (/这(?:张|个|首)(?:图|谱面|歌)/.test(text)) return false;
  return RECOMMEND_PATTERNS.some((re) => re.test(text));
}

function extractRecommendUsername(text: string): string {
  const match = /(?:给|为|帮)([A-Za-z0-9_\[\] .'-]{2,24}?)(?:推|推荐|荐|打什么图|找|来)/.exec(text);
  if (!match) return '';
  const username = match[1].trim();
  if (!username || /你|我|他|她|它/.test(username)) return '';
  return username;
}

// ── Public API ──

/**
 * Detect whether the user's message is a clear, unambiguous request for osu! data.
 * Only matches direct retrieval ("show me my BP1"), not analysis or memory questions.
 *
 * Returns a RequiredTool descriptor when the intent is clear; null otherwise.
 * The caller is responsible for checking tool availability before execution.
 */
export function detectRequiredOsuTool(userText: string): RequiredTool | null {
  const text = String(userText || '').trim();
  if (!text) return null;

  // Strip CQ codes — they're not part of the user's natural language
  const clean = text.replace(/\[CQ:[^\]]+\]/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return null;

  if (hasRecommendIntent(clean)) {
    const username = extractRecommendUsername(clean);
    return {
      toolName: 'query_osu',
      args: { capability: 'recommend', ...(username ? { username } : {}) },
    };
  }

  if (excluded(clean)) return null;

  if (hasBpIntent(clean)) {
    const range = extractBpRange(clean);
    const args: RequiredTool['args'] = { capability: 'bp', ...(range || {}) };
    if (usesOfficialBsStyle(clean)) args.compact = true;
    return {
      toolName: 'query_osu',
      args,
    };
  }

  if (hasRecentIntent(clean)) {
    return { toolName: 'query_osu', args: { capability: 'recent' } };
  }

  if (hasProfileIntent(clean)) {
    return { toolName: 'query_osu', args: { capability: 'info' } };
  }

  return null;
}

// ── Named-bot invocation detection ──
// A user explicitly names a specific bot to perform an action ("用猫猫查…",
// "调用LazyBot", "猫猫，帮我…"). This is a bot-harness request, NOT a web
// search — routing must check it before search interception. Pure function:
// bot list is passed in (from the registry), no DB access here.

export interface NamedBotRequest {
  botId: string;
  botName: string;
}

const BOT_INVOKE_PREFIX =
  /(?:用|叫|让|喊|找|请|麻烦|拜托|使用|调用|召唤|切换|换成|换用)/i;
// After a named bot we expect an action verb, punctuation, whitespace, or EOS.
const BOT_ACTION_AFTER = '(?:[\\s，,。！？!?：:]|查|看|帮|在|来|上|说|会|能)';

export function detectNamedBotRequest(
  userText: string,
  bots: { id: string; name: string }[]
): NamedBotRequest | null {
  const text = String(userText || '').trim();
  if (!text || !bots.length) return null;

  const names = new Set<string>();
  for (const b of bots) {
    names.add(b.id);
    names.add(b.name);
  }
  const alts = Array.from(names)
    .filter(Boolean)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length);
  if (!alts.length) return null;
  const joined = alts.join('|');

  // "用猫猫查一下…" "调用LazyBot" "让雨沐看看"
  const invoked = new RegExp(
    `(?:用|叫|让|喊|找|请|麻烦|拜托|使用|调用|召唤|切换|换成|换用)\\s*(${joined})(?=${BOT_ACTION_AFTER}|$)`,
    'i'
  ).exec(text);
  if (invoked) {
    const bot = matchBotByIdOrName(bots, invoked[1]);
    if (bot) return { botId: bot.id, botName: bot.name };
  }

  // Direct address: "猫猫，帮我…" "猫猫在吗" "LazyBot查一下"
  const addressed = new RegExp(
    `(^|[\\s，,。！？!?：:])(${joined})(?=${BOT_ACTION_AFTER}|$)`,
    'i'
  ).exec(text);
  if (addressed) {
    const bot = matchBotByIdOrName(bots, addressed[2]);
    if (bot) return { botId: bot.id, botName: bot.name };
  }

  return null;
}

function matchBotByIdOrName(
  bots: { id: string; name: string }[],
  raw: string
): { id: string; name: string } | undefined {
  const target = String(raw || '').trim().toLocaleLowerCase();
  return bots.find(
    (b) => b.id.toLocaleLowerCase() === target || b.name.toLocaleLowerCase() === target
  );
}

// ── BP type analysis (proportion) detection ──
// "分析我的bp类型" "串图占比如何" — these need real beatmap classification
// (osu!oracle on Top100). Until that is wired into natural language, the LLM
// must NOT fabricate proportions from PP+ dimensions alone. Callers intercept
// this before the LLM sees the message.

export function detectBpTypeAnalysisIntent(userText: string): boolean {
  const text = String(userText || '').trim();
  if (!text) return false;
  return BP_TYPE_ANALYSIS_PATTERNS.some((re) => re.test(text));
}

const BP_TYPE_ANALYSIS_PATTERNS: RegExp[] = [
  // "分析我的bp类型" "看看我的BP占比" "总结一下BP结构"
  /(?:分析|看看|看一下|讲讲|说说|评价|判断|总结|评估|描述|形容)(?:一下|我的|你的|下)?\s*(?:bp|best\s*performance)\s*(?:类型|占比|组成|结构|风格)/i,
  // "我的BP是什么类型" "BP构成" "bp的类型"
  /(?:我的|我|我们的|你)?\s*(?:bp|best\s*performance)\s*(?:是\s*什么|的)?\s*(?:类型|占比|组成|结构|风格)/i,
  // "串图占比如何" "跳图有多少" "aim图比例"
  /(?:串图|跳图|耐力图|速度图|aim|stream|tech|alt)(?:图)?\s*有?\s*(?:占比|多少|比例|如何|怎样|有几张|几张|偏|多|少)/i,
];
