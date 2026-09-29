import crypto from 'node:crypto';
import { currentRequestTraceId, redactTraceValue } from './requestTrace.js';

export interface PromptStudioModule {
  id: string;
  name: string;
  description: string;
  injectionMethod: string;
  usesPippi: boolean;
  toolsPossible: boolean;
  editableLabel: string;
}

const MODULES: PromptStudioModule[] = [
  { id: 'conversation', name: '群聊与私聊', description: '普通对话、上下文回复与最终回答。', injectionMethod: 'Pippi 完整人格 + 当前场景规则 + 全局补充；Agent 在需要时追加工具定义。', usesPippi: true, toolsPossible: true, editableLabel: '对话人格补充' },
  { id: 'agent_tools', name: '工具规划与结果整合', description: 'Agent 工具选择、必需工具引导与工具结果后的回答合成。', injectionMethod: 'Agent 专用任务提示；工具 schema 随本轮能力按需注入，不默认注入 Pippi 核心人格。', usesPippi: false, toolsPossible: true, editableLabel: '工具流程人格补充' },
  { id: 'osu_analyzer', name: 'osu! 玩家分析', description: 'Analyzer MVP 与玩家报告生成。', injectionMethod: 'Pippi 精简分析人格 + osu! 知识 + 事实边界 + 可核验数据与任务规则。', usesPippi: true, toolsPossible: false, editableLabel: '玩家分析人格补充' },
  { id: 'osu_sections', name: 'osu! 区块短评', description: '生成或重写玩家报告中的指定区块。', injectionMethod: 'Pippi 精简分析人格 + 当前区块写作要求；程序继续执行 JSON 与事实校验。', usesPippi: true, toolsPossible: false, editableLabel: '区块短评人格补充' },
  { id: 'osu_conclusion', name: 'osu! 分析结论', description: '生成或重写玩家报告结论。', injectionMethod: 'Pippi 精简分析人格 + 结论写作要求；程序继续执行报告校验。', usesPippi: true, toolsPossible: false, editableLabel: '分析结论人格补充' },
  { id: 'osu_review', name: 'osu! 独立审查', description: '独立审查报告事实与结构。', injectionMethod: '独立审查器系统提示，不注入 Pippi 人格；输出由程序校验。', usesPippi: false, toolsPossible: false, editableLabel: '审查模块人格补充' },
  { id: 'osu_repair', name: 'osu! 硬错误修复', description: '根据机械校验结果修复报告片段。', injectionMethod: '严格事实修复提示，不注入 Pippi 人格；修复后仍由程序复验。', usesPippi: false, toolsPossible: false, editableLabel: '修复模块人格补充' },
  { id: 'osu_one_line', name: 'osu! 一句话锐评', description: '根据核准事实生成简短锐评。', injectionMethod: '独立的一句话写作提示；结果通过事实与长度校验。', usesPippi: false, toolsPossible: false, editableLabel: '一句话模块人格补充' },
  { id: 'player_profile', name: '玩家画像与记忆', description: '画像更新、JSON 修复、图片记忆摘要。', injectionMethod: '画像任务专用系统提示；不注入 Pippi 核心人格。', usesPippi: false, toolsPossible: false, editableLabel: '画像模块人格补充' },
  { id: 'group_profile', name: '群聊画像', description: '提炼群聊氛围与群体特征。', injectionMethod: '群聊画像专用系统提示。', usesPippi: false, toolsPossible: false, editableLabel: '群聊画像人格补充' },
  { id: 'relationship_profile', name: '关系画像', description: '根据可见对话总结两位成员的互动模式。', injectionMethod: '关系画像专用系统提示。', usesPippi: false, toolsPossible: false, editableLabel: '关系画像人格补充' },
  { id: 'group_summary', name: '群聊总结', description: '总结群聊中的近期话题。', injectionMethod: '群聊总结专用系统提示。', usesPippi: false, toolsPossible: false, editableLabel: '群聊总结人格补充' },
  { id: 'reply_gate', name: 'LLM 回复门控', description: '判断当前消息是否适合回复。', injectionMethod: '短格式判定提示；程序按约定解析结果。', usesPippi: false, toolsPossible: false, editableLabel: '回复门控人格补充' },
  { id: 'moderation', name: '内容审核', description: '审核用户可配置文本是否符合使用要求。', injectionMethod: '固定审核标准与短格式结果约定。', usesPippi: false, toolsPossible: false, editableLabel: '内容审核人格补充' },
  { id: 'reply_rewrite', name: '回复改写', description: '对已生成的回复进行风格改写。', injectionMethod: '改写专用提示；保留原回复事实和意图。', usesPippi: false, toolsPossible: false, editableLabel: '回复改写人格补充' },
  { id: 'recommendation_filter', name: '推荐条件解析', description: '把自然语言推荐条件转换为结构化筛选条件。', injectionMethod: '推荐筛选翻译提示与结构化输出约定。', usesPippi: false, toolsPossible: false, editableLabel: '推荐筛选人格补充' },
  { id: 'level_up', name: '升级短语', description: '生成简短升级提示语。', injectionMethod: '短文本生成提示；失败时使用程序内置回退。', usesPippi: false, toolsPossible: false, editableLabel: '升级短语人格补充' },
  { id: 'general', name: '其他 / 未分类', description: '尚未映射到专用目录的 LLM 请求。', injectionMethod: '沿用调用方提供的原始消息；可追加本模块人格补充。', usesPippi: false, toolsPossible: true, editableLabel: '其他模块人格补充' },
];

