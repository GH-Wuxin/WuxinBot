// Analyzer MVP: one evidence-backed LLM report for a player snapshot.
//
// The legacy analyzer generated section comments and a conclusion through
// separate LLM loops. The MVP keeps the deterministic data preparation and
// report validator, but gives the model one complete evidence packet and one
// chance to write the report as a whole.

import { completeChat } from '../bot/llm.js';
import { collectPlayerData, type CollectorResult } from './collector.js';
import {
  analyzeData,
  buildAnalysisPrompt,
  validateAnalysisReport,
  type AnalysisNarrativeContext,
} from './analyzer.js';
import type { OsuMode } from './types.js';

export const ANALYZER_MVP_FORMAT_VERSION = 91;
export const ANALYZER_MVP_MODEL = 'deepseek-v4-flash';
export const ANALYZER_MVP_CODEX_MODEL = 'gpt-6-luna';
export const ANALYZER_MVP_CODEX_EFFORT = 'low';

export type AnalyzerMvpSource = 'llm' | 'fallback';

export interface AnalyzerMvpResult {
  collection: CollectorResult;
  text: string;
  source: AnalyzerMvpSource;
  provider: string;
  model: string;
  validationReasons: string[];
  rejectedDraft: string;
  analysis: ReturnType<typeof analyzeData>;
}

export interface AnalyzerMvpDependencies {
  collect?: (target: string | number, mode: OsuMode) => Promise<CollectorResult>;
  complete?: typeof completeChat;
}

const SCRIPT_HAN = /\p{Script=Han}/u;
const SCRIPT_HIRAGANA = /\p{Script=Hiragana}/u;
const SCRIPT_KATAKANA = /\p{Script=Katakana}/u;
const SCRIPT_LATIN = /\p{Script=Latin}/u;
const SCRIPT_CYRILLIC = /\p{Script=Cyrillic}/u;
const SCRIPT_GREEK = /\p{Script=Greek}/u;
const SCRIPT_ARABIC = /\p{Script=Arabic}/u;
const SCRIPT_DEVANAGARI = /\p{Script=Devanagari}/u;
const SCRIPT_KANNADA = /\p{Script=Kannada}/u;
const SCRIPT_HANGUL = /\p{Script=Hangul}/u;
const LETTER_OR_MARK = /[\p{Letter}\p{Mark}]/u;

function scriptBucket(character: string): string {
  if (
    SCRIPT_HAN.test(character)
    || SCRIPT_HIRAGANA.test(character)
    || SCRIPT_KATAKANA.test(character)
    || SCRIPT_HANGUL.test(character)
  ) return 'cjk';
  if (SCRIPT_LATIN.test(character)) return 'latin';
  if (SCRIPT_CYRILLIC.test(character)) return 'cyrillic';
  if (SCRIPT_GREEK.test(character)) return 'greek';
  if (SCRIPT_ARABIC.test(character)) return 'arabic';
  if (SCRIPT_DEVANAGARI.test(character)) return 'devanagari';
  if (SCRIPT_KANNADA.test(character)) return 'kannada';
  if (LETTER_OR_MARK.test(character)) return 'other-letter';
  return '';
}

/**
 * Codex/App Server can occasionally append a short mixed-script token after
 * an otherwise complete answer. It is not safe to normalize all non-Chinese
 * text because player names, map names and osu! terms are legitimate. This
 * deliberately narrow scrub only removes a compact, whitespace-free,
 * multi-script fragment that appears after a completed sentence.
 */
export function sanitizeGeneratedText(value: unknown): string {
  const text = String(value || '').trim();
  const chineseBoundaryIndex = Math.max(
    text.lastIndexOf('。'),
    text.lastIndexOf('！'),
    text.lastIndexOf('？'),
  );
  const asciiBoundaryIndex = Math.max(text.lastIndexOf('!'), text.lastIndexOf('?'));
  const boundaryIndex = chineseBoundaryIndex >= 0 ? chineseBoundaryIndex : asciiBoundaryIndex;
  if (boundaryIndex < 0) return text;

  const tail = text.slice(boundaryIndex + 1).trim();
  if (!tail) return text;
  const compactTail = tail.replace(/\s+/gu, '');
  const buckets = new Set([...tail].map(scriptBucket).filter(Boolean));
  const unusualBucket = [...buckets].some((bucket) => !['cjk', 'latin'].includes(bucket));
  const compactSingleUnusualToken =
    buckets.size === 1 && unusualBucket && compactTail.length <= 16 && [...compactTail].every((character) => LETTER_OR_MARK.test(character));
  const orphanForeignTail =
    unusualBucket
    && ![...tail].some((character) => SCRIPT_HAN.test(character) || SCRIPT_HIRAGANA.test(character) || SCRIPT_KATAKANA.test(character) || SCRIPT_HANGUL.test(character))
    && !/\d/u.test(tail)
    && compactTail.length <= 80;
  if ((buckets.size >= 3 && unusualBucket) || compactSingleUnusualToken || orphanForeignTail) {
    return text.slice(0, boundaryIndex + 1).trim();
  }
  return text;
}

