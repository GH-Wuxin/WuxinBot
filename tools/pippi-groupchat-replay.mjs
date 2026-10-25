/*
 * Pippi group-chat replay / scoring harness.
 *
 * This intentionally stops before OneBot delivery.  In live mode it calls the
 * configured provider in an isolated DATA_DIR, but it never calls
 * processIncoming() or sendMessage().  The only outbound traffic is the LLM
 * request itself.  A real QQ smoke message, if ever needed, remains a
 * separate operator action restricted to group 1083681153.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildPippiCases,
  PIPPI_GROUPCHAT_CASE_COUNT,
  PIPPI_GROUPCHAT_SOURCE_IDS,
} from './fixtures/pippi-groupchat-cases-v1.mjs';

function parseArgs(argv) {
  const args = {
    mode: 'offline',
    split: 'all',
    round: 'R0',
    limit: null,
    out: '',
    sourceData: '',
    rewrite: true,
    keepTemp: false,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--no-rewrite') args.rewrite = false;
    else if (token === '--keep-temp') args.keepTemp = true;
    else if (token.startsWith('--')) {
      const segments = token.slice(2).split('-');
    const key = segments[0] + segments.slice(1)
      .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
      .join('');
      const value = argv[index + 1];
      if (value && !value.startsWith('--')) {
        args[key] = value;
        index += 1;
      } else {
        args[key] = true;
      }
    }
  }
  args.mode = String(args.mode || 'offline').toLowerCase();
  args.split = String(args.split || 'all').toLowerCase();
  args.round = String(args.round || 'R0');
  if (args.limit !== null) args.limit = Math.max(1, Number(args.limit) || 1);
  return args;
}

function usage() {
  return [
    'Usage:',
    '  node --import tsx tools/pippi-groupchat-replay.mjs --mode offline --round R0',
    '  node --import tsx tools/pippi-groupchat-replay.mjs --mode live --source-data <db.json> --round R1',
    '',
    'Options:',
    '  --mode offline|live       offline uses deterministic mock replies; live calls the configured provider',
    '  --split all|train|dev|holdout',
    '  --round R0                result label',
    '  --limit N                 useful for a short provider smoke run',
    '  --sources r01,c05,s01     only these scenarios (for a human review sheet)',
    '  --variant 1,2             only these paraphrase indices (keeps an arm short and fair)',
    '  --source-data <path>      production db.json used only for provider/persona settings',
    '  --kb-source <dir>         knowledge dir (or a data dir containing one) to test in isolation',
    '  --no-rewrite              do not exercise the existing normal-reply rewrite path',
    '  --out <path>              JSON result path; default is artifacts/pippi-groupchat-<round>-<mode>.json',
    '  --keep-temp               keep isolated replay DATA_DIR for inspection',
  ].join('\n');
}

const args = parseArgs(process.argv);
if (args.help || !['offline', 'live'].includes(args.mode)) {
  console.log(usage());
  if (args.help) process.exit(0);
  process.exit(2);
}

const allCases = buildPippiCases();
if (allCases.length !== PIPPI_GROUPCHAT_CASE_COUNT || allCases.length < 200 || allCases.length > 300) {
  throw new Error(`Unexpected replay case count: ${allCases.length}`);
}

function splitForSource(sourceId) {
  // Keep all six paraphrases of one underlying conversation in one split.
  // This prevents paraphrases of the same scenario leaking into holdout.
  const sourceIndex = PIPPI_GROUPCHAT_SOURCE_IDS.indexOf(sourceId);
  if (sourceIndex < 0) throw new Error(`Unknown source scenario: ${sourceId}`);
  const bucket = sourceIndex % 5;
  if (bucket === 0) return 'holdout';
  if (bucket === 1) return 'dev';
  return 'train';
}

// ── Provenance ──
//
// R0 has to pin what produced the numbers: same commit, same model, same
// temperature, same prompt snapshot, same fixture.  Without this block two
// rounds cannot be compared honestly, because a silent prompt or fixture edit
// looks exactly like a style improvement.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

function gitState() {
  const run = (gitArgs) => {
    const result = spawnSync('git', gitArgs, { encoding: 'utf8', cwd: repoRoot });
    return result.status === 0 ? String(result.stdout).trim() : null;
  };
  const porcelain = run(['status', '--porcelain']);
  return {
    commit: run(['rev-parse', 'HEAD']),
    short: run(['rev-parse', '--short', 'HEAD']),
    branch: run(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirty: Boolean(porcelain),
    dirtyFiles: porcelain ? porcelain.split('\n').filter((line) => line.trim()).length : 0,
  };
}

function promptSnapshotSha(records) {
  // Hash the assembled system prompts of this run, in case order, so a prompt
  // edit is visible in the result file even when the diff was not committed.
  const hash = crypto.createHash('sha256');
  for (const record of records) hash.update(String(record.prompt?.systemSha || ''));
  return hash.digest('hex');
}

// ── Provider transient-error retry ──
//
// The Codex app-server intermittently rejects a call with a transient
// capacity/timeout error.  That is infrastructure noise, not Pippi behaviour:
// without retrying, `modelErrorRate` would mix a busy backend into the style
// comparison and a round could be judged on samples that never produced text.
// Only clearly transient failures are retried; a genuine refusal or an empty
// reply is recorded as-is so it still counts against the round.
// Plain substring markers, compared case-insensitively.  Kept as a literal
// list rather than a compiled pattern on purpose: this file's rule is that
// nothing on the judgement path pattern-matches text.
const TRANSIENT_PROVIDER_MARKERS = [
  'at capacity', 'overloaded', 'rate limit', 'too many requests',
  'temporarily unavailable', 'please try again',
  'timed out', 'timeout', '超时',
  'econnreset', 'econnrefused', 'socket hang up', 'network', '网络',
];

function isTransientProviderError(message) {
  const lower = String(message || '').toLowerCase();
  return TRANSIENT_PROVIDER_MARKERS.some((marker) => lower.includes(marker));
}

async function completeChatRetrying(deps, db, options, maxAttempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await deps.completeChat(db, options);
      return { result, attempts: attempt, error: null };
    } catch (providerError) {
      lastError = providerError;
      const message = String(providerError?.message || providerError);
      if (attempt >= maxAttempts || !isTransientProviderError(message)) break;
      // Linear backoff: give a saturated backend a moment instead of hammering it.
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
  return { result: null, attempts: maxAttempts, error: lastError };
}

// `--sources r01,c05,s01` and `--variant 1` exist for one reason: a human
// review sheet needs breadth, not six paraphrases of the same conversation.
// Without them the only way to show 15 scenarios was to run 90 cases.
const sourceFilter = args.sources
  ? new Set(String(args.sources).split(',').map((value) => value.trim()).filter(Boolean))
  : null;
// Accepts one index or a comma list: an arm needs a few paraphrases per
// scenario to average out model noise, but not all six on every scenario.
const variantFilter = args.variant === undefined || args.variant === true
  ? null
  : new Set(String(args.variant).split(',').map((value) => value.trim()).filter(Boolean));

const selectedCases = allCases
  .map((item, index) => ({ ...item, replayIndex: index, split: splitForSource(item.sourceId) }))
  .filter((item) => !sourceFilter || sourceFilter.has(item.sourceId))
  .filter((item) => !variantFilter || variantFilter.has(String(item.variant)))
  .filter((item) => args.split === 'all' || item.split === args.split)
  .slice(0, args.limit || Number.MAX_SAFE_INTEGER);

const replayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-pippi-replay-'));
process.env.DATA_DIR = replayDir;

// A knowledge-base build is content addressed and read from DATA_DIR, so a
// candidate index can be exercised without installing it into the production
// data dir.  Without this the only way to test a rebuilt index would be to
// switch it on for real users first -- the wrong order.
if (args.kbSource) {
  const source = path.resolve(String(args.kbSource));
  if (!fs.existsSync(source)) throw new Error('--kb-source does not exist: ' + source);
  const knowledge = fs.existsSync(path.join(source, 'knowledge')) ? path.join(source, 'knowledge') : source;
  fs.cpSync(knowledge, path.join(replayDir, 'knowledge'), { recursive: true });
  console.log('[pippi-replay] kb-source copied from ' + knowledge);
}

const {
  ensureStore,
  readDb,
  writeDb,
} = await import('../server/store.ts');
const {
  buildPrompt,
  responseOptionsFor,
} = await import('../server/bot/prompt.ts');
const {
  buildPippiPrompt,
} = await import('../server/bot/persona.ts');
const {
  decideReply,
} = await import('../server/bot.ts');
const {
  isWeirdReply,
  sanitizeReply,
  splitReplySegments,
  rewriteNormalReply,
} = await import('../server/bot/reply.ts');
const {
  completeChat,
} = await import('../server/bot/llm.ts');

function readSourceDb(sourcePath) {
  if (!sourcePath) return null;
  const rawFile = fs.readFileSync(path.resolve(sourcePath), 'utf8');
  // Strip a leading BOM without a pattern match.
  const raw = rawFile.charCodeAt(0) === 0xfeff ? rawFile.slice(1) : rawFile;
  return JSON.parse(raw);
}

function copyReplaySettings(target, source, mode) {
  const sourceSettings = source?.settings || {};
  const settings = target.settings;
  const safeKeys = [
    'llmProvider', 'apiKey', 'apiBaseUrl', 'deepseekApiKey', 'deepseekApiBaseUrl',
    'mimoApiKey', 'mimoApiBaseUrl', 'codexExecutable', 'codexModel',
    'codexReasoningEffort', 'codexTimeoutMs', 'codexFallbackProvider',
    'codexFallbackModel', 'model', 'temperature', 'maxTokens', 'visionMode',
    'visionImageTransport', 'visionMaxImages', 'visionMaxImageBytes',
    'visionImageTimeoutMs', 'osuSearchEnabled',
    'groupContextSearchEnabled',
    'groupContextSearchPoolSize', 'groupContextSearchMaxExtra', 'groupContextSearchCharBudget',
    'personaPromptSections', 'personaModulePrompts', 'personalityPrompt', 'botNames',
    'kb',
  ];
  for (const key of safeKeys) {
    if (Object.prototype.hasOwnProperty.call(sourceSettings, key)) settings[key] = sourceSettings[key];
  }

  // Never allow the replay to reuse production participation, owner identity,
  // or fallback behaviour.  The live provider itself is preserved; only its
  // data-store side effects are isolated.
  settings.globalPaused = false;
  settings.onlyMentionMode = false;
  // With an injected index the whole point is to compare KB on against KB off,
  // so the replay must not silently inherit a switched-off collection set.
  if (args.kbSource) {
    settings.kb = {
      enabled: true,
      collections: { wuxinSelf: true, osuDomain: true, communityStyle: true },
      rollout: { mode: 'all', groupIds: [], privateMessagesEnabled: true },
    };
  }
  settings.ownerQq = '';
  settings.selfQq = '9000';
  settings.externalBotQqs = '';
  settings.enableAutoModel = false;
  settings.codexFallbackEnabled = false;
  settings.replyGateNaturalThreshold = 45;
  settings.replyGateLightThreshold = 70;
  settings.groupContextSearchEnabled = false;
  settings.memoryEnabled = false;
  settings.groupProfileAutoUpdate = false;
  settings.levelUpNotifyEnabled = false;
  settings.stickerPolicy = { mode: 'off', allGroups: false, groupIds: [] };

  if (mode === 'offline') {
    settings.llmProvider = 'openai-compatible';
    settings.apiBaseUrl = 'http://127.0.0.1:9/v1';
    settings.apiKey = 'offline-fixture';
    settings.model = 'offline-fixture';
  } else if (!settings.llmProvider) {
    throw new Error('Live replay needs a provider in --source-data');
  }
  return settings;
}

function contextMessage(text, index, createdAt) {
  const value = String(text || '').trim();
  const fullWidth = value.indexOf('：');
  const halfWidth = value.indexOf(':');
  const separator = fullWidth < 0 ? halfWidth : (halfWidth < 0 ? fullWidth : Math.min(fullWidth, halfWidth));
  const speaker = (separator > 0 ? value.slice(0, separator) : '').trim() || '群友';
  const content = (separator > 0 ? value.slice(separator + 1) : value).trim() || value;
  const speakerKey = speaker.toLowerCase();
  const isBot = speakerKey === 'pippi' || speaker === '皮皮';
  const userId = isBot ? 'bot' : `speaker-${speaker}`;
  return {
    id: `history-${index}`,
    sourceMessageId: `history-${index}`,
    role: isBot ? 'assistant' : 'user',
    type: 'group',
    groupId: 'replay',
    userId,
    nickname: speaker,
    content,
    inContext: true,
    createdAt,
  };
}

function buildEvent(item) {
  const isPrivate = item.channel === 'private';
  return {
    source: 'gui',
    type: isPrivate ? 'private' : 'group',
    messageId: `replay-${item.id}`,
    groupId: isPrivate ? 'private' : 'replay',
    userId: 'speaker-current',
    nickname: '当前群友',
    text: item.message,
    atTargets: item.mentioned ? ['9000'] : [],
    images: [],
    raw: {},
  };
}

function buildPolicy() {
  return {
    policy: 'normal',
    attentionLevel: 3,
    allowCommands: false,
    customPrompt: '',
  };
}

function buildGroup(item) {
  return item.channel === 'private'
    ? { groupId: 'private', name: '私聊', enabled: true, mode: 'natural', maxPerHour: 1000, cooldownSec: 0 }
    : { groupId: 'replay', name: '匿名回放群', enabled: true, mode: 'natural', maxPerHour: 1000, cooldownSec: 0 };
}

function installCaseContext(db, item) {
  const now = Date.now();
  db.groups = [{ groupId: 'replay', name: '匿名回放群', enabled: true, mode: 'natural', maxPerHour: 1000, cooldownSec: 0 }];
  db.users = [];
  db.groupProfiles = [];
  db.relationshipProfiles = [];
  db.memories = [];
  db.messages = item.context.map((text, index) => contextMessage(
    text,
    index,
    new Date(now - (item.context.length - index + 1) * 30_000).toISOString(),
  ));
  db.decisions = [];
  db.toolCallLogs = [];
  return db;
}

function mockReply(item) {
  if (item.replyExpectation === 'silent') return '';
  if (item.category === 'gate') return '在';
  if (item.category === 'long_form' && item.sourceId === 'l01') {
    return '那就写一个从夜里开图开始的故事：玩家在停电的房间里点亮屏幕，节奏声成了唯一的光。随着谱面越来越难，他发现自己真正要追的不是分数，而是终于敢把最后一段打完的那一刻。';
  }
  if (item.category === 'long_form') return '停电之后，城市安静了下来。她借着屏幕最后一点亮光继续敲下去，故事没有停在最方便的地方，而是让人物带着刚刚得到的线索走进了下一段黑暗。';
  if (item.category === 'technical') return '先看请求是否真的发出，再看响应状态、耗时和服务端日志；现在还不能只凭“变慢”断定是网络。';
  if (item.category === 'quick_qa') return '不是一回事：FC是不断连，SS还要求所有判定都是最高级。';
  if (item.category === 'serious' || item.category === 'serious_context') return '怎么了？先别急着扛着，愿意说的话我听着。';
  if (item.category === 'identity') return '我是pippi啊，突然问这个干嘛。';
  if (item.category === 'osu_tool') return '这个要先查真实数据，不能靠猜。';
  if (item.category === 'gate') return '';
  return '嗯？这也太巧了吧。';
}

// Plain character helpers.  This file deliberately contains no pattern
// matching: a sample's verdict must never depend on whether its wording
// happened to fit an expression someone wrote down.
function isSpaceChar(character) {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r'
    || character === '\f' || character === '\v' || character === '\u00a0' || character === '\u3000';
}

function stripCqCodes(text) {
  const value = String(text || '');
  let out = '';
  let index = 0;
  while (index < value.length) {
    if (value.startsWith('[CQ:', index)) {
      const end = value.indexOf(']', index);
      if (end > index) { index = end + 1; continue; }
    }
    out += value[index];
    index += 1;
  }
  return out;
}

function stripSpaces(text) {
  let out = '';
  for (const character of String(text || '')) {
    if (!isSpaceChar(character)) out += character;
  }
  return out;
}

function visibleLength(text) {
  return stripSpaces(stripCqCodes(text)).length;
}

const SENTENCE_ENDERS = '。！？!?\n';

function sentenceCount(text) {
  const value = String(text || '').trim();
  if (!value) return 0;
  let count = 0;
  let pending = false;
  for (const character of value) {
    if (SENTENCE_ENDERS.includes(character)) {
      if (pending) count += 1;
      pending = false;
    } else if (!isSpaceChar(character)) {
      pending = true;
    }
  }
  if (pending) count += 1;
  return count || 1;
}

// Literal marker lists, not patterns.  These cover wording that is wrong in
// every context (customer-service voice, leaked internals), which is a
// different job from judging whether a reply sounds like a group member --
// that verdict belongs to the blind judge.
const GLOBAL_TEMPLATE_MARKERS = [
  ['assistant_template', [
    '作为一个ai', '作为一个人工智能', '作为一个语言模型',
    '作为一名ai', '作为一名人工智能', '作为一名语言模型',
    '我可以帮助你', '请问有什么我可以', '您好',
    '下面我将', '下面我来', '综上所述', '竭诚为您服务',
  ]],
  ['internal_leak', [
    '系统提示', '提示词', '人格模块', '后台规则', '内部推理', '配置里写', 'owner', '源代码',
  ]],
  ['forced_advice', [
    '建议你制定', '建议立即', '请注意劳逸结合', '从长远来看', '保持练习一定',
  ]],
];

function findTemplateLabel(text) {
  const lower = String(text || '').toLowerCase();
  for (const [label, markers] of GLOBAL_TEMPLATE_MARKERS) {
    if (markers.some((marker) => lower.includes(marker))) return label;
  }
  return null;
}

// Punctuation and space folding for fact comparison.  Character-set based,
// no pattern matching: deciding "is this fact present" is a containment
// question, not a matching one.
const COMPARE_IGNORED_CHARS = new Set([
  ...' \t\n\r\f\v',
  '，', '。', '！', '？', '、', '…', '~', '～', ',', '.', '!', '?',
  '[', ']', '【', '】', '「', '」', '『', '』', '"', "'", '“', '”', '‘', '’',
  '(', ')', '（', '）', '\u00a0', '\u3000',
]);

function normalizedForCompare(value) {
  let out = '';
  for (const character of String(value || '')) {
    if (!COMPARE_IGNORED_CHARS.has(character)) out += character;
  }
  return out.toLowerCase();
}

function evaluate(item, record) {
  const failures = [];
  const warnings = [];
  const expectedReply = item.replyExpectation === 'must';
  const optional = item.replyExpectation === 'silent_or_optional';
  const actualReply = Boolean(record.decision?.shouldReply);
  const finalText = String(record.finalText || '');

  if (expectedReply && !actualReply) failures.push('wrong_gate');
  if (item.replyExpectation === 'silent' && actualReply) failures.push('wrong_gate');
  if (expectedReply && actualReply && !finalText.trim() && !record.error) failures.push('empty_reply');
  if (!expectedReply && !optional && !actualReply && record.error) failures.push('gate_error');
  if (optional && actualReply && !finalText.trim() && !record.error) failures.push('empty_reply');
  if (record.error) failures.push('model_error');

  for (const pattern of item.badPatterns || []) {
    if (finalText.includes(pattern)) failures.push('bad_pattern');
  }
  const templateLabel = findTemplateLabel(finalText);
  if (templateLabel) failures.push(templateLabel);

  const length = visibleLength(finalText);
  const shortChat = ['reaction', 'casual', 'banter', 'persona', 'rewrite_regression', 'context'].includes(item.category);
  const simpleQa = item.category === 'quick_qa';
  if (actualReply && shortChat && length > 70) warnings.push('too_verbose');
  if (actualReply && (item.category === 'reaction' || item.category === 'banter') && length > 90) failures.push('over_explain_joke');
  if (actualReply && simpleQa && length < 8) warnings.push('too_terse');
  if (actualReply && shortChat && record.segments.length > 1) warnings.push('multi_message_spam');
  if (record.rewritten && item.category === 'rewrite_regression') warnings.push('rewrite_false_positive');
  // Long-form tasks intentionally bypass the normal-chat rewrite guard. Their
  // size is exactly what makes isWeirdReply report `tooLong`; counting that as
  // an unrepaired casual failure would turn a deliberate long-form exception
  // into a false regression.
  if (record.isWeird && !record.rewritten && actualReply && !record.error
    && !record.responseOptions?.longForm) warnings.push('unrepaired_weird_reply');

  // `requiredFacts` are NOT strings to look for.  They are semantic criteria
  // -- "DT改变实际接近时间", "保留pippi身份", "不能把别人的成绩归给当前发言者".
  // Checking them by containment marked every one of them missing (all five
  // review samples failed on it while their answers were fine).  The harness
  // therefore keeps only literal checks: badPatterns are concrete phrasings
  // the plan wants avoided, and they stay here.  Semantic criteria travel to
  // the judge, which forwards them to the model as explicit questions.
  const naturalPenalty = failures.length * 30 + warnings.length * 6;
  const score = Math.max(0, 100 - naturalPenalty);
  return {
    pass: failures.length === 0,
    failures: [...new Set(failures)],
    warnings: [...new Set(warnings)],
    score,
    visibleLength: length,
    sentenceCount: sentenceCount(finalText),
  };
}

function emptyStats() {
  return {
    total: 0,
    gatePass: 0,
    hardPass: 0,
    scores: [],
    lengths: [],
    segments: [],
    rewrites: 0,
    weird: 0,
    errors: 0,
    failures: {},
    warnings: {},
    byCategory: {},
    // R3 needs group vs private measured separately: a casual-scene edit that
    // also shortens private deep talk is a regression the totals would hide.
    byChannel: {},
    latencyMs: [],
    totalTokens: 0,
  };
}

function addLabel(bucket, label) {
  bucket[label] = (bucket[label] || 0) + 1;
}

function addStats(stats, item, evaluation, record) {
  stats.total += 1;
  if (!evaluation.failures.includes('wrong_gate')) stats.gatePass += 1;
  if (evaluation.pass) stats.hardPass += 1;
  stats.scores.push(evaluation.score);
  if (record.finalText) stats.lengths.push(evaluation.visibleLength);
  stats.segments.push(record.segments.length);
  if (record.rewritten) stats.rewrites += 1;
  if (record.isWeird) stats.weird += 1;
  if (record.error) stats.errors += 1;
  for (const label of evaluation.failures) addLabel(stats.failures, label);
  for (const label of evaluation.warnings) addLabel(stats.warnings, label);
  stats.latencyMs.push(Number(record.latencyMs || 0));
  stats.totalTokens += Number(record.usage?.total_tokens || record.usage?.totalTokens || 0);
  const cat = stats.byCategory[item.category] ||= { total: 0, pass: 0, scores: [], lengths: [], segments: [], gatePass: 0 };
  cat.total += 1;
  if (evaluation.pass) cat.pass += 1;
  if (!evaluation.failures.includes('wrong_gate')) cat.gatePass += 1;
  cat.scores.push(evaluation.score);
  cat.segments.push(record.segments.length);
  if (record.finalText) cat.lengths.push(evaluation.visibleLength);

  const chan = stats.byChannel[item.channel] ||= { total: 0, pass: 0, gatePass: 0, scores: [], lengths: [], segments: [] };
  chan.total += 1;
  if (evaluation.pass) chan.pass += 1;
  if (!evaluation.failures.includes('wrong_gate')) chan.gatePass += 1;
  chan.scores.push(evaluation.score);
  chan.segments.push(record.segments.length);
  if (record.finalText) chan.lengths.push(evaluation.visibleLength);
}

/** Verbal tics: a 2-4 char expression reused across the paraphrases of one
 *  scenario.  The plan lists '口癖重复' as a soft metric, and repetition is
 *  only visible across variants, never inside one reply.  Input-derived
 *  n-grams are excluded so echoing the user's words does not count as a tic. */
