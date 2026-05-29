// Long-term memory: sample collection, classification, profile updates.
// Extracted from bot.ts.
import { readDb, updateDb, nowIso } from '../store.js';
import { recordDecisionError } from '../health.js';
import { hasVisualPlaceholder, textWithoutControlPlaceholders } from './cleaning.js';
import { completeChat, llmProvider, mergeUsage } from './llm.js';
import { trustInteractionBonus } from './trust.js';

const PROFILE_FIELDS = ['summary', 'traits', 'speechStyle', 'behavior', 'preferences'];
const EMPTY_PROFILE_EXACT = new Set([
  '暂无', '无', '未知', '不明', '没有足够信息', '无法判断', '暂时无法判断', '暂无明显信息',
  '暂无有效信息', '证据不足', '样本不足', '信息不足'
]);

function getGroup(db, groupId) {
  return db.groups.find((group) => String(group.groupId) === String(groupId));
}

function meaningfulProfileText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return Boolean(text && !isEmptyProfileText(text));
}

export function isEmptyProfileText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim().replace(/[。.]$/, '');
  if (!text) return true;
  if (EMPTY_PROFILE_EXACT.has(text)) return true;
  if (/^暂无.*?(稳定)?(特征|信息|结论)([，,；;。.\s]|$)/.test(text)) return true;
  if (/^没有.*?(足够|稳定|明显|有效).*(特征|信息|结论|证据)([，,；;。.\s]|$)/.test(text)) return true;
  if (/^(证据|样本|信息)不足([，,；;。.\s]|$)/.test(text)) return true;
  return false;
}

export function hasProfileContent(memory) {
  return Boolean(memory && PROFILE_FIELDS.some((field) => meaningfulProfileText(memory[field])));
}

function profileSnapshot(memory) {
  return PROFILE_FIELDS.map((field) => `${field}:${String(memory?.[field] || '')}`).join('\n');
}

