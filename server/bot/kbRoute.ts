// Knowledge base v4.1 — deterministic closed-enum routing.
//
// Route decisions never depend on BM25 output. A route is a single closed
// value; multi-collection prompts only happen through the two explicit
// combined routes. Anything command-like, analysis-scene or serious is
// excluded from community-style injection by construction.
import type { KbRoute } from './knowledgeTypes.js';

const QUICK_PREFIX_RE = /^(?:[!！]|~|～|(?:查\s*@))/;
const WUXIN_COMMAND_RE = /^\/w(?:uxin)?(?:\s|$)/i;
const OTHER_SLASH_RE = /^\/(?!\s)/;
const HYDRANT_KEYWORD_RE = /^(?:荐图|帮助|pptth|今日高光|我的年度osu[!！]|where|打什么图|推荐谱面|推荐图)/;

const WUXIN_FEATURE_RES = [
  /怎么(?:绑定|解绑|分析|推图|推荐|查|查询|看|用|清除|取消|冷却|加群|换|改|开|关|升级|弄)/,
  /(?:绑定|解绑|bind|unbind|推图|推荐谱面|推荐图|分析|冷却|清除|查询|指令|命令|功能|等级|经验|画像|人设|备注|权限|推图历史|分析历史|缓存).{0,8}(?:怎么|如何|是什么|是啥|在哪|有没有|能用吗|可以吗|干嘛|什么意思|有什么用)/,
  /(?:pippi|机器人|bot)\s*(?:怎么|如何|会不会|能不能|可以)/i,
  /\/w(?:\w+)?\s*(?:怎么|如何|什么|指令|命令|功能|用)/i,
  /(?:pippi|机器人|bot).{0,6}(?:会|能|可以).{0,4}(?:推图|推荐|推荐谱面|分析|绑定|查)/i,
  /(?:bot|机器人|pippi).{0,4}(?:为什么不|怎么不|没反应|不回复|不回应)/i,
  /怎么(?:把|将|去|能|可以)?(?:冷却|绑定|推图|分析|缓存|历史|推荐)/,
];

const CAPABILITY_SUMMARY_RES = [
  /^(?:你|pippi|机器人|bot)?\s*(?:能|会|可以)?(?:做什么|干什么|干啥|些什么|什么功能|什么指令|哪些功能|哪些指令|都有什么|有什么功能|有什么指令|都能干嘛|会什么|会哪些|会做些什么)/i,
  /(?:你的|你能|你会|pippi能|pippi会|bot能|bot会).{0,4}(?:做什么|干什么|什么功能|什么指令|哪些功能|哪些指令|都能干嘛|会哪些)/i,
];

const OSU_DEFINITION_RES = [
  /(?:pp|bp|acc|准确率|ar|od|cs|hp|星数|判定|判定窗|hit window|mods?|hd|hr|dt|nc|ht|ez|fl|nf|so|sd|pf|td|rx|rl|ap|at|aim|jump|stream|串|跳图|alt|tech|reading|读图|ranked|loved|qualified|bonus pp|weighted|加权|combo|fc|choke|miss|评级|银s|stable|lazer|转盘|kiai|滑条|手感).{0,8}(?:是什么|是啥|什么意思|啥意思|区别|差异|怎么算|怎么算的|原理|机制|作用|影响|由什么|多少|哪个|哪个更难|哪个难)/i,
  /(?:pp|bp|acc|ar|od|星数|判定|mods?|hd|hr|dt|nc|ht|aim|stream|串|alt|tech|reading|ranked|loved|手感)\s*(?:是什么|是啥|什么意思|啥意思|区别|怎么算|原理|机制)/i,
];

const OSU_STRATEGY_RES = [
  /(?:这图|这张图|谱面|串|跳|aim|acc|pp|bp|ar|od|hd|hr|dt|nc|读图|手感|读).{0,10}(?:怎么打|怎么练|怎么玩|怎么刷|怎么上|怎么过|怎么提|怎么提升|怎么办|怎么稳)/i,
  /(?:怎么打|怎么练|怎么玩|怎么刷|怎么上|怎么过|怎么提|怎么提升|怎么稳).{0,10}(?:串|跳图|aim|acc|pp|ar|od|hd|hr|dt|读图|手感)/i,
];