function collectTics(results) {
  const bySource = new Map();
  for (const record of results) {
    if (!record.finalText || record.error) continue;
    const list = bySource.get(record.sourceId) || [];
    list.push(record);
    bySource.set(record.sourceId, list);
  }
  const tics = [];
  for (const [sourceId, records] of bySource) {
    if (records.length < 3) continue;
    const inputGrams = new Set();
    for (const record of records) {
      const text = normalizedForCompare(record.input);
      for (let i = 0; i + 2 <= text.length; i += 1) inputGrams.add(text.slice(i, i + 2));
    }
    const counts = new Map();
    for (const record of records) {
      const text = normalizedForCompare(record.finalText);
      const seen = new Set();
      for (let size = 2; size <= 4; size += 1) {
        for (let i = 0; i + size <= text.length; i += 1) {
          const gram = text.slice(i, i + size);
          if (inputGrams.has(gram) || seen.has(gram)) continue;
          seen.add(gram);
          const entry = counts.get(gram) || { variants: 0 };
          entry.variants += 1;
          counts.set(gram, entry);
        }
      }
    }
    const threshold = Math.max(3, Math.ceil(records.length / 2));
    for (const [gram, entry] of counts) {
      if (entry.variants >= threshold) tics.push({ sourceId, gram, variants: entry.variants, of: records.length });
    }
  }
  // Drop grams contained in a longer reported gram so the list stays readable.
  const sorted = tics.sort((a, b) => b.gram.length - a.gram.length || b.variants - a.variants);
  const kept = [];
  for (const tic of sorted) {
    if (kept.some((other) => other.sourceId === tic.sourceId && other.gram.includes(tic.gram))) continue;
    kept.push(tic);
  }
  return kept.sort((a, b) => b.variants - a.variants).slice(0, 40);
}