const moduleById = new Map(MODULES.map((module) => [module.id, module]));
const MAX_PROMPT_CALLS = 32;
const MAX_CALL_CHARS = 48_000;
const promptCalls = new Map<string, Record<string, unknown>>();

export function resolvePromptModule(options: Record<string, any> = {}) {
  const explicit = String(options.promptModule || '').trim();
  if (moduleById.has(explicit)) return moduleById.get(explicit)!;
  const identity = `${options.tracePurpose || ''} ${options.label || ''}`.toLowerCase();
  if (/tool_planning|required_tool_lead|tool_result_lead|tool_result_synthesis|required lead|工具循环|最终回答/.test(identity)) return moduleById.get('agent_tools')!;
  if (/osu_full_report_review|osu分析独立审查|independent review/.test(identity)) return moduleById.get('osu_review')!;
  if (/osu硬错误修复|factual repair/.test(identity)) return moduleById.get('osu_repair')!;
  if (/osu区块短评/.test(identity)) return moduleById.get('osu_sections')!;
  if (/osu分析创意稿|结论重写/.test(identity)) return moduleById.get('osu_conclusion')!;
  if (/osu_one_line_roast|osu 一句话锐评/.test(identity)) return moduleById.get('osu_one_line')!;
  if (/osu_analyzer_mvp|osu analyzer mvp/.test(identity)) return moduleById.get('osu_analyzer')!;
  if (/conversation_reply|bot harness/.test(identity)) return moduleById.get('conversation')!;
  if (/画像更新|画像json修复|图片记忆摘要/.test(identity)) return moduleById.get('player_profile')!;
  if (/群聊画像/.test(identity)) return moduleById.get('group_profile')!;
  if (/关系画像/.test(identity)) return moduleById.get('relationship_profile')!;
  if (/群聊总结/.test(identity)) return moduleById.get('group_summary')!;
  if (/llm门控/.test(identity)) return moduleById.get('reply_gate')!;
  if (/内容审核/.test(identity)) return moduleById.get('moderation')!;
  if (/reply_rewrite|回复改写/.test(identity)) return moduleById.get('reply_rewrite')!;
  if (/推荐筛选翻译/.test(identity)) return moduleById.get('recommendation_filter')!;
  if (/升级短语/.test(identity)) return moduleById.get('level_up')!;
  return moduleById.get('general')!;
}

