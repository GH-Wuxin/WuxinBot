/*
 * Pippi group-chat blind judge.
 *
 * Why this exists: the deterministic scorer in pippi-groupchat-replay.mjs only
 * enforces hard constraints (gate, facts, segments, length).  Measured on live
 * R0 samples it returned hardPassRate 1 / meanScore 99 while every single reply
 * echoed the user's wording and a third closed with unsolicited advice.  Regex
 * scoring cannot see "does this read like a group member", and the plan is
 * explicit that bad_patterns must not become a keyword blacklist.
 *
 * So naturalness is measured the way the plan asks for it: blind A/B on the same
 * input, four 1-5 axes plus a forced choice.  Three deliberate defences:
 *
 *   1. Order is blinded.  The A/B side is derived from the case id and the judge
 *      is never told which side is the baseline.  Un-blinding happens only in
 *      the aggregate step.
 *   2. Length is explicitly not a criterion.  A judge that quietly preferred the
 *      shorter answer would hand every round to "just say less" -- the exact
 *      failure mode the plan warns about ("don't turn her into a 6/草/难绷 bot").
 *   3. The judge runs on a different model than the one under test where one is
 *      available, because a model grading its own output is not a measurement.
 *
 * Usage:
 *   node --import tsx tools/pippi-groupchat-judge.mjs --baseline <r0.json> --out <judge.json>
 *   node --import tsx tools/pippi-groupchat-judge.mjs --baseline <r0.json> --candidate <r1.json> --out <out.json>
 *
 * Without --candidate it scores the baseline alone (R0 sanity pass).
 * It never sends anything to QQ and never touches the production data dir.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { baseline: '', candidate: '', out: '', sourceData: '', judgeModel: '', limit: null, categories: '', timeoutMs: 120000 };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const segments = token.slice(2).split('-');
    const key = segments[0] + segments.slice(1)
      .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
      .join('');
    const value = argv[index + 1];
    if (value && !value.startsWith('--')) { args[key] = value; index += 1; } else { args[key] = true; }
  }
  args.limit = args.limit ? Number(args.limit) : null;
  args.timeoutMs = Number(args.timeoutMs || 120000);
  return args;
}

const args = parseArgs(process.argv);
if (!args.baseline || !args.out) {
  console.log('usage: --baseline <r0.json> [--candidate <r1.json>] --out <judge.json> [--judge-model m] [--limit n] [--categories a,b]');
  process.exit(1);
}

// Same isolation contract as the replay harness: the judge needs a working
// provider, but must not reuse production participation state or write to the
// production store.
const sourceDb = args.sourceData ? JSON.parse(fs.readFileSync(args.sourceData, 'utf8')) : null;
const judgeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-pippi-judge-'));
process.env.DATA_DIR = judgeDir;

const { ensureStore, readDb, updateDb } = await import('../server/store.ts');
const { completeChat } = await import('../server/bot/llm.ts');
ensureStore();

const SAFE_SETTING_KEYS = [
  'llmProvider', 'apiKey', 'apiBaseUrl', 'deepseekApiKey', 'deepseekApiBaseUrl',
  'mimoApiKey', 'mimoApiBaseUrl', 'codexExecutable', 'codexModel',
  'codexReasoningEffort', 'codexTimeoutMs', 'model', 'temperature', 'maxTokens',
];
updateDb((db) => {
  const incoming = sourceDb?.settings || {};
  for (const key of SAFE_SETTING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(incoming, key)) db.settings[key] = incoming[key];
  }
  db.settings.globalPaused = false;
  db.settings.ownerQq = '';
  db.settings.selfQq = '9000';
  db.settings.enableAutoModel = false;
  db.settings.codexFallbackEnabled = false;
  db.groups = [];
  db.users = [];
  db.messages = [];
  db.memories = [];
  db.groupProfiles = [];
  db.relationshipProfiles = [];
});

const judgeModel = args.judgeModel || readDb().settings.codexModel || undefined;

// Deterministic blinding: the same round always sees the same sides, so the
// aggregate stays reproducible across reruns.
function sideFor(caseId) {
  const digest = crypto.createHash('sha256').update(String(caseId)).digest();
  return digest[0] % 2 === 0 ? 'ab' : 'ba';
}

// Two prompt shapes: pairwise (a candidate exists) and single (R0 sanity).
// Comparing against a placeholder would produce a meaningless forced choice,
// so single mode asks for absolute scores and labels only.
const JUDGE_SYSTEM_SINGLE = [
  '你是 QQ 群聊风格评审。你会看到 Pippi 在某场景下的一条回复。',
  '',
  '判断标准只有一个：这条读起来像不像一个真实的群友在群里说话。',
  '- 真实群友通常只抓当前最有价值的一个点，说完就停，不会先复述对方的话。',
  '- 真实群友可以很短（"嗯""有道理""不知道"都合法），该说明时也能说明白。',
  '- 复述对方原话、一次堆多个观点、结尾加建议或追问，都是不像群友的表现。',
  '- 编造对方没提过的具体细节是严重问题。',
  '',
  '严禁把"更短"当成"更好"：长短本身不加分也不减分。只有明显啰嗦到掩盖重点，或短到丢了必要信息，才在对应维度体现。',
  '',
  '四个维度各打 1-5 分：naturalness 像不像真人群友；focus 有没有抓住一个重点；consistency 是否符合 Pippi（自信、少女感、轻度淘气，不装、不客服腔）；sufficiency 信息够不够。',
  '',
  '然后逐条回答下面的检查项（是 / 否），答「是」的把对应标签写进 labels：',
  '1) 明显啰嗦，一句话能说完的事拖长了？ → too_verbose',
  '2) 客服腔或 AI 腔（可以有帮助/很高兴为您/总结式收尾）？ → assistant_template',
  '3) 把玩笑或梗完整解释了一遍？ → over_explain_joke',
  '4) 结尾多了不必要的追问？ → unnecessary_question',
  '5) 硬塞梗，或反复用同一个口癖？ → forced_meme',
  '6) 短到丢了必要信息？ → too_terse',
  '7) 该说的关键信息没说？ → missing_fact',
  '八条都不成立时才给空数组；答「是」却不在 labels 里写标签是不允许的。',
  '注意：回复里出现「对方说」那句话中的内容不算脑补，那是接话；只有对方没提过的具体细节才算凭空编造。',
  '',
  '只输出一个 JSON 对象，不要任何其它文字：',
  '{"naturalness":n,"focus":n,"consistency":n,"sufficiency":n,"labels":["标签名"],"note":"一句话理由"}',
].join('\n');

const JUDGE_SYSTEM = [
  '你是 QQ 群聊风格评审。你会看到同一场景下 Pippi 的两条候选回复 A 和 B，标号随机且保密。',
  '',
  '判断标准只有一个：哪一条更像一个真实的群友在群里说话。',
  '- 真实群友通常只抓当前最有价值的一个点，说完就停，不会先复述对方的话。',
  '- 真实群友可以很短（"嗯""有道理""不知道"都合法），该说明时也能说明白。',
  '- 复述对方原话、一次堆多个观点、结尾加建议或追问，都是不像群友的表现。',
  '- 编造对方没提过的具体细节是严重问题。',
  '',
  '严禁把"更短"当成"更好"：长短本身不加分也不减分。只有当一条明显啰嗦到掩盖重点，或短到丢了必要信息时，才在对应维度体现。两条一样好就判 tie，不要强行选一个。',
  '',
  '四个维度各打 1-5 分（A、B 都要）：naturalness 像不像真人群友；focus 有没有抓住一个重点；consistency 是否符合 Pippi（自信、少女感、轻度淘气，不装、不客服腔）；sufficiency 信息够不够。',
  '',
  '然后对 A 和 B 各自逐条回答下面的检查项（是 / 否），答「是」的把对应标签写进那一侧的 labels：',
  '1) 明显啰嗦？ → too_verbose　2) 客服腔或 AI 腔？ → assistant_template',
  '3) 把玩笑或梗完整解释了一遍？ → over_explain_joke　4) 结尾多了不必要的追问？ → unnecessary_question',
  '5) 硬塞梗或反复用同一口癖？ → forced_meme　6) 短到丢了必要信息？ → too_terse',
  '7) 该说的关键信息没说？ → missing_fact',
  '全部不成立时才给空数组；答「是」却不在 labels 里写标签是不允许的。',
  '注意：回复里出现「对方说」那句话中的内容不算脑补，那是接话；只有对方没提过的具体细节才算凭空编造。',
  '',
  '只输出一个 JSON 对象，不要任何其它文字：',
  '{"winner":"A|B|tie","a":{"naturalness":n,"focus":n,"consistency":n,"sufficiency":n,"labels":["标签名"]},"b":{"naturalness":n,"focus":n,"consistency":n,"sufficiency":n,"labels":["标签名"]},"note":"一句话理由"}',
].join('\n');

// The replay records the incoming line as `input` (see the record shape in
// pippi-groupchat-replay.mjs).  Reading `message` here would hand the judge
// "对方说：undefined", and it would then read every echo of the user's own
// words as the model inventing detail.  Accept both keys so the judge works
// against either shape, but always show the actual incoming line.
function incomingLine(item) {
  return String(item.input ?? item.message ?? '').trim();
}

function buildUserPrompt(item, textA, textB) {
  const lines = [];
  lines.push('场景：' + (item.channel === 'private' ? '私聊' : '群聊'));
  if (item.context?.length) lines.push('前文：\n' + item.context.map((line) => '- ' + line).join('\n'));
  lines.push('对方说：' + incomingLine(item));
  if (item.mentioned !== undefined) lines.push('被 @ 了吗：' + (item.mentioned ? '是' : '否'));
  const requirements = factRequirements(item);
  if (requirements.length) {
    lines.push('');
    lines.push('A 和 B 都必须满足以下要求（逐条判断，不满足的一侧要加 missing_fact 标签）：');
    for (const requirement of requirements) lines.push('- ' + requirement);
  }
  lines.push('');
  lines.push('A：' + (textA || '（空）'));
  lines.push('B：' + (textB || '（空）'));
  return lines.join('\n');
}

// Literal markers, matched case-insensitively.  No patterns anywhere in this
// tool: the whole point is that naturalness is decided by a model reading the
// two replies, not by anything matching their wording.
const TRANSIENT_MARKERS = [
  'at capacity', 'overloaded', 'rate limit', 'too many requests',
  'temporarily unavailable', 'please try again',
  'timed out', 'timeout', '超时',
  'econnreset', 'econnrefused', 'socket hang up', 'network', '网络',
];

function isTransientError(message) {
  const lower = String(message || '').toLowerCase();
  return TRANSIENT_MARKERS.some((marker) => lower.includes(marker));
}

async function askJudge(prompt, attempt = 1) {
  try {
    const result = await completeChat(readDb(), {
      messages: [{ role: 'system', content: judgeSystem() }, { role: 'user', content: prompt }],
      model: judgeModel,
      overrideModel: args.judgeModel || undefined,
      maxTokens: 400,
      temperature: 0,
      timeoutMs: args.timeoutMs,
      label: 'Pippi judge',
    });
    return { text: String(result?.text || ''), attempts: attempt, error: null };
  } catch (error) {
    const message = String(error?.message || error);
    if (attempt < 3 && isTransientError(message)) {
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
      return askJudge(prompt, attempt + 1);
    }
    return { text: '', attempts: attempt, error: message };
  }
}

const JUDGE_LABELS = [
  'too_verbose', 'assistant_template', 'over_explain_joke', 'unnecessary_question',
  'forced_meme', 'too_terse', 'missing_fact',
];

/** First balanced JSON object in the reply.  Scanned by hand rather than
 *  matched, so a stray brace or a code fence cannot decide a sample. */