function summarizeBucket(bucket) {
  const visible = bucket.segments.filter((count) => count > 0);
  return {
    total: bucket.total,
    passRate: bucket.total ? Number((bucket.pass / bucket.total).toFixed(4)) : 0,
    gatePassRate: bucket.total ? Number((bucket.gatePass / bucket.total).toFixed(4)) : 0,
    meanScore: bucket.scores.length
      ? Number((bucket.scores.reduce((a, b) => a + b, 0) / bucket.scores.length).toFixed(2))
      : 0,
    lengthMedian: percentile(bucket.lengths, 0.5),
    lengthP90: percentile(bucket.lengths, 0.9),
    oneMessageRate: visible.length
      ? Number((visible.filter((count) => count <= 1).length / visible.length).toFixed(4))
      : 0,
  };
}

function percentile(values, p) {
  const list = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!list.length) return 0;
  const index = Math.min(list.length - 1, Math.max(0, Math.ceil(list.length * p) - 1));
  return list[index];
}

function summarizeStats(stats) {
  return {
    total: stats.total,
    gatePassRate: stats.total ? Number((stats.gatePass / stats.total).toFixed(4)) : 0,
    hardPassRate: stats.total ? Number((stats.hardPass / stats.total).toFixed(4)) : 0,
    qualityPassRate: stats.total > stats.errors
      ? Number((stats.hardPass / (stats.total - stats.errors)).toFixed(4))
      : 0,
    meanScore: stats.scores.length ? Number((stats.scores.reduce((a, b) => a + b, 0) / stats.scores.length).toFixed(2)) : 0,
    visibleLength: {
      median: percentile(stats.lengths, 0.5),
      p90: percentile(stats.lengths, 0.9),
      max: stats.lengths.length ? Math.max(...stats.lengths) : 0,
    },
    oneMessageRate: stats.segments.some((count) => count > 0)
      ? Number((stats.segments.filter((count) => count > 0 && count <= 1).length / stats.segments.filter((count) => count > 0).length).toFixed(4))
      : 0,
    rewriteRate: stats.total ? Number((stats.rewrites / stats.total).toFixed(4)) : 0,
    weirdRate: stats.total ? Number((stats.weird / stats.total).toFixed(4)) : 0,
    modelErrorRate: stats.total ? Number((stats.errors / stats.total).toFixed(4)) : 0,
    meanLatencyMs: stats.latencyMs.length ? Math.round(stats.latencyMs.reduce((a, b) => a + b, 0) / stats.latencyMs.length) : 0,
    totalTokens: stats.totalTokens,
    failures: stats.failures,
    warnings: stats.warnings,
    byCategory: Object.fromEntries(
      Object.entries(stats.byCategory).map(([category, value]) => [category, summarizeBucket(value)]),
    ),
    byChannel: Object.fromEntries(
      Object.entries(stats.byChannel).map(([channel, value]) => [channel, summarizeBucket(value)]),
    ),
    // PLAN v1.0 soft targets, evaluated only over ordinary casual replies.
    // Explanation-shaped categories (quick_qa / technical / long_form /
    // serious* / osu_tool / identity) are exempt by the plan, and `gate` is a
    // participation metric rather than a length one, so none of them belong in
    // this denominator.  Freezing the numbers here stops a round from quietly
    // redefining "short enough" after seeing the results.
    casualTargets: summarizeCasualTargets(stats),
    // Failure-type distribution for locating the next round's target comes
    // from tools/pippi-groupchat-judge.mjs, where a model assigns the plan's
    // labels.  Nothing here pattern-matches wording to guess at it.
  };
}