function sampleTime(sample) {
  const time = new Date(sample?.createdAt || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function sampleKey(sample) {
  const messageId = sample?.context?.messageId;
  if (messageId) return `msg:${messageId}`;
  return `text:${sample?.createdAt || ''}:${sample?.content || ''}`;
}

function sampleLooseKey(sample) {
  const groupId = sample?.context?.groupId || '';
  const day = String(sample?.createdAt || '').slice(0, 10);
  return `${groupId}:${day}:${String(sample?.content || '').slice(0, 180)}`;
}

function hasRecentProfileAttempt(memory, minutes = 30) {
  const value = memory?.lastProfileAttemptAt || memory?.lastProfiledAt || '';
  const time = new Date(value).getTime();
  return Number.isFinite(time) && Date.now() - time < minutes * 60_000;
}

function historicalSamplesFromMessages(db, memory) {
  const userId = String(memory.userId);
  return (db.messages || [])
    .filter((message) => message.role === 'user' && String(message.userId) === userId)
    .map((message) => {
      const sample = classifyMemorySample(message.content);
      if (!sample.content) return null;
      return {
        content: sample.content,
        type: sample.type,
        usedForProfile: sample.usedForProfile,
        riskLevel: sample.riskLevel || 'normal',
        reason: sample.reason,
        context: {
          groupId: String(message.groupId || ''),
          messageId: message.id,
          mentionedBot: false,
          atTargets: [],
          speakerName: message.nickname || userId,
          nearby: [],
        },
        createdAt: message.createdAt || nowIso(),
        historical: true,
      };
    })
    .filter(Boolean);
}

function collectProfileSamples(db, memory) {
  const samples = [...historicalSamplesFromMessages(db, memory), ...((memory.samples || []))];
  const byKey = new Map();
  const looseToKey = new Map();
  for (const sample of samples) {
    if (!sample?.content) continue;
    const key = sampleKey(sample);
    const looseKey = sampleLooseKey(sample);
    const existingKey = looseToKey.get(looseKey) || key;
    const existing = byKey.get(existingKey);
    const existingContext = existing?.context?.nearby?.length || 0;
    const nextContext = sample?.context?.nearby?.length || 0;
    if (!existing || nextContext > existingContext) {
      if (existingKey !== key) byKey.delete(existingKey);
      byKey.set(key, sample);
      looseToKey.set(looseKey, key);
    }
  }
  return [...byKey.values()].sort((a, b) => sampleTime(a) - sampleTime(b));
}

function selectDiverseSamples(samples, maxCount) {
  const sorted = samples.filter(Boolean).sort((a, b) => sampleTime(a) - sampleTime(b));
  if (sorted.length <= maxCount) return sorted;

  const selected = new Map();
  const byDay = new Map();
  for (const sample of sorted) {
    const day = String(sample.createdAt || '').slice(0, 10) || 'unknown';
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(sample);
  }

  for (const day of [...byDay.keys()].sort()) {
    for (const sample of byDay.get(day).slice(-3)) {
      selected.set(sampleKey(sample), sample);
      if (selected.size >= maxCount) break;
    }
    if (selected.size >= maxCount) break;
  }

  for (const sample of [...sorted].reverse()) {
    selected.set(sampleKey(sample), sample);
    if (selected.size >= maxCount) break;
  }

  return [...selected.values()].sort((a, b) => sampleTime(a) - sampleTime(b)).slice(-maxCount);
}

function commandRoleLevel(db, roleId) {
  const roles = db.settings.commandRoles || [];
  const role = roles.find((item) => item.id === roleId);
  return Number(role?.level ?? 0);
}

export function memoryImportance(db, userPolicy) {
  if (userPolicy.policy === 'owner') return { level: 0, label: 'owner 不自动记忆', remember: false };
  if (userPolicy.policy === 'blocked') return { level: 0, label: '黑名单不记忆', remember: false };
  const roleLevel = commandRoleLevel(db, userPolicy.commandRoleId || (userPolicy.policy === 'admin' || userPolicy.allowCommands ? 'admin' : 'guest'));
  if (userPolicy.policy === 'admin' || userPolicy.allowCommands || roleLevel >= commandRoleLevel(db, 'admin')) {
    return { level: 5, label: '管理员，高优先级记忆', remember: true };
  }
  if (userPolicy.policy === 'priority') return { level: 4, label: '重点关注，高优先级记忆', remember: true };
  if (userPolicy.policy === 'whitelist' || roleLevel >= 20) return { level: 3, label: '信任/白名单，中高优先级记忆', remember: true };
  if (userPolicy.policy === 'muted') return { level: 1, label: '少回应用户，低优先级记忆', remember: true };
  return { level: 2, label: '普通群友，常规记忆', remember: true };
}

function memoryThresholds(db, importance) {
  const baseMin = Number(db.settings.memoryMinMessages || 8);
  const baseEvery = Number(db.settings.memoryUpdateEvery || 8);
  const level = Number(importance.level || 2);
  return {
    minMessages: Math.max(3, baseMin - Math.max(0, level - 2) * 2 + (level <= 1 ? 4 : 0)),
    updateEvery: Math.max(3, baseEvery - Math.max(0, level - 2) * 2 + (level <= 1 ? 4 : 0)),
    maxSamples: Math.max(12, 14 + level * 6)
  };
}

function compactMemorySample(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function stripNonTextMemoryParts(text) {
  return String(text || '')
    .replace(/\[CQ:reply[^\]]+\]/g, ' ')
    .replace(/\[CQ:at,qq=[^\]]+\]/g, ' ')
    .replace(/\[分享卡片[\s\S]*?\]/g, ' ')
    .replace(/\[(图片|表情|表情包|视频|文件|语音)\]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function looksLikeMachineOutput(text) {
  const value = String(text || '').trim();
  if (value.length < 900) return false;
  const markdownSignals = (value.match(/(^|\n)\s*(#{1,3}\s+|\d+[.、]\s+|- |\* )/g) || []).length;
  const paragraphCount = value.split(/\n{2,}/).filter(Boolean).length;
  const formalSignals = /免责声明|以下内容|总结如下|综上所述|作为.*模型|无法提供|请注意|步骤如下/.test(value);
  return value.length > 1600 || markdownSignals >= 4 || paragraphCount >= 6 || formalSignals;
}

function looksLikeUnstableBanter(text) {
  const value = String(text || '').trim();
  const compact = value.replace(/\s+/g, '');
  if (!compact) return false;

  const selfDisclosure = /我(喜欢|不喜欢|讨厌|习惯|经常|一般|通常|希望|想要|需要|偏好|雷点|比较|是|不是|会|不会)|以后|记住|别叫我|叫我/.test(value);
  if (selfDisclosure && compact.length > 12) return false;

  const addressesBot = /(你|机器人|bot|wuxin|无心|diaz)/i.test(value);
  const jokeSignals = /逗你|开玩笑|骗你的|别当真|口嗨|随口|测试|test|钓鱼|反串|整活|节目效果|乱说|胡说|瞎说|破防|急了|绷|乐|笑死|典|孝|抽象|逆天/.test(value);
  const insultSignals = /傻逼|弱智|脑残|废物|有病|神经病|恶心|滚|爬|你妈|nm|sb|nt|出生|畜生|蠢|笨|垃圾|阴湿|阴暗|嘴臭|攻击性/.test(value);

  if (/逗你|开玩笑|骗你的|别当真|测试|test/i.test(value)) return true;
  if (compact.length <= 32 && (jokeSignals || insultSignals)) return true;
  if (addressesBot && (jokeSignals || insultSignals) && compact.length <= 80) return true;
  return /(他|她|这人|你|bot|机器人).{0,8}(傻|蠢|弱智|脑残|恶心|垃圾|阴湿|攻击性|嘴臭)/.test(value) && compact.length <= 60;
}

function looksLikeOneOffQuestion(text) {
  const value = String(text || '').trim();
  const compact = value.replace(/\s+/g, '');
  if (compact.length > 42) return false;
  if (/我(喜欢|不喜欢|讨厌|习惯|经常|一般|通常|希望|想要|需要|偏好|雷点|正在|已经|以后)/.test(value)) return false;
  return /(怎么办|怎么弄|怎么搞|如何|有没有|能不能|可以吗|是不是|什么|为啥|为什么|咋办|吗|？|\?)/.test(value);
}

// Independent check: sensitive identity/orientation/psychological-state claims
// that should never enter profile at normal confidence, regardless of banter detection.
function looksLikeSensitiveClaim(text) {
  const value = String(text || '').trim();
  if (!value) return { sensitive: false, thirdParty: false };
  // First-person or self-disclosure
  const firstPerson = /我.{0,4}(抑郁症|焦虑症|双相|精神分裂|人格分裂|心理(有问题|疾病|障碍)|性取向|性倾向|性癖|XP|是同性恋|是双性恋|是跨性别|是变性|有自杀|想自杀|想死|不想活|自残|割腕|吃药自杀)/.test(value);
  // Third-party claims about others — audit only, never use
  const thirdParty = /(他|她|这人|那个人|这人|这货|那货).{0,6}(是同性恋|是双性恋|是跨性别|是变性|有抑郁症|有焦虑症|精神病|神经病|心理(有问题|疾病|障碍|变态)|性取向|性倾向|性癖|XP|搞基|是gay|是les|拉拉)/i.test(value);
  return { sensitive: firstPerson || thirdParty, thirdParty };
}

export function classifyMemorySample(text) {
  const raw = String(text || '').trim();
  if (!raw) return { type: 'media', content: '', usedForProfile: false, riskLevel: 'normal', reason: '空消息不进入画像' };
  if (raw.startsWith('/')) {
    return { type: 'command', content: compactMemorySample(raw), usedForProfile: false, riskLevel: 'normal', reason: '指令不进入画像' };
  }
  if (/\[分享卡片/.test(raw)) {
    return { type: 'card', content: compactMemorySample(raw), usedForProfile: false, riskLevel: 'low-confidence', reason: '分享/转发卡片作为低权重背景，需结合真实发言判断' };
  }
  // Other bots' output: CQ markdown, JSON blobs, bot-style prefixes
  if (/\[CQ:markdown/.test(raw) || /^\[CQ:json/.test(raw) || /^\[CQ:xml/.test(raw)) {
    return { type: 'bot-output', content: compactMemorySample(raw), usedForProfile: false, riskLevel: 'normal', reason: '其他bot的消息不进入画像' };
  }
  const realText = stripNonTextMemoryParts(raw);
  if (!realText && hasVisualPlaceholder(raw)) {
    return { type: 'media', content: compactMemorySample(raw), usedForProfile: false, riskLevel: 'normal', reason: '纯媒体不进入画像' };
  }
  if (!realText) {
    return { type: 'media', content: compactMemorySample(raw), usedForProfile: false, riskLevel: 'normal', reason: '没有可用于画像的真实文本' };
  }
  if (hasVisualPlaceholder(raw)) {
    const selfDisclosureWithImage = /我.{0,12}(喜欢|不喜欢|讨厌|习惯|经常|一般|通常|希望|想要|需要|偏好|雷点|画|做|拍|录|剪|收藏|保存|发这个|发图)|这是我|我的/.test(realText);
    if (!selfDisclosureWithImage && realText.length <= 100) {
      return {
        type: 'media',
        content: compactMemorySample(raw),
        usedForProfile: false,
        riskLevel: 'low-confidence',
        reason: '图片配文不直接进入画像，等待多模态图片摘要低权重处理'
      };
    }
  }
  if (looksLikeMachineOutput(realText)) {
    return { type: 'bot-output', content: compactMemorySample(realText), usedForProfile: false, riskLevel: 'normal', reason: '疑似超长机器生成内容，不进入画像' };
  }
  // Independent sensitive claim check — applies regardless of other filters
  const sensitiveCheck = looksLikeSensitiveClaim(realText);
  if (sensitiveCheck.thirdParty) {
    return { type: 'text', content: compactMemorySample(realText), usedForProfile: false, riskLevel: 'high-risk', reason: '第三人称敏感声明，仅审计不入画像' };
  }
  let baseRisk = 'normal';
  let baseReason = '真实文本，用于画像';
  if (sensitiveCheck.sensitive) {
    baseRisk = 'low-confidence';
    baseReason = '涉及敏感自述，降为低置信观察';
  }
  if (looksLikeUnstableBanter(realText)) {
    const risk = sensitiveCheck.sensitive ? 'high-risk' : 'low-confidence';
    return { type: 'text', content: compactMemorySample(realText), usedForProfile: false, riskLevel: risk, reason: '疑似玩梗/测试/临时情绪' + (sensitiveCheck.sensitive ? '，涉及敏感推断' : '，需多次稳定出现') };
  }
  if (looksLikeOneOffQuestion(realText)) {
    return { type: 'text', content: compactMemorySample(realText), usedForProfile: false, riskLevel: baseRisk !== 'normal' ? baseRisk : 'low-confidence', reason: '疑似一次性提问或假设话题，不单独用于画像' };
  }
  // Too short to be useful for profiling
  const cjkChars = (realText.match(/[一-鿿㐀-䶿]/g) || []).length;
  const meaningfulLen = cjkChars + (realText.replace(/[一-鿿㐀-䶿]/g, '').replace(/\s/g, '').length);
  if (meaningfulLen < 5) {
    return { type: 'text', content: compactMemorySample(realText), usedForProfile: false, riskLevel: 'normal', reason: '文本过短，信息量不足以用于画像' };
  }
  // Normal text but with sensitive claim: keep as low-confidence, still used but with caveat
  if (sensitiveCheck.sensitive) {
    return { type: 'text', content: compactMemorySample(realText), usedForProfile: true, riskLevel: 'low-confidence', reason: baseReason };
  }
  return { type: 'text', content: compactMemorySample(realText), usedForProfile: true, riskLevel: 'normal', reason: '真实文本，用于画像' };
}

function captureContext(db, event) {
  const nearby = (db.messages || [])
    .filter((m) => String(m.groupId) === String(event.groupId) && m.inContext !== false)
    .slice(-7)
    .map((m) => ({
      role: m.role,
      userId: String(m.userId),
      nickname: m.nickname || String(m.userId),
      content: textWithoutControlPlaceholders(m.content).slice(0, 120),
      createdAt: m.createdAt,
    }));
  return {
    groupId: String(event.groupId),
    messageId: event.messageId,
    mentionedBot: event.atTargets && event.atTargets.length > 0,
    atTargets: event.atTargets || [],
    speakerName: event.nickname || event.userId,
    nearby,
  };
}

export function recordMemoryObservation(event, userPolicy) {
  const db = readDb();
  if (db.settings.memoryEnabled === false) return { shouldUpdate: false, reason: '长期记忆已关闭' };
  if (event.type === 'group' && !getGroup(db, event.groupId)?.enabled) {
    return { shouldUpdate: false, reason: '未启用群不进入长期记忆' };
  }
  const importance = memoryImportance(db, userPolicy);
  if (!importance.remember) return { shouldUpdate: false, reason: importance.label };
  const sample = classifyMemorySample(event.text);
  if (!sample.content && sample.type === 'text') return { shouldUpdate: false, reason: '空消息不进入长期记忆' };
  let shouldUpdate = false;
  updateDb((draft) => {
    if (!draft.memories) draft.memories = [];
    let memory = draft.memories.find((entry) => String(entry.userId) === String(event.userId));
    if (!memory) {
      memory = {
        id: crypto.randomUUID(), userId: event.userId, nickname: event.nickname || event.userId,
        enabled: true, importanceLevel: importance.level, importanceLabel: importance.label,
        messageCount: 0, profileMessageCount: 0, pendingCount: 0, groupsSeen: [],
        samples: [], summary: '', traits: '', speechStyle: '', behavior: '', preferences: '',
        manualNotes: '', profilingRule: '', profileMeta: {}, recentDynamics: [], createdAt: nowIso(), updatedAt: nowIso()
      };
      draft.memories.push(memory);
    }
    const thresholds = memoryThresholds(draft, importance);
    const trustMul = trustInteractionBonus(draft, event.userId).memoryThresholdMul;
    thresholds.minMessages = Math.max(2, Math.round(thresholds.minMessages * trustMul));
    thresholds.updateEvery = Math.max(2, Math.round(thresholds.updateEvery * trustMul));
    memory.nickname = event.nickname || memory.nickname || event.userId;
    memory.enabled = memory.enabled !== false;
    memory.importanceLevel = Math.max(Number(memory.importanceLevel || 0), importance.level);
    memory.importanceLabel = importance.label;
    memory.messageCount = Number(memory.messageCount || 0) + 1;
    memory.profileMessageCount = Number(memory.profileMessageCount || 0);
    if (sample.usedForProfile) {
      memory.profileMessageCount += 1;
      memory.pendingCount = Number(memory.pendingCount || 0) + 1;
    }
    if (!memory.samples) memory.samples = [];
    const context = captureContext(draft, event);
    memory.samples.push({
      content: sample.content, type: sample.type, usedForProfile: sample.usedForProfile,
      media: event.images?.length ? { images: compactMemoryImages(event.images) } : undefined,
      riskLevel: sample.riskLevel || 'normal', reason: sample.reason, context, createdAt: nowIso()
    });
    const sampleRetention = Math.max(thresholds.maxSamples, Number(draft.settings.memorySampleRetain || 120));
    memory.samples = memory.samples.slice(-sampleRetention);
    if (!memory.groupsSeen) memory.groupsSeen = [];
    if (!memory.groupsSeen.includes(String(event.groupId))) memory.groupsSeen.push(String(event.groupId));
    memory.updatedAt = nowIso();
    const needsInitialProfile = !hasProfileContent(memory) && memory.profileMessageCount >= thresholds.minMessages;
    const bootstrapReady = needsInitialProfile
      && memory.pendingCount >= 1
      && !hasRecentProfileAttempt(memory, 30);
    if (memory.profileMessageCount >= thresholds.minMessages && (memory.pendingCount >= thresholds.updateEvery || bootstrapReady)) {
      shouldUpdate = true;
    }
  });
  return { shouldUpdate, reason: shouldUpdate ? '达到画像更新阈值' : (memoryImportance(readDb(), userPolicy).label) };
}

function cleanImageSummary(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/^图片摘要[:：]\s*/i, '')
    .trim()
    .slice(0, 260);
}

export async function maybeRecordImageMemorySummary(event, userPolicy) {
  const db = readDb();
  if (db.settings.memoryEnabled === false) return { ok: false, reason: '长期记忆已关闭' };
  if (!event.images?.length) return { ok: false, reason: '没有图片' };
  if (!canUseVisionForMemory(db)) return { ok: false, reason: '当前模型/供应商不支持视觉记忆' };
  if (event.type === 'group' && !getGroup(db, event.groupId)?.enabled) {
    return { ok: false, reason: '未启用群不进入长期记忆' };
  }
  const importance = memoryImportance(db, userPolicy);
  if (!importance.remember) return { ok: false, reason: importance.label };
  const caption = textWithoutControlPlaceholders(event.text).slice(0, 240);
  const mentionedBot = db.settings.selfQq && (event.atTargets || []).some((qq) => String(qq) === String(db.settings.selfQq));
  const pureImagePolicy = String(db.settings.visionMemoryPureImagePolicy || 'important');
  if (!caption && !mentionedBot && pureImagePolicy === 'off') {
    return { ok: false, reason: '无配文图片摘要已关闭' };
  }
  if (!caption && !mentionedBot && pureImagePolicy !== 'all' && importance.level < 3) {
    return { ok: false, reason: '普通群友无配文图片不自动做视觉摘要，避免成本和画像污染' };
  }

  let response;
  try {
    response = await completeChat(db, {
      messages: [
        {
          role: 'system',
          content: `你是图片记忆摘要器。基于用户本轮发送的图片，输出一段中文短摘要。
要求：
1. 只描述图片本身和用户配文能直接支持的内容。
2. 不要推断用户性格、身份、心理状态、取向、疾病、现实关系。
3. 不要把梗图/截图/转发内容当成用户本人观点。
4. 输出 1 句，最多 80 字，不要 markdown。`
        },
        {
          role: 'user',
          content: `发言者：${event.nickname || event.userId}（QQ:${event.userId}）\n用户配文：${caption || '无'}\n请总结图片可见内容，供长期记忆低权重参考。`
        }
      ],
      visionImages: event.images,
      temperature: 0.2,
      maxTokens: 260,
      label: '图片记忆摘要'
    });
  } catch (error) {
    recordDecisionError(`图片记忆摘要失败：${error.message || String(error)}`);
    updateDb((draft) => {
      if (!draft.usage) draft.usage = { totalTokens: 0, promptTokens: 0, completionTokens: 0, requests: 0, replies: 0, errors: 0 };
      draft.usage.errors = Number(draft.usage.errors || 0) + 1;
    });
    return { ok: false, reason: error.message || String(error) };
  }

  const summary = cleanImageSummary(response.text);
  if (!summary || /无法|不能|看不到|未收到|没有图片|图片不可读|传输失败/.test(summary)) {
    return { ok: false, reason: '图片摘要为空或不可用' };
  }

  let shouldUpdate = false;
  updateDb((draft) => {
    if (!draft.memories) draft.memories = [];
    let memory = draft.memories.find((entry) => String(entry.userId) === String(event.userId));
    if (!memory) {
      memory = {
        id: crypto.randomUUID(), userId: event.userId, nickname: event.nickname || event.userId,
        enabled: true, importanceLevel: importance.level, importanceLabel: importance.label,
        messageCount: 0, profileMessageCount: 0, pendingCount: 0, groupsSeen: [],
        samples: [], summary: '', traits: '', speechStyle: '', behavior: '', preferences: '',
        manualNotes: '', profilingRule: '', profileMeta: {}, recentDynamics: [], createdAt: nowIso(), updatedAt: nowIso()
      };
      draft.memories.push(memory);
    }
    if ((memory.samples || []).some((sample) => sample.type === 'image-summary' && sample.context?.messageId === event.messageId)) return;

    const thresholds = memoryThresholds(draft, importance);
    const trustMul = trustInteractionBonus(draft, event.userId).memoryThresholdMul;
    thresholds.minMessages = Math.max(2, Math.round(thresholds.minMessages * trustMul));
    thresholds.updateEvery = Math.max(2, Math.round(thresholds.updateEvery * trustMul));
    const context = captureContext(draft, event);
    const content = caption
      ? `图片摘要：${summary}；用户配文：${caption}`
      : `图片摘要：${summary}`;

    memory.nickname = event.nickname || memory.nickname || event.userId;
    memory.enabled = memory.enabled !== false;
    memory.importanceLevel = Math.max(Number(memory.importanceLevel || 0), importance.level);
    memory.importanceLabel = importance.label;
    memory.profileMessageCount = Number(memory.profileMessageCount || 0) + 1;
    memory.pendingCount = Number(memory.pendingCount || 0) + 1;
    if (!memory.samples) memory.samples = [];
    memory.samples.push({
      content,
      type: 'image-summary',
      media: { images: compactMemoryImages(event.images) },
      usedForProfile: true,
      riskLevel: 'low-confidence',
      reason: '图片摘要低权重进入画像；必须结合文字或多次稳定主题，不能单独推断人格',
      context,
      createdAt: nowIso()
    });
    const sampleRetention = Math.max(thresholds.maxSamples, Number(draft.settings.memorySampleRetain || 120));
    memory.samples = memory.samples.slice(-sampleRetention);
    if (!memory.groupsSeen) memory.groupsSeen = [];
    if (!memory.groupsSeen.includes(String(event.groupId))) memory.groupsSeen.push(String(event.groupId));
    memory.updatedAt = nowIso();

    if (!draft.usage) draft.usage = { totalTokens: 0, promptTokens: 0, completionTokens: 0, requests: 0, errors: 0 };
    const usage = response.usage || {};
    draft.usage.requests += 1;
    draft.usage.totalTokens += usage.total_tokens || 0;
    draft.usage.promptTokens += usage.prompt_tokens || 0;
    draft.usage.completionTokens += usage.completion_tokens || 0;
    if (!draft.usageEvents) draft.usageEvents = [];
    draft.usageEvents.push({
      id: crypto.randomUUID(), groupId: event.groupId, userId: event.userId,
      model: response.model || draft.settings.model, kind: 'image-memory-summary',
      totalTokens: usage.total_tokens || 0,
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      createdAt: nowIso()
    });
    draft.usageEvents = draft.usageEvents.slice(-5000);

    const needsInitialProfile = !hasProfileContent(memory) && memory.profileMessageCount >= thresholds.minMessages;
    const bootstrapReady = needsInitialProfile && memory.pendingCount >= 1 && !hasRecentProfileAttempt(memory, 30);
    shouldUpdate = memory.profileMessageCount >= thresholds.minMessages && (memory.pendingCount >= thresholds.updateEvery || bootstrapReady);
  });

  if (shouldUpdate) void maybeUpdateMemoryProfile(event);
  return { ok: true, shouldUpdate, summary };
}

const STOP_BIGRAMS = new Set([
  '今天','昨天','明天','刚刚','感觉','觉得','好像','应该','可能','已经','还是','不过',
  '这个','那个','什么','怎么','为什么','是不是','有没有','一个','可以','就是','不是',
  '吗','吧','呢','啊','了','的','我','你','他','她','它','们','这','那','很','都','也','就','才',
  '一下','一点','有点','有点','不会','会对','会对','在吗','吗我','我了','了我',
]);

const SPECIAL_TERMS = /cs2|osu|owc|deepseek|v4|api|gpt|bot|npm|node|jsx|css|react|vite|onebot|napcat|qq/gi;
const SPECIAL_TERMS_NG = /cs2|osu|owc|deepseek|v4|api|gpt|bot|npm|node|jsx|css|react|vite|onebot|napcat|qq/i;

function tokenizeCJK(text) {
  const tokens = [];
  const lowered = text.toLowerCase();
  // Extract special terms (game names, tech terms) — higher weight
  const specials = lowered.match(SPECIAL_TERMS) || [];
  tokens.push(...specials);
  // Extract other Latin/ASCII words (skip if already captured as special)
  const latinWords = lowered.match(/[a-zA-Z0-9]{2,}/g) || [];
  for (const w of latinWords) { if (!specials.includes(w)) tokens.push(w); }
  // Extract CJK bigrams, filter stop words
  const cjk = lowered.replace(/[a-zA-Z0-9\s,，。！？!?:：;；""''【】\[\]()（）\/\\@#\$%^&*+=~`|<>{}0-9]+/g, '');
  for (let i = 0; i < cjk.length - 1; i++) {
    const bg = cjk.slice(i, i + 2);
    if (!STOP_BIGRAMS.has(bg)) tokens.push(bg);
  }
  return tokens;
}

export function clusterSamplesByTopic(samples) {
  const clusters = [];
  for (const s of samples) {
    const text = String(s.content || '').toLowerCase();
    const tokens = tokenizeCJK(text);
    let matched = false;
    for (const c of clusters) {
      const tokenSet = new Set(tokens);
      const clusterSet = new Set(c.keywords);
      const intersection = [...tokenSet].filter((t) => clusterSet.has(t));
      const union = new Set([...tokenSet, ...clusterSet]);
      const jaccard = union.size > 0 ? intersection.length / union.size : 0;
      const hasSpecial = intersection.some((t) => SPECIAL_TERMS_NG.test(t));
      // Match: 2+ tokens overlap OR special term match OR Jaccard >= 0.25
      if (intersection.length >= 2 || hasSpecial || jaccard >= 0.25) {
        c.samples.push(s);
        for (const t of tokens) { if (!c.keywords.includes(t)) c.keywords.push(t); }
        c.keywords = c.keywords.slice(0, 12);
        matched = true; break;
      }
    }
    if (!matched) {
      clusters.push({ keywords: [...new Set(tokens)].slice(0, 8), samples: [s] });
    }
  }
  return clusters;
}

export function computeTopicWeights(clusters) {
  const weights = [];
  for (const c of clusters) {
    const sampleCount = c.samples.length;
    const uniqueDays = new Set(c.samples.map((s) => (s.createdAt || '').slice(0, 10))).size;
    const uniqueGroups = new Set(c.samples.map((s) => s.context?.groupId || 'unknown')).size;
    // Cross-day (>=2 days) = long-term candidate. Cross-group alone = bonus, not enough.
    const isCrossSession = uniqueDays >= 2;
    const crossGroupBonus = uniqueGroups >= 2 ? 0.15 : 0;
    const weight = Math.min(1, (isCrossSession ? sampleCount * 0.3 : sampleCount * 0.08) + crossGroupBonus);
    weights.push({ cluster: c, sampleCount, uniqueDays, uniqueGroups, isCrossSession, weight });
  }
  return weights;
}

export async function updateMemoryProfile(db, memory) {
  const sourceSamples = collectProfileSamples(db, memory);
  const usedSamples = selectDiverseSamples(sourceSamples.filter((s) => s.usedForProfile && s.content), 48);
  const weakSamples = selectDiverseSamples(sourceSamples.filter((s) => !s.usedForProfile && s.content && s.type === 'card'), 8);
  const cardText = weakSamples.slice(-8).map((s) => s.content).join('\n');
  const sampleDayCount = new Set(usedSamples.map((s) => String(s.createdAt || '').slice(0, 10)).filter(Boolean)).size;
  const sampleGroupCount = new Set(usedSamples.map((s) => s.context?.groupId).filter(Boolean)).size;

  // V2 anti-recency gating
  const useV2 = db.settings.profileAntiRecencyV2 === true;

  // Topic clustering for anti-recency pollution (V2 only)
  const clusters = useV2 ? clusterSamplesByTopic(usedSamples) : [];
  const topicWeights = useV2 ? computeTopicWeights(clusters) : [];
  const recentDynamicsBlock = topicWeights.filter((tw) => !tw.isCrossSession && tw.sampleCount >= 2).map((tw) => {
    const keywords = tw.cluster.keywords.slice(0, 4).join(',');
    return `短期话题(${keywords}): ${tw.sampleCount}条/${tw.uniqueDays}天 · 权重${Math.round(tw.weight * 100)}% · 仅单场景，不应写入长期画像`;
  }).join('\n');
  const longTermBlock = topicWeights.filter((tw) => tw.isCrossSession).map((tw) => {
    const keywords = tw.cluster.keywords.slice(0, 4).join(',');
    return `长期候选(${keywords}): ${tw.sampleCount}条/${tw.uniqueDays}天/${tw.uniqueGroups}群`;
  }).join('\n');

  // Format samples as context blocks instead of isolated lines
  const promptSamples = selectDiverseSamples(usedSamples, 24);
  const sampleBlocks = promptSamples.map((s, i) => {
    const ctx = s.context;
    let block = `[样本 #${i + 1}]\n发言者：${memory.nickname || memory.userId}\n内容：${s.content}`;
    block += `\n样本类型：${s.type || 'text'}`;
    if (ctx && ctx.nearby && ctx.nearby.length > 0) {
      block += '\n上下文对话：';
      for (const m of ctx.nearby.slice(-5)) {
        const who = m.role === 'assistant' ? 'Wuxin' : (m.nickname || m.userId);
        block += `\n  - ${who}：${m.content}`;
      }
    }
    if (ctx) {
      block += `\n@了谁：${ctx.atTargets.length ? ctx.atTargets.join(',') : '无'}`;
      block += `\n是否@了bot：${ctx.mentionedBot ? '是' : '否'}`;
    }
    block += `\n当前风险等级：${s.riskLevel || 'normal'}`;
    block += `\n当前分类理由：${s.reason}`;
    return block;
  }).join('\n\n');

  // Check if old profile was generated without context awareness (legacy)
  const hasContextSamples = usedSamples.some((s) => s.context && s.context.nearby && s.context.nearby.length > 0);
  const hasProfileMeta = memory.profileMeta && Object.keys(memory.profileMeta).length > 0;
  const isLegacyProfile = !hasContextSamples || !hasProfileMeta;

  const existing = [
    memory.summary && `整体：${memory.summary}`,
    memory.traits && `性格：${memory.traits}`,
    memory.speechStyle && `说话：${memory.speechStyle}`,
    memory.behavior && `行为：${memory.behavior}`,
    memory.preferences && `偏好：${memory.preferences}`,
    memory.manualNotes && `备注：${memory.manualNotes}`
  ].filter(Boolean).join('\n');
  const response = await completeChat(db, {
    messages: [
      { role: 'system', content: `你是群友画像更新器。根据发言样本更新画像。输出 patch 模式 JSON，不要整份重写。

输出格式（纯JSON，无markdown包裹）：
{
  "longTermUpdates": {"summary":"...","traits":"...","speechStyle":"...","behavior":"...","preferences":"..."},
  "recentDynamicsUpdates": [{"topic":"...","summary":"...","confidence":0.5}],
  "preserveExisting": ["summary","traits","speechStyle","behavior","preferences"],
  "removeOrDowngrade": [{"field":"preferences","topic":"CS2","phrase":"对CS2抱有极大兴趣","reason":"单场景高频，降为近期动态","groups":["群号"]}],
  "confidence": {"traits":0.5,"speechStyle":0.5,"behavior":0.5,"preferences":0.5}
}

规则：
1. 长期画像(longTermUpdates)只写跨时间(>=2天)或跨群、多次独立证据支持的稳定特征。单日/单场景高频话题不能写入长期画像。
1.1 如果已有长期画像为空，且样本统计显示真实文本跨越>=2天或>=12条，请至少给出中性、保守的 summary/behavior/speechStyle；不要只返回空对象或 preserveExisting。
2. 短期高频话题(昨晚多聊/今天多聊了某话题)只能写入 recentDynamicsUpdates，不能覆盖长期画像。
3. preserveExisting 列出应保留的旧画像字段（默认全部保留，只删有冲突的）。
4. removeOrDowngrade 列出应降级或移除的字段及原因。
5. 绝对化措辞（极大兴趣/非常热爱/核心爱好）一律降级为中性表述，除非证据跨时间稳定。
6. 同一晚、同一话题的多条消息合并计算，不能线性放大。
7. 禁止侮辱性标签。禁止推断身份/取向/心理状态。
8. image-summary 是用户发图后的视觉摘要，只能作为低权重兴趣/话题背景；不能单独据此推断性格、身份、心理状态或现实关系。只有图片摘要与用户真实文本或跨天多图主题互相支持时，才能写入长期画像。
${isLegacyProfile ? '- 旧版画像缺上下文，与上下文样本一致的保留，单薄矛盾的覆盖。' : ''}
${memory.profilingRule ? `- 【硬性约束】${memory.profilingRule}` : ''}` },
      { role: 'user', content: `QQ号：${memory.userId}\n昵称：${memory.nickname || memory.userId}\n\n样本统计：真实文本 ${usedSamples.length} 条，覆盖 ${sampleDayCount} 天 / ${sampleGroupCount} 个群。提示：统计来自长期历史与最近上下文混合取样，不只是最近几十条。\n\n已有长期画像：\n${existing}${useV2 ? `\n已有近期动态：\n${JSON.stringify((memory.recentDynamics || []).slice(-5).map((d) => d.topic + ': ' + d.summary))}\n\n话题聚类分析：\n${longTermBlock || '无跨场景长期候选'}\n${recentDynamicsBlock || '无短期高频话题'}` : ''}\n\n样本与上下文：\n${sampleBlocks}\n\n低权重背景：\n${cardText}` }
    ],
    temperature: 0.2, maxTokens: 1000, label: '画像更新'
  });
  try {
    return { profile: parseProfileJson(response.text || '{}'), usage: response.usage || {} };
  } catch (firstError) {
    const retry = await completeChat(db, {
      messages: [
        { role: 'system', content: `你是 JSON 修复器。只把输入修复为合法 JSON，不新增画像结论，不输出 markdown。
必须输出对象，结构：
{"longTermUpdates":{},"recentDynamicsUpdates":[],"preserveExisting":[],"removeOrDowngrade":[],"confidence":{}}
如果原文无法修复，输出上述空对象。` },
        { role: 'user', content: `上一轮画像 JSON 解析失败：${firstError.message}\n\n原始输出：\n${String(response.text || '').slice(0, 6000)}` }
      ],
      temperature: 0,
      maxTokens: 1200,
      label: '画像JSON修复'
    });
    return {
      profile: parseProfileJson(retry.text || '{}'),
      usage: mergeUsage(response.usage || {}, retry.usage || {})
    };
  }
}

function canUseVisionForMemory(db) {
  if (db.settings.visionMemoryEnabled === false) return false;
  const provider = llmProvider(db);
  const apiBase = String(db.settings.apiBaseUrl || '').toLowerCase();
  if (provider === 'deepseek' || apiBase.includes('api.deepseek.com')) return false;
  const mode = String(db.settings.visionMode || 'auto').toLowerCase();
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  const probe = [
    db.settings.llmProvider,
    db.settings.apiBaseUrl,
    db.settings.model,
    db.settings.customModel
  ].filter(Boolean).join(' ').toLowerCase();
  return /(mimo|vision|visual|multimodal|multi-modal|omni|gpt-4o|qwen[-_\s]?.*vl|glm[-_\s]?.*4v|yi[-_\s]?.*vision|(?:^|[-_\s])vl(?:$|[-_\s]))/i.test(probe);
}

function compactMemoryImages(images = []) {
  return images.slice(0, 4).map((image) => ({
    type: 'image',
    url: String(image.url || '').startsWith('data:') ? '' : String(image.url || '').slice(0, 600),
    file: String(image.file || '').slice(0, 600)
  })).filter((image) => image.url || image.file);
}

function stripJsonFence(raw) {
  return String(raw || '')
    .replace(/^\s*```json\s*/i, '')
    .replace(/^\s*```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

function extractJsonObject(text) {
  const value = stripJsonFence(text);
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start >= 0 && end > start) return value.slice(start, end + 1);
  return value;
}

function repairJsonText(text) {
  let value = extractJsonObject(text);
  value = value
    .replace(/,\s*}/g, '}')
    .replace(/,\s*]/g, ']')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");

  const bracketOpens = (value.match(/\[/g) || []).length;
  const bracketCloses = (value.match(/]/g) || []).length;
  if (bracketOpens > bracketCloses) value += ']'.repeat(bracketOpens - bracketCloses);

  const opens = (value.match(/{/g) || []).length;
  const closes = (value.match(/}/g) || []).length;
  if (opens > closes) value += '}'.repeat(opens - closes);
  return value;
}

function parseProfileJson(raw) {
  const attempts = [
    stripJsonFence(raw),
    extractJsonObject(raw),
    repairJsonText(raw),
  ];
  let lastError = null;
  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('画像 JSON 解析失败');
}

function flattenProfileValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.slice(0, 360);
  if (typeof value === 'object') {
    // LLM sometimes returns { "性格": "xxx" } instead of a plain string
    return Object.values(value).map((v) => String(v || '')).join('；').slice(0, 360);
  }
  return String(value).slice(0, 360);
}

function normalizeProfileValue(value, previous = '') {
  let text = flattenProfileValue(value).replace(/\s+/g, ' ').trim();
  if (!text) return previous || '';
  if (isEmptyProfileText(text)) return meaningfulProfileText(previous) ? previous : '';

  const originalText = text;
  const severeTerms = /傻逼|弱智|脑残|废物|垃圾|恶心|有病|神经病|变态|低素质|畜生|出生|不正常|病态/i;
  const unsafeTerms = /傻逼|弱智|脑残|废物|垃圾|恶心|有病|神经病|变态|阴暗|阴湿|嘴臭|攻击性|低素质|畜生|出生|阴阳怪气|不正常|病态/i;
  if (!unsafeTerms.test(text)) return text;

  text = text
    .replace(/嘴臭|爱骂人|骂人多/g, '表达比较直接')
    .replace(/攻击性(很强|较强|偏强|强)?/g, '表达有时偏强烈')
    .replace(/阴暗|阴湿/g, '偶尔使用自嘲或玩梗表达')
    .replace(/阴阳怪气/g, '表达带玩笑或讽刺色彩')
    .replace(/傻逼|弱智|脑残|废物|垃圾|恶心|有病|神经病|变态|低素质|畜生|出生|不正常|病态/gi, '')
    .replace(/[，,、；;]\s*[，,、；;]+/g, '；')
    .replace(/^[，,、；;\s]+|[，,、；;\s]+$/g, '')
    .trim();

  if (severeTerms.test(originalText) && (text.length < 10 || /这个人(又|很|比较)?$/.test(text) || /又$/.test(text))) {
    return previous || '';
  }
  if (!text || unsafeTerms.test(text)) return previous || '';
  return text.slice(0, 360);
}

export function applyProfileUpdate(target, profile) {
  // Patch mode: merge longTermUpdates, add recentDynamics
  const updates = profile.longTermUpdates || profile;
  const preserve = profile.preserveExisting || [];
  const remove = profile.removeOrDowngrade || [];
  const recentUpdates = profile.recentDynamicsUpdates || [];
  const before = profileSnapshot(target);
  let recentChanged = false;

  for (const field of PROFILE_FIELDS) {
    if (isEmptyProfileText(target[field])) target[field] = '';
  }

  // Apply long-term updates (only for non-preserved fields, or if new value is meaningful)
  const longFields = PROFILE_FIELDS;
  for (const field of longFields) {
    const newVal = updates[field];
    if (newVal && (!preserve.includes(field) || !meaningfulProfileText(target[field]))) {
      const normalized = normalizeProfileValue(newVal, target[field] || '');
      if (normalized && normalized !== target[field]) target[field] = normalized;
    }
  }

  // Handle downgrades — phrase-level, not field-level wipe
  for (const item of remove) {
    if (item.field && longFields.includes(item.field)) {
      const oldVal = target[item.field] || '';
      if (item.phrase && oldVal.includes(item.phrase)) {
        // Remove only the specific phrase, keep rest
        target[item.field] = oldVal.replace(new RegExp(item.phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '').replace(/[，,、；;]\s*[，,、；;]+/g, '；').replace(/^[，,、；;\s]+|[，,、；;\s]+$/g, '').trim();
        if (!target.recentDynamics) target.recentDynamics = [];
        target.recentDynamics.push({
          topic: item.topic || item.reason || '降级内容',
          summary: item.phrase.slice(0, 200),
          evidenceCount: 1, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
          groups: item.groups || [], confidence: 0.3,
        });
        recentChanged = true;
      } else if (!item.phrase) {
        // No phrase = log warning, don't wipe field, only add recent dynamics
        if (!target.recentDynamics) target.recentDynamics = [];
        target.recentDynamics.push({
          topic: item.topic || item.reason || '降级警告(未指定短语,已保留长期画像)',
          summary: (item.reason || '') + ' — 原内容已保留',
          evidenceCount: 1, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
          groups: item.groups || [], confidence: 0.2,
        });
        recentChanged = true;
      }
    }
  }

  // Add/update recent dynamics
  if (!target.recentDynamics) target.recentDynamics = [];
  for (const rd of recentUpdates) {
    if (!rd.topic || !rd.summary) continue;
    const existing = target.recentDynamics.find((d) => d.topic === rd.topic);
    // Extract groups: prefer LLM-provided rd.groups, else from sample context
    let rdGroups = (rd.groups && rd.groups.length > 0) ? rd.groups : [];
    if (rdGroups.length === 0) {
      const allSamples = (target.samples || []).slice(-30);
      rdGroups = [...new Set(allSamples.map((s) => s.context?.groupId).filter(Boolean))];
    }
    if (existing) {
      existing.summary = rd.summary.slice(0, 300);
      existing.evidenceCount = (existing.evidenceCount || 1) + 1;
      existing.lastSeenAt = new Date().toISOString();
      existing.confidence = Math.min(1, (existing.confidence || 0.3) + 0.1);
      if (rdGroups.length > 0) existing.groups = [...new Set([...(existing.groups || []), ...rdGroups])];
      recentChanged = true;
    } else {
      target.recentDynamics.push({
        topic: rd.topic, summary: rd.summary.slice(0, 300),
        evidenceCount: 1, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
        groups: rdGroups, confidence: rd.confidence || 0.3,
      });
      recentChanged = true;
    }
  }

  // Decay old recent dynamics (older than 7 days -> reduce confidence, older than 14 -> remove)
  const now = Date.now();
  target.recentDynamics = (target.recentDynamics || []).filter((rd) => {
    const age = now - new Date(rd.lastSeenAt || rd.firstSeenAt).getTime();
    if (age > 14 * 86400000) return false;
    if (age > 7 * 86400000) rd.confidence = Math.max(0.1, (rd.confidence || 0.3) * 0.5);
    return true;
  }).slice(-15);

  // Save confidence
  const conf = profile.confidence || {};
  if (!target.profileMeta) target.profileMeta = {};
  const fields = ['traits', 'speechStyle', 'behavior', 'preferences'];
  const evidenceCounts = countEvidenceByField(target.samples || []);
  for (const field of fields) {
    const prev = target.profileMeta[field] || { confidence: 0, evidenceCount: 0, updatedAt: '' };
    target.profileMeta[field] = {
      confidence: Number.isFinite(conf[field]) ? Math.round(conf[field] * 100) / 100 : prev.confidence,
      evidenceCount: evidenceCounts[field] || 0,
      updatedAt: new Date().toISOString(),
    };
  }
  return {
    changed: before !== profileSnapshot(target) || recentChanged,
    hasLongTerm: hasProfileContent(target),
    hasRecent: recentChanged,
  };
}

export function commitMemoryProfileResult(userId, result, options = {}) {
  const stamp = nowIso();
  let outcome = { ok: false, changed: false, hasProfile: false, reason: '没有找到记忆对象' };
  updateDb((draft) => {
    const target = (draft.memories || []).find((entry) => String(entry.userId) === String(userId));
    if (!target) return;

    target.lastProfileAttemptAt = stamp;
    const applyResult = applyProfileUpdate(target, result?.profile || {});
    const hasProfile = hasProfileContent(target);
    if (hasProfile) {
      target.pendingCount = 0;
      target.lastProfiledAt = stamp;
      target.lastProfileError = '';
      target.lastProfileStatus = applyResult.changed ? 'updated' : 'checked';
      outcome = { ok: true, changed: applyResult.changed, hasProfile: true, reason: applyResult.changed ? '画像已更新' : '画像已检查，暂无变化' };
    } else {
      target.lastProfileStatus = applyResult.hasRecent ? 'recent-only' : 'empty';
      target.lastProfileError = applyResult.hasRecent
        ? '仅产生近期动态，长期画像仍为空；保留待更新计数'
        : '模型未产出可保存的长期画像；保留待更新计数';
      outcome = { ok: true, changed: applyResult.changed, hasProfile: false, reason: target.lastProfileError };
    }
    target.updatedAt = stamp;

    if (!draft.usage) draft.usage = { totalTokens: 0, promptTokens: 0, completionTokens: 0, requests: 0, errors: 0 };
    const usage = result?.usage || {};
    draft.usage.requests += 1;
    draft.usage.totalTokens += usage.total_tokens || 0;
    draft.usage.promptTokens += usage.prompt_tokens || 0;
    draft.usage.completionTokens += usage.completion_tokens || 0;
    if (!draft.usageEvents) draft.usageEvents = [];
    draft.usageEvents.push({
      id: crypto.randomUUID(),
      groupId: options.groupId || '',
      userId: String(userId),
      model: options.model || draft.settings.model,
      kind: options.kind || 'memory',
      totalTokens: usage.total_tokens || 0,
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      createdAt: stamp,
    });
    draft.usageEvents = draft.usageEvents.slice(-5000);
  });
  return outcome;
}

function countEvidenceByField(samples) {
  const counts = {};
  for (const s of samples) {
    if (!s.usedForProfile || s.riskLevel !== 'normal') continue;
    const text = String(s.content || '');
    if (/喜欢|讨厌|习惯|经常|一般|希望|想要|偏好|雷点/i.test(text)) counts.preferences = (counts.preferences || 0) + 1;
    if (/说话|语气|讲|说|称呼|叫|语气|口吻/i.test(text)) counts.speechStyle = (counts.speechStyle || 0) + 1;
    if (/性格|脾气|耐心|暴躁|温和|冷静|冲动|自信|自卑|内向|外向/i.test(text)) counts.traits = (counts.traits || 0) + 1;
    if (/互动|回复|回应|聊天|参与|接话|插话|沉默|潜水|活跃/i.test(text)) counts.behavior = (counts.behavior || 0) + 1;
  }
  return counts;
}

export async function maybeUpdateMemoryProfile(event) {
  const db = readDb();
  const memory = (db.memories || []).find((entry) => String(entry.userId) === String(event.userId));
  if (!memory || memory.enabled === false) return;
  try {
    const result = await updateMemoryProfile(db, memory);
    if (!result) return;
    commitMemoryProfileResult(event.userId, result, { groupId: event.groupId, model: db.settings.model, kind: 'memory' });
  } catch (error) {
    updateDb((draft) => {
      const target = (draft.memories || []).find((entry) => String(entry.userId) === String(event.userId));
      if (target) {
        target.lastProfileAttemptAt = nowIso();
        target.lastProfileStatus = 'error';
        target.lastProfileError = error.message || String(error);
        target.updatedAt = nowIso();
      }
      draft.decisions.push({
        id: crypto.randomUUID(), messageId: event.messageId, groupId: event.groupId,
        userId: event.userId, shouldReply: false,
        reason: `长期记忆更新失败：${error.message}`, createdAt: nowIso()
      });
    });
  }
}