export function getPersonaStudioCatalog(settings: Record<string, any> = {}) {
  const modulePrompts = settings.personaModulePrompts && typeof settings.personaModulePrompts === 'object'
    ? settings.personaModulePrompts : {};
  return MODULES.map((module) => ({
    ...module,
    currentPrompt: String(modulePrompts[module.id] || ''),
    isOverridden: Boolean(String(modulePrompts[module.id] || '').trim()),
  }));
}

export function applyModulePersonality(
  messages: any[],
  moduleId: string,
  modulePrompts: Record<string, string> = {},
) {
  const addition = String(modulePrompts?.[moduleId] || '').trim();
  if (!addition) return messages;
  const result = [...(Array.isArray(messages) ? messages : [])];
  const systemIndex = result.findIndex((message) => message?.role === 'system' && typeof message?.content === 'string');
  const block = [
    '【该模块的人格补充】',
    '以下内容只调整表达方式与角色表现，不得覆盖任务目标、事实边界、安全约束、输出格式或工具使用规则。',
    addition,
  ].join('\n');
  if (systemIndex >= 0) {
    result[systemIndex] = {
      ...result[systemIndex],
      content: `${result[systemIndex].content}\n\n---\n\n${block}`,
    };
  } else {
    result.unshift({ role: 'system', content: block });
  }
  return result;
}

function safePromptText(value: unknown, limit: number) {
  const cap = Math.max(0, Math.min(Number(limit) || 0, 12_000));
  let sourceLength = 0;
  try { sourceLength = typeof value === 'string' ? value.length : JSON.stringify(value)?.length || 0; } catch { sourceLength = 0; }
  if (typeof value === 'string') {
    const safe = String(redactTraceValue(value));
    const cleaned = safe
      .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, '[image payload omitted]')
      .replace(/data:audio\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, '[audio payload omitted]');
    const clipped = cleaned.slice(0, cap);
    return sourceLength > cap || cleaned.length > cap ? `${clipped}\n[快照已截断]` : clipped;
  }
  let serialized = '';
  try { serialized = JSON.stringify(redactTraceValue(value)); } catch { serialized = '[unavailable]'; }
  const clipped = serialized.slice(0, cap);
  return sourceLength > cap || serialized.length > cap ? `${clipped}\n[快照已截断]` : clipped;
}

function safeMessageContent(content: unknown, limit: number) {
  if (Array.isArray(content)) {
    const sanitized = content.map((part: any) => {
      if (!part || typeof part !== 'object') return part;
      const type = String(part.type || '').toLowerCase();
      if (type.includes('image') || type.includes('audio') || type.includes('video') || part.image_url || part.input_audio) {
        return { type: part.type || 'media', content: '[media payload omitted]' };
      }
      return part;
    });
    return safePromptText(sanitized, limit);
  }
  return safePromptText(content, limit);
}