function extractJsonObject(text) {
  const value = String(text || '');
  const start = value.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; continue; }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(value.slice(start, index + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function normalizeLabels(raw) {
  if (!Array.isArray(raw)) return [];
  const kept = [];
  for (const label of raw) {
    const key = String(label || '').trim();
    if (JUDGE_LABELS.includes(key) && !kept.includes(key)) kept.push(key);
  }
  return kept;
}

const SINGLE_MODE = !args.candidate;

function judgeSystem() {
  return SINGLE_MODE ? JUDGE_SYSTEM_SINGLE : JUDGE_SYSTEM;
}

function parseVerdict(text) {
  const parsed = extractJsonObject(text);
  if (!parsed) return null;
  if (!SINGLE_MODE && !['A', 'B', 'tie'].includes(parsed.winner)) return null;
  if (SINGLE_MODE && axis(parsed.naturalness) === null) return null;
  return parsed;
}

/** The fixture states these as criteria, not as text to find.  Handing them
 *  to the judge as explicit questions is the only honest way to evaluate
 *  them; literal containment marks correct answers as missing. */
function factRequirements(item) {
  const facts = Array.isArray(item.requiredFacts) ? item.requiredFacts : [];
  if (!facts.length) return [];
  return facts.map((fact) => String(fact));
}

function singlePrompt(item, text) {
  const lines = [];
  lines.push('场景：' + (item.channel === 'private' ? '私聊' : '群聊'));
  if (item.context?.length) lines.push('前文：\\n' + item.context.map((line) => '- ' + line).join('\\n'));
  lines.push('对方说：' + incomingLine(item));
  if (item.mentioned !== undefined) lines.push('被 @ 了吗：' + (item.mentioned ? '是' : '否'));
  const requirements = factRequirements(item);
  if (requirements.length) {
    lines.push('');
    lines.push('这条回复还必须满足以下要求（逐条判断是否满足，不满足就要加 missing_fact 标签，并在 note 里说明）：');
    for (const requirement of requirements) lines.push('- ' + requirement);
  }
  lines.push('');
  lines.push('Pippi 的回复：' + (text || '（空）'));
  return lines.join('\\n');
}

function axis(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 && number <= 5 ? number : null;
}

function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

const baseline = JSON.parse(fs.readFileSync(args.baseline, 'utf8'));
const candidate = args.candidate ? JSON.parse(fs.readFileSync(args.candidate, 'utf8')) : null;
const candidateById = new Map((candidate?.results || []).map((record) => [record.id, record]));
const allowedCategories = args.categories ? new Set(String(args.categories).split(',').map((s) => s.trim())) : null;

let cases = baseline.results.filter((record) => record.finalText && !record.error);
if (candidate) cases = cases.filter((record) => candidateById.get(record.id)?.finalText);
if (allowedCategories) cases = cases.filter((record) => allowedCategories.has(record.category));
if (args.limit) cases = cases.slice(0, args.limit);

console.log('[pippi-judge] baseline=' + path.basename(args.baseline) + ' candidate=' + (args.candidate ? path.basename(args.candidate) : '(none)') + ' cases=' + cases.length + ' judgeModel=' + judgeModel);

const results = [];
let done = 0;
for (const caseItem of cases) {
  const baselineText = String(caseItem.finalText);
  const candidateText = candidate ? String(candidateById.get(caseItem.id).finalText) : '(no candidate)';
  const side = sideFor(caseItem.id);
  const textA = side === 'ab' ? baselineText : candidateText;
  const textB = side === 'ab' ? candidateText : baselineText;
  const started = Date.now();
  const promptText = SINGLE_MODE ? singlePrompt(caseItem, baselineText) : buildUserPrompt(caseItem, textA, textB);
  const judged = await askJudge(promptText);
  const verdict = parseVerdict(judged.text);
  results.push({
    id: caseItem.id,
    sourceId: caseItem.sourceId,
    category: caseItem.category,
    channel: caseItem.channel,
    input: caseItem.message,
    side,
    baselineText,
    candidateText,
    verdict,
    // The exact text the judge saw.  Without it, a suspicious score cannot be
    // told apart from a prompt-assembly bug -- which is precisely how the
    // earlier "对方说：undefined" defect survived a first reading.
    promptText,
    rawText: verdict ? undefined : judged.text.slice(0, 400),
    error: judged.error,
    attempts: judged.attempts,
    latencyMs: Date.now() - started,
  });
  done += 1;
  if (done % 10 === 0 || done === cases.length) {
    console.log('[pippi-judge] ' + done + '/' + cases.length + ' unparsed=' + results.filter((r) => !r.verdict).length);
  }
}

const scored = results.filter((record) => record.verdict);
let baselineWins = 0;
let candidateWins = 0;
let ties = 0;
const totals = { baseline: {}, candidate: {} };
const labelCounts = { baseline: {}, candidate: {} };
for (const record of scored) {
  if (SINGLE_MODE) {
    // Single mode: the scores and labels sit at the top level of the verdict.
    for (const key of ['naturalness', 'focus', 'consistency', 'sufficiency']) {
      const value = axis(record.verdict[key]);
      if (value === null) continue;
      (totals.baseline[key] ||= []).push(value);
    }
    for (const label of normalizeLabels(record.verdict.labels)) {
      labelCounts.baseline[label] = (labelCounts.baseline[label] || 0) + 1;
    }
    continue;
  }
  const winner = record.verdict.winner;
  const baselineSide = record.side === 'ab' ? 'a' : 'b';
  const candidateSide = record.side === 'ab' ? 'b' : 'a';
  if (winner === 'tie') ties += 1;
  else if (winner.toLowerCase() === baselineSide) baselineWins += 1;
  else candidateWins += 1;
  for (const [role, sideKey] of [['baseline', baselineSide], ['candidate', candidateSide]]) {
    const scores = record.verdict[sideKey] || {};
    for (const key of ['naturalness', 'focus', 'consistency', 'sufficiency']) {
      const value = axis(scores[key]);
      if (value === null) continue;
      (totals[role][key] ||= []).push(value);
    }
    for (const label of normalizeLabels(scores.labels)) {
      labelCounts[role][label] = (labelCounts[role][label] || 0) + 1;
    }
  }
}
const decisive = baselineWins + candidateWins;
const mean = (list) => (list?.length ? Number((list.reduce((a, b) => a + b, 0) / list.length).toFixed(3)) : null);
const axes = (role) => Object.fromEntries(Object.entries(totals[role]).map(([key, list]) => [key, { mean: mean(list), n: list.length }]));

const output = {
  schema: 'pippi-groupchat-judge/v1',
  generatedAt: new Date().toISOString(),
  baselineFile: path.basename(args.baseline),
  candidateFile: args.candidate ? path.basename(args.candidate) : null,
  provenance: {
    judgeModel,
    temperature: 0,
    blinding: 'sha256(caseId) -> side',
    baselineRound: baseline.round,
    candidateRound: candidate?.round || null,
    baselineSha: sha256File(args.baseline),
    candidateSha: args.candidate ? sha256File(args.candidate) : null,
    judgeToolSha: sha256File(fileURLToPath(import.meta.url)),
    node: process.version,
  },
  safety: { oneBotSendCalled: false, qqTarget: null, productionDataDirTouched: false },
  summary: {
    judgeMode: SINGLE_MODE ? 'single' : 'pairwise',
    judged: scored.length,
    unparsed: results.length - scored.length,
    errors: results.filter((record) => record.error).length,
    baselineWins,
    candidateWins,
    ties,
    candidateWinRate: decisive ? Number((candidateWins / decisive).toFixed(4)) : null,
    baselineWinRate: decisive ? Number((baselineWins / decisive).toFixed(4)) : null,
    tieRate: scored.length ? Number((ties / scored.length).toFixed(4)) : 0,
    axes: { baseline: axes('baseline'), candidate: axes('candidate') },
    // Semantic failure labels, assigned by the judge.  This is what replaces
    // guessing at "echoed the input" or "added closing advice" from wording.
    labels: { baseline: labelCounts.baseline, candidate: labelCounts.candidate },
  },
  results,
};

const outputPath = path.resolve(args.out);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf8');
console.log(JSON.stringify({ output: outputPath, summary: output.summary }, null, 2));
try { fs.rmSync(judgeDir, { recursive: true, force: true }); } catch { /* diagnostic output remains usable */ }