const CASUAL_LENGTH_CATEGORIES = new Set(['reaction', 'casual', 'banter', 'persona', 'context', 'rewrite_regression']);

function summarizeCasualTargets(stats) {
  const chosen = Object.entries(stats.byCategory).filter(([category]) => CASUAL_LENGTH_CATEGORIES.has(category));
  const lengths = chosen.flatMap(([, value]) => value.lengths);
  const segments = chosen.flatMap(([, value]) => value.segments).filter((count) => count > 0);
  const median = percentile(lengths, 0.5);
  const p90 = percentile(lengths, 0.9);
  const oneMessageRate = segments.length
    ? Number((segments.filter((count) => count <= 1).length / segments.length).toFixed(4))
    : 0;
  return {
    sample: lengths.length,
    median: { value: median, target: '10-35', pass: median >= 10 && median <= 35 },
    p90: { value: p90, target: '<=70', pass: p90 <= 70 },
    oneMessageRate: { value: oneMessageRate, target: '>=0.90', pass: oneMessageRate >= 0.9 },
  };
}

async function runOne(item, baseDb, deps) {
  const started = Date.now();
  const db = installCaseContext(structuredClone(baseDb), item);
  writeDb(db);
  const liveDb = readDb();
  const event = buildEvent(item);
  const group = buildGroup(item);
  const userPolicy = buildPolicy();
  const decision = item.channel === 'private'
    ? { shouldReply: true, reason: '私聊消息（回放固定允许主回复）' }
    : await deps.decideReply({
      db: liveDb,
      group,
      userPolicy,
      text: event.text,
      mentioned: item.mentioned,
      userId: event.userId,
      images: [],
    });
  const promptMessages = buildPrompt(liveDb, group, event, userPolicy);
  const responseOptions = responseOptionsFor(event, liveDb, userPolicy);
  let rawText = '';
  let finalText = '';
  let rewritten = false;
  let rewriteError = '';
  let error = '';
  let usage = null;
  let providerAttempts = 0;

  if (decision.shouldReply) {
    if (args.mode === 'offline') {
      rawText = mockReply(item);
    } else {
      // Tool cases are covered by the existing tool-contract suite.  A plain
      // conversation completion without tool schemas would test the provider's
      // refusal wording rather than Pippi's conversational style.
      if (item.category !== 'osu_tool') {
        try {
          const outcome = await completeChatRetrying(deps, readDb(), {
            messages: promptMessages,
            model: responseOptions.overrideModel || readDb().settings.model,
            overrideModel: responseOptions.overrideModel,
            maxTokens: responseOptions.maxTokens,
            temperature: readDb().settings.temperature,
            timeoutMs: Number(readDb().settings.codexTimeoutMs || 90_000),
            label: `Pippi replay ${args.round}`,
            traceRole: 'conversation',
            tracePurpose: 'conversation_reply',
          });
          providerAttempts = outcome.attempts;
          if (outcome.error) throw outcome.error;
          rawText = String(outcome.result?.text || '');
          usage = outcome.result?.usage || null;
        } catch (providerError) {
          error = String(providerError?.message || providerError);
        }
      } else {
        rawText = '[TOOL_CASE_NOT_EXECUTED_IN_STYLE_REPLAY]';
      }
    }
    finalText = deps.sanitizeReply(rawText, liveDb.settings);
    const weird = deps.isWeirdReply(finalText);
    if (weird && args.rewrite && item.category !== 'osu_tool' && !responseOptions.longForm && !error) {
      try {
        const rewrittenResult = await deps.rewriteNormalReply(readDb(), finalText, event, {
          turnId: `replay-${item.id}`,
        });
        const nextText = deps.sanitizeReply(rewrittenResult?.text || finalText, readDb().settings);
        rewritten = nextText !== finalText;
        finalText = nextText;
        usage = rewrittenResult?.usage || usage;
      } catch (rewriteProviderError) {
        rewriteError = String(rewriteProviderError?.message || rewriteProviderError);
      }
    }
  }

  const isWeird = deps.isWeirdReply(finalText);
  const segments = deps.splitReplySegments(finalText).slice(0, 3);
  const record = {
    id: item.id,
    sourceId: item.sourceId,
    variant: item.variant,
    split: item.split,
    category: item.category,
    channel: item.channel,
    input: item.message,
    context: item.context,
    replyExpectation: item.replyExpectation,
    // Passed through to the judge, which turns each one into a question.
    requiredFacts: item.requiredFacts || [],
    badPatterns: item.badPatterns || [],
    decision,
    responseOptions: {
      longForm: responseOptions.longForm,
      score: responseOptions.score,
      maxTokens: responseOptions.maxTokens,
    },
    prompt: {
      messageCount: promptMessages.length,
      systemChars: String(promptMessages[0]?.content || '').length,
      userChars: String(promptMessages.at(-1)?.content || '').length,
      sceneHasCasual: String(promptMessages[0]?.content || '').includes('当前场景：日常聊天。'),
      // R3 axis: the short-form guide is conditional, so a round must be able to
      // show whether it was actually injected for a given case.
      hasCasualFormGuide: String(promptMessages[0]?.content || '').includes('【群聊形态】'),
      hasSpeakerBoundary: String(promptMessages[0]?.content || '').includes('【多说话人事实归属】'),
      // Hash of the assembled system prompt.  Lets a round prove whether the
      // prompt actually changed, and lets the result file carry the snapshot
      // even when the edit was never committed.
      systemSha: crypto.createHash('sha256').update(String(promptMessages[0]?.content || '')).digest('hex').slice(0, 24),
    },
    rawText,
    finalText,
    segments,
    isWeird,
    rewritten,
    rewriteError,
    error,
    usage,
    // attempts > 1 means the sample only produced text because of a retry;
    // keep it so a round can tell style from an unstable backend.
    providerAttempts,
    latencyMs: Date.now() - started,
  };
  record.evaluation = evaluate(item, record);
  return record;
}