export function beginPromptCall(input: {
  id?: string;
  options?: Record<string, any>;
  module?: PromptStudioModule;
  provider?: string;
  model?: string;
  messages?: any[];
  tools?: unknown;
}) {
  try {
    const options = input.options || {};
    const module = input.module || resolvePromptModule(options);
    const id = String(input.id || crypto.randomUUID());
    // Snapshot budget: keep every leading system/developer instruction block,
    // then the most recent tail within the 32-message cap. Clipping by count
    // is a truncation even when the characters fit — a dropped leading system
    // message must never look like a complete prompt (finding F14).
    const MESSAGE_SNAPSHOT_LIMIT = 32;
    const allMessages = Array.isArray(input.messages) ? input.messages : [];
    const originalMessageCount = allMessages.length;
    const head: any[] = [];
    let headIndex = 0;
    while (headIndex < allMessages.length
      && ['system', 'developer'].includes(String(allMessages[headIndex]?.role || '').toLowerCase())) {
      head.push(allMessages[headIndex]);
      headIndex += 1;
    }
    const clippedHead = head.slice(0, MESSAGE_SNAPSHOT_LIMIT);
    const tailBudget = Math.max(0, MESSAGE_SNAPSHOT_LIMIT - clippedHead.length);
    const tail = tailBudget > 0 ? allMessages.slice(headIndex).slice(-tailBudget) : [];
    const retained = [...clippedHead, ...tail];
    const droppedMessageCount = originalMessageCount - retained.length;
    let remaining = MAX_CALL_CHARS;
    const messages = retained.map((message: any) => {
      const role = String(message?.role || 'unknown').slice(0, 30);
      const content = safeMessageContent(message?.content ?? '', Math.min(16_000, remaining));
      remaining = Math.max(0, remaining - content.length);
      return { role, content, truncated: content.includes('[快照已截断]') || remaining <= 0 };
    });
    const toolText = safePromptText(input.tools || [], Math.min(remaining, 18_000));
    remaining = Math.max(0, remaining - toolText.length);
    const truncationReasons: string[] = [];
    if (droppedMessageCount > 0) {
      truncationReasons.push(`消息数量截断：原始 ${originalMessageCount} 条，快照保留 ${retained.length} 条（全部前导 system/developer 指令 + 最近的会话消息），中间 ${droppedMessageCount} 条未展示`);
    }
    if (messages.some((message) => message.truncated)) {
      truncationReasons.push('部分消息或工具快照超出字符预算被截断');
    }
    const snapshot = {
      id,
      requestId: currentRequestTraceId(),
      at: new Date().toISOString(),
      moduleId: module.id,
      moduleName: module.name,
      purpose: String(options.tracePurpose || options.label || module.name).slice(0, 180),
      provider: String(input.provider || '').slice(0, 80),
      model: String(input.model || '').slice(0, 120),
      status: 'running',
      originalMessageCount,
      retainedMessageCount: retained.length,
      droppedMessageCount,
      truncationReasons,
      messages,
      tools: toolText,
      toolChoice: safePromptText(options.tool_choice || 'auto', 500),
      responseFormat: safePromptText(options.responseFormat || '', 3000),
      response: null,
      truncated: droppedMessageCount > 0 || remaining <= 0 || messages.some((message) => message.truncated) || toolText.includes('[快照已截断]'),
    };
    promptCalls.delete(id);
    promptCalls.set(id, snapshot);
    while (promptCalls.size > MAX_PROMPT_CALLS) promptCalls.delete(promptCalls.keys().next().value!);
    return id;
  } catch {
    return '';
  }
}

export function finishPromptCall(id: string, result: Record<string, unknown> = {}) {
  try {
    const existing = promptCalls.get(String(id));
    if (!existing) return;
    const response = result.response && typeof result.response === 'object' ? result.response as Record<string, any> : {};
    existing.status = String(result.status || 'ok');
    if (result.error) existing.error = safePromptText(result.error, 1000);
    if (response) {
      existing.response = {
        content: safePromptText(response.content || '', 6000),
        toolCalls: safePromptText(response.toolCalls || [], 12_000),
        finishReason: String(response.finishReason || '').slice(0, 80),
        usage: response.usage || {},
      };
    }
    if (result.provider) existing.provider = String(result.provider).slice(0, 80);
    if (result.model) existing.model = String(result.model).slice(0, 120);
    existing.durationMs = Number(result.durationMs || 0);
  } catch {
    // Diagnostics must never change LLM behavior.
  }
}

export function listPromptCalls(limit = 24) {
  const bounded = Math.max(1, Math.min(32, Math.floor(Number(limit) || 24)));
  return [...promptCalls.values()].slice(-bounded).reverse();
}

export function clearPromptCallsForTest() {
  promptCalls.clear();
}