function cleanCandidate(value: unknown): string {
  const cleaned = String(value || '')
    .trim()
    .replace(/^```(?:markdown|text)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const sanitized = sanitizeGeneratedText(cleaned);
  if (sanitized !== cleaned) {
    console.warn('[osu analyzer mvp] 已移除报告末尾异常混合脚本 token');
  }
  return sanitized;
}

const MVP_OUTPUT_CONTRACT = [
  '【MVP 输出契约】',
  '本次任务必须输出一份完整报告，不得套用旧版“四块短评”的简化格式。',
  '必须按以下顺序保留全部 8 个节点，标题要原样使用；数据不足时在节点内明确写“暂无核准数据”，不能省略节点：',
  '【账号档案 · std】',
  '【BP100 · 总览】',
  '【BP5】',
  '【Mods】',
  '【PP+ 六维】',
  '【Recent 50 次】',
  '【谱面类型分布】',
  '【结论】',
  '8 个节点只是信息骨架，不是 8 篇等长小作文。报告至少 600 个字符，通常控制在 900-1800 个中文字符；只输出报告正文，不输出 JSON、代码块、检查过程或节点清单。',
].join('\n');

const MVP_WRITING_GUIDE = [
  '【第一轮文风重做：优先执行】',
  '目标不是写一份完整、客观、面面俱到的审计报告，而是像一个真正看完这份 osu! 记录的熟手，直接告诉玩家“这份数据最有意思的地方是什么”。数据准确优先，但不要把数据简报重新朗读一遍。',
  '每个节点只保留最有辨识度的 1 个重点，最多 2-3 句；没有新东西的节点可以只写 1 句。节点之间允许长短不一，允许某个栏目明显更短。',
  '账号档案只挑 rank、pp 和一两个能定位账号体量的事实；不要把所有账号字段排队念完。BP 总览看形状，BP5 只在确实有孤峰、反差或局部对照时展开。Mods、PP+、Recent、分类也都只说最突出的关系。',
  '结论不要把前面七段再总结一次。只选 2-3 个最强证据，给出一个有指向性的中心判断；可以有一点锋利、惊讶或轻微吐槽，但必须贴着数据。',
  '少用“当前收录”“从数据看”“这表明”“需要注意的是”“综合来看”“因此”“同时”“不能简单地”“仅凭……不能……”等报告套话。整篇不要反复声明数据边界；确实需要保留未知时，用一次短句就停。',
  '不要在正文里出现“数据块、事实简报、核准、字段、程序、校验、样本性质、报告显示”等内部工作语言，也不要把每一段写成“观察-免责声明-总结”的固定三拍。',
  '避免连续使用“本账号、该玩家、这份账号档案”。能直接写用户名、BP、Recent 或省略主语，就不要换成研究报告式指代。句子长短要有变化，允许短句、转折和自然的口语停顿。',
  '不要为了显得专业而解释每一个数字，也不要为了显得谨慎而给每个判断配一条“无法推断”。数字只在能支撑判断时出现；同一个数字不要在结论里原样复述第二遍，除非它是中心判断的关键锚点。',
  '禁止空泛的收尾，例如“未来还有提升空间”“需要继续努力”“这是一个值得关注的现象”。不要给训练计划、设备建议或现实原因猜测。',
  '语气：这是 pippi 在看完记录后的亲口反应，不是冷冰冰的审计员。看到极端强项、离谱反差、漂亮的局部或明显的失衡，要自然表现出锐评、惊讶、赞叹、可惜或轻微吐槽；全篇挑 2-4 个最值得反应的地方即可，不要每个节点硬塞情绪。',
  '情绪必须紧贴事实：可以写“这就有点离谱了”“诶，这个反差很漂亮”“好家伙，这不是普通的高分结构”这一类直接反应，但不能只喊“太强了”而不说明强在哪里，也不要把固定口头禅复制到每份报告。',
  'Pippi 可以明确夸奖顶尖成绩，也可以指出“这里才是真正有意思的地方”；称赞、吐槽和惊讶都要由具体数字、组合或前后反差触发。人格通过判断和反应出现，不靠卖萌、动作描写或标签化称呼。',
  '至少有两处采用“先反应、再解释”的自然节奏，不要把所有情绪都挤到【结论】最后。全篇最多保留两句必要的数据边界提醒；不要每个节点结尾都补“只能说明……不能推断……”的免责声明。',
  '最后一个中文句号、问号或感叹号后直接结束；不得追加外语短语、标签、随机字符、乱码或自我检查内容。',
  '输出前只检查事实是否对，不要把检查过程写进正文。',
].join('\n');

async function collectWithRetry(target: string | number, mode: OsuMode): Promise<CollectorResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await collectPlayerData(target, mode);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1200));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || '玩家数据获取失败'));
}

export async function runAnalyzerMvp(
  db: any,
  target: string | number,
  mode: OsuMode = 'osu',
  narrative: AnalysisNarrativeContext = {},
  dependencies: AnalyzerMvpDependencies = {},
): Promise<AnalyzerMvpResult> {
  const collection = dependencies.collect
    ? await dependencies.collect(target, mode)
    : await collectWithRetry(target, mode);
  const analysis = analyzeData({
    user: collection.user,
    bestScores: collection.bestScores,
    recentScores: collection.recentScores,
    mode,
    pplusBars: collection.pplusBars,
    refBars: collection.refBars,
    classification: collection.classification,
  });
  const personalityPrompt = String(db?.settings?.personalityPrompt || '');
  const prompt = buildAnalysisPrompt(analysis, personalityPrompt, narrative);
  const mvpPrompt = {
    system: `${prompt.system}\n\n${MVP_OUTPUT_CONTRACT}\n\n${MVP_WRITING_GUIDE}`,
    user: `${prompt.user}\n\n${MVP_OUTPUT_CONTRACT}\n\n请把它写成一次有重点的玩家复盘：八个标题都保留，但不要逐项念数据，不要重复免责声明。`,
  };
  const rawProvider = String(db?.settings?.llmProvider || 'deepseek').trim() || 'deepseek';
  const usesCodex = rawProvider === 'codex-app-server';
  const model = usesCodex
    ? String(process.env.OSU_ANALYZER_MVP_CODEX_MODEL || db?.settings?.codexModel || ANALYZER_MVP_CODEX_MODEL).trim()
    : String(process.env.OSU_ANALYZER_MVP_MODEL || db?.settings?.analysisModel || ANALYZER_MVP_MODEL).trim();

  let text = analysis.safeFallback;
  let source: AnalyzerMvpSource = 'fallback';
  let provider = rawProvider;
  let actualModel = model;
  let validationReasons: string[] = [];
  let rejectedDraft = '';

  try {
    const complete = dependencies.complete || completeChat;
    const completion = await complete(db, {
      model,
      ...(usesCodex ? {
        // Analyze is a structured, evidence-bound report. Do not inherit the
        // global max-effort setting: it makes this one report spend the whole
        // 90s turn reasoning before producing the adapter envelope.
        codexModel: model,
        codexReasoningEffort: String(
          process.env.OSU_ANALYZER_MVP_CODEX_EFFORT || ANALYZER_MVP_CODEX_EFFORT
        ).trim() || ANALYZER_MVP_CODEX_EFFORT,
      } : {}),
      messages: [
        { role: 'system', content: mvpPrompt.system },
        { role: 'user', content: mvpPrompt.user },
      ],
      maxTokens: 980,
      temperature: 0.6,
      timeoutMs: 90_000,
      requestMaxRetries: 1,
      retryOnEmpty: true,
      label: 'osu Analyzer MVP',
      tracePurpose: 'osu_analyzer_mvp',
    });
    provider = String(completion.provider || provider).trim() || provider;
    actualModel = String(completion.model || actualModel).trim() || actualModel;
    const candidate = cleanCandidate(completion.text);
    validationReasons = validateAnalysisReport(analysis, candidate, narrative).reasons;
    if (candidate && validationReasons.length === 0) {
      text = candidate;
      source = 'llm';
    } else {
      rejectedDraft = candidate.slice(0, 2000);
      console.error('[osu analyzer mvp] 报告未通过事实校验，使用安全回退：', validationReasons);
    }
  } catch (error) {
    validationReasons = [`llm_error:${String(error?.message || error).slice(0, 180)}`];
    console.error('[osu analyzer mvp] LLM 生成失败，使用安全回退：', error?.message || error);
  }

  return {
    collection,
    text,
    source,
    provider,
    model: actualModel,
    validationReasons: validationReasons.slice(0, 12),
    rejectedDraft,
    analysis,
  };
}