ensureStore();
const sourceDb = args.mode === 'live' ? readSourceDb(args.sourceData) : null;
const initial = readDb();
copyReplaySettings(initial, sourceDb, args.mode);
initial.groups = [];
initial.users = [];
initial.memories = [];
initial.groupProfiles = [];
initial.relationshipProfiles = [];
initial.messages = [];
initial.decisions = [];
initial.toolCallLogs = [];
initial.usageEvents = [];
initial.usage = {
  totalTokens: 0, promptTokens: 0, cachedTokens: 0, cacheWriteTokens: 0,
  completionTokens: 0, reasoningTokens: 0, cacheMeasuredPromptTokens: 0,
  cacheMeasuredRequests: 0, cacheMetricsStartedAt: '', requests: 0, replies: 0, errors: 0,
};
writeDb(initial);

const stats = emptyStats();
const results = [];
const deps = { decideReply, completeChat, sanitizeReply, splitReplySegments, isWeirdReply, rewriteNormalReply };
console.log(`[pippi-replay] round=${args.round} mode=${args.mode} split=${args.split} cases=${selectedCases.length} temp=${replayDir}`);

for (let index = 0; index < selectedCases.length; index += 1) {
  const item = selectedCases[index];
  const result = await runOne(item, readDb(), deps);
  results.push(result);
  addStats(stats, item, result.evaluation, result);
  if ((index + 1) % 10 === 0 || index === selectedCases.length - 1) {
    const failed = results.filter((entry) => !entry.evaluation.pass).length;
    console.log(`[pippi-replay] ${index + 1}/${selectedCases.length} hard_fail=${failed} model_error=${stats.errors}`);
  }
}