const OSU_CONCEPT_RES = [
  /\b(?:pp|bp|acc|ar|od|cs|hp|dt|nc|hd|hr|ht|ez|fl|nf|so|sd|pf|td|rx|ap|at|aim|jump|stream|alt|tech|reading|ranked|loved|qualified|fc|choke|combo|kiai|bpm|clock rate)\b/i,
  /(?:星数|判定窗|判定|准确率|读图|手感|跳图|串图|串批|跳批|转盘|滑条|银S|评级|加权|bonus pp|hit window|lazer|stable)/,
];

function any(res: RegExp[], text: string): boolean {
  return res.some((re) => re.test(text));
}

export function isCommandLike(text: string): boolean {
  const value = String(text || '').trim();
  if (!value) return false;
  if (WUXIN_COMMAND_RE.test(value)) return true;
  if (QUICK_PREFIX_RE.test(value)) return true;
  if (OTHER_SLASH_RE.test(value)) return true;
  if (HYDRANT_KEYWORD_RE.test(value)) return true;
  return false;
}

function hasWuxinFeatureQuestion(text: string): boolean {
  return any(WUXIN_FEATURE_RES, text);
}

function hasCapabilitySummaryQuestion(text: string): boolean {
  return any(CAPABILITY_SUMMARY_RES, text);
}

function hasOsuDefinitionQuestion(text: string): boolean {
  return any(OSU_DEFINITION_RES, text);
}

function hasOsuStrategyQuestion(text: string): boolean {
  return any(OSU_STRATEGY_RES, text);
}

function hasOsuConceptMention(text: string): boolean {
  return any(OSU_CONCEPT_RES, text);
}

/**
 * Deterministic route selection. `scene` is the persona scene; `text` is the
 * current message. This function is pure — no loading, no logs.
 */
export function routeForText(scene: string, text: string): KbRoute {
  if (scene === 'osu_analysis') {
    return { kind: 'none', reason: 'analysis_scene_zero_inject' };
  }
  if (scene === 'serious') {
    return { kind: 'none', reason: 'serious_scene' };
  }
  const value = String(text || '').trim();
  if (!value) {
    return { kind: 'none', reason: 'empty_text' };
  }
  if (scene === 'command') {
    return { kind: 'none', reason: 'deterministic_command' };
  }
  if (WUXIN_COMMAND_RE.test(value)) {
    // A /w-prefixed *question* about Wuxin features is not an executable
    // command; let the wuxin branches below decide.
    if (!hasWuxinFeatureQuestion(value)) {
      return { kind: 'none', reason: 'deterministic_command' };
    }
  } else if (isCommandLike(value)) {
    return { kind: 'none', reason: 'deterministic_command' };
  }

  if (hasCapabilitySummaryQuestion(value)) {
    return { kind: 'capability_summary', reason: 'explicit_capability_overview' };
  }

  const wuxin = hasWuxinFeatureQuestion(value);
  const definitional = hasOsuDefinitionQuestion(value);
  const strategy = hasOsuStrategyQuestion(value);
  const concept = hasOsuConceptMention(value);

  if (wuxin && (definitional || strategy || concept)) {
    return { kind: 'self_and_domain', reason: 'explicit_combined_question' };
  }
  if (wuxin) {
    return { kind: 'wuxin_self', reason: 'explicit_wuxin_feature_question' };
  }
  if (definitional) {
    return { kind: 'osu_domain', reason: 'explicit_osu_concept_question' };
  }
  if (strategy) {
    return { kind: 'osu_casual_with_domain', reason: 'explicit_osu_strategy_in_casual' };
  }
  if (concept && /(?:\?|？|怎么|如何|为什么|吗|呢|怎么回事)/.test(value)) {
    return { kind: 'osu_casual_with_domain', reason: 'explicit_osu_concept_in_casual' };
  }
  return { kind: 'community_style', reason: 'casual_chat' };
}