const summary = summarizeStats(stats);
// Settings as they stood for this run; captured once so the provenance block
// cannot drift if a later step touches the store.
const runSettings = readDb().settings;
const output = {
  schema: 'pippi-groupchat-replay/v1',
  generatedAt: new Date().toISOString(),
  round: args.round,
  mode: args.mode,
  split: args.split,
  caseCount: selectedCases.length,
  totalFixtureCases: allCases.length,
  splitCounts: {
    train: allCases.filter((item) => splitForSource(item.sourceId) === 'train').length,
    dev: allCases.filter((item) => splitForSource(item.sourceId) === 'dev').length,
    holdout: allCases.filter((item) => splitForSource(item.sourceId) === 'holdout').length,
    sourceGroups: {
      train: PIPPI_GROUPCHAT_SOURCE_IDS.filter((id) => splitForSource(id) === 'train'),
      dev: PIPPI_GROUPCHAT_SOURCE_IDS.filter((id) => splitForSource(id) === 'dev'),
      holdout: PIPPI_GROUPCHAT_SOURCE_IDS.filter((id) => splitForSource(id) === 'holdout'),
    },
  },
  safety: {
    oneBotSendCalled: false,
    qqTarget: null,
    productionDataDirTouched: false,
    providerFallbackDisabled: args.mode === 'live',
    toolCasesExecuted: false,
  },
  replayDir,
  provenance: {
    ...gitState(),
    provider: runSettings?.llmProvider ?? null,
    model: runSettings?.model ?? null,
    codexModel: runSettings?.codexModel ?? null,
    temperature: runSettings?.temperature ?? null,
    codexTimeoutMs: runSettings?.codexTimeoutMs ?? null,
    maxTokensSample: results[0]?.responseOptions?.maxTokens ?? null,
    promptSnapshotSha: promptSnapshotSha(results),
    fixtureSha: sha256File(path.join(repoRoot, 'tools/fixtures/pippi-groupchat-cases-v1.mjs')),
    replayToolSha: sha256File(fileURLToPath(import.meta.url)),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
  },
  summary,
  results,
};
output.summary.tics = collectTics(results);

const outputPath = path.resolve(args.out || path.join('artifacts', `pippi-groupchat-${args.round}-${args.mode}.json`));
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf8');
console.log(JSON.stringify({ output: outputPath, summary }, null, 2));

if (!args.keepTemp) {
  try { fs.rmSync(replayDir, { recursive: true, force: true }); } catch { /* diagnostic output remains usable */ }
}

// The Codex app-server client owns a long-lived child process.  A replay is a
// bounded batch job, so explicitly end the parent after the report is flushed;
// otherwise a completed run would look hung while the idle app-server remains
// alive.
if (args.mode === 'live') process.exit(0);

