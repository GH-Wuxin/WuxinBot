/**
 * Pippi presence / inner-life layer.
 *
 * Every enabled group message is observed, even when Pippi does not reply.
 * Per-message effects are deliberately tiny; a periodic reflection pass folds
 * them into durable impressions, mood and open threads. This module never
 * sends a message and never decides whether Pippi should speak.
 */
import crypto from 'node:crypto';
import { getDataDir, readDb, updateDb } from '../store.js';
import { runBackgroundTask } from '../backgroundTasks.js';
import { completeChat } from './llm.js';
import type { BotEvent } from '../types.js';
import type {
  PresenceGroup,
  PresenceSelf,
  PresenceState,
} from './social/types.js';

const MAX_PENDING = 80;
const MAX_OBSERVATIONS = 120;
const MAX_NOTICING = 12;
const MAX_THREADS = 8;
const MAX_CULTURE = 12;
const MAX_PEOPLE = 300;
const BATCH_SIZE = 8;
const BATCH_MIN = 6;
const BATCH_DELAY_MS = 45_000;
const REFLECTION_DELAY_MS = 20 * 60_000;
const REFLECTION_MIN_OBSERVATIONS = 8;
const PERSIST_INTERVAL_MS = 5 * 60_000;
const FAILURE_BACKOFF_MS = 5 * 60_000;
const MAX_SEEN_IDS = 800;

interface PendingMessage {
  messageId: string;
  userId: string;
  nickname: string;
  text: string;
  at: string;
  atTargets: string[];
  replyTo: string;
  imageCount: number;
  direct: boolean;
  question: boolean;
}

interface GroupRuntime {
  groupId: string;
  pending: PendingMessage[];
  seenIds: Set<string>;
  timer?: NodeJS.Timeout;
  batchInflight: boolean;
  reflectInflight: boolean;
  lastBatchAt: number;
  lastReflectionAt: number;
  lastPersistAt: number;
  failureUntil: number;
  failureReason: string;
}

let cachedState: PresenceState | null = null;
let cachedDataDir = '';
const runtimes = new Map<string, GroupRuntime>();

function nowIso() {
  return new Date().toISOString();
}

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function text(value: unknown, max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function emptySelf(): PresenceSelf {
  const at = nowIso();
  return {
    mood: { label: '平静', reason: '', updatedAt: at },
    valence: 50,
    energy: 60,
    interest: 50,
    focus: [],
    updatedAt: at,
  };
}

function emptyState(): PresenceState {
  const at = nowIso();
  return { version: 1, self: emptySelf(), groups: {}, updatedAt: at };
}

function emptyGroup(groupId: string): PresenceGroup {
  return {
    groupId: String(groupId),
    people: {},
    threads: [],
    culture: [],
    observations: [],
    noticing: [],
    updatedAt: nowIso(),
  };
}

function validState(value: unknown): value is PresenceState {
  return Boolean(value && typeof value === 'object' && (value as any).version === 1
    && (value as any).self && typeof (value as any).self === 'object'
    && (value as any).groups && typeof (value as any).groups === 'object');
}

function stateFor(db: any): PresenceState {
  const dir = getDataDir();
  if (!cachedState || cachedDataDir !== dir) {
    const stored = db?.socialV2?.presence;
    const fallback = emptySelf();
    if (validState(stored)) {
      stored.self.mood ||= fallback.mood;
      stored.self.valence = clamp(stored.self.valence ?? fallback.valence);
      stored.self.energy = clamp(stored.self.energy ?? fallback.energy);
      stored.self.interest = clamp(stored.self.interest ?? fallback.interest);
      stored.self.focus = Array.isArray(stored.self.focus) ? stored.self.focus : [];
      cachedState = stored;
    } else {
      cachedState = emptyState();
    }
    cachedDataDir = dir;
  }
  return cachedState;
}

function groupFor(state: PresenceState, groupId: string): PresenceGroup {
  const id = String(groupId);
  const group = state.groups[id];
  if (group && typeof group === 'object') {
    if (!group.people || typeof group.people !== 'object' || Array.isArray(group.people)) group.people = {};
    if (!Array.isArray(group.threads)) group.threads = [];
    if (!Array.isArray(group.culture)) group.culture = [];
    if (!Array.isArray(group.observations)) group.observations = [];
    if (!Array.isArray(group.noticing)) group.noticing = [];
    return group;
  }
  const created = emptyGroup(id);
  state.groups[id] = created;
  return created;
}

function runtimeFor(groupId: string): GroupRuntime {
  const id = String(groupId);
  let runtime = runtimes.get(id);
  if (!runtime) {
    runtime = {
      groupId: id,
      pending: [],
      seenIds: new Set(),
      batchInflight: false,
      reflectInflight: false,
      lastBatchAt: 0,
      lastReflectionAt: 0,
      lastPersistAt: 0,
      failureUntil: 0,
      failureReason: '',
    };
    runtimes.set(id, runtime);
  }
  return runtime;
}

function rememberSeen(runtime: GroupRuntime, messageId: string) {
  if (!messageId) return false;
  if (runtime.seenIds.has(messageId)) return false;
  runtime.seenIds.add(messageId);
  if (runtime.seenIds.size > MAX_SEEN_IDS) {
    const oldest = runtime.seenIds.values().next().value;
    if (oldest) runtime.seenIds.delete(oldest);
  }
  return true;
}

function presenceModel(db: any): string {
  const model = String(db?.settings?.model || '').trim();
  // Presence deliberately stays on Flash. If the operator has selected Eco
  // for another path, strip the suffix for this background layer.
  return /-eco$/i.test(model) ? model.replace(/-eco$/i, '') : model;
}

function shouldObserve(db: any, event: BotEvent): boolean {
  if (db?.settings?.presenceEnabled !== true) return false;
  if (db?.settings?.globalPaused) return false;
  if (event.type !== 'group' || event.source === 'pippi-activity') return false;
  if (!event.messageId || String(event.userId) === String(db.settings.selfQq || '')) return false;
  if (String(event.text || '').trim().startsWith('/')) return false;
  const group = (db.groups || []).find((item: any) => String(item.groupId) === String(event.groupId));
  if (!group?.enabled) return false;
  return ['mention', 'light', 'natural'].includes(String(group.mode || ''));
}

function scheduleBatch(runtime: GroupRuntime) {
  if (runtime.batchInflight || runtime.timer) return;
  const delay = runtime.pending.length >= BATCH_MIN ? 800 : BATCH_DELAY_MS;
  runtime.timer = setTimeout(() => {
    runtime.timer = undefined;
    void runBackgroundTask('presence.batch', () => flushPresence(runtime.groupId));
  }, delay);
  runtime.timer.unref?.();
}

function scheduleReflection(runtime: GroupRuntime) {
  if (runtime.reflectInflight) return;
  void runBackgroundTask('presence.reflect', () => reflectPresence(runtime.groupId));
}

/** Queue one message for observation. Never throws into the inbound path. */
export function observeMessage(event: BotEvent, options: { schedule?: boolean } = {}): void {
  try {
    const db = readDb();
    if (!shouldObserve(db, event)) return;
    const state = stateFor(db);
    const groupState = groupFor(state, event.groupId);
    const runtime = runtimeFor(event.groupId);
    if (!rememberSeen(runtime, event.messageId)) return;

    const at = nowIso();
    const hour = new Date().getHours();
    const direct = Boolean((event as any).socialDirect || (event as any).socialNamed);
    const question = /[?？]|吗|怎么|为什么|如何|哪|多少|什么时候/.test(String(event.text || ''));
    const osuTopic = /osu|pp|打图|成绩|谱面|acc|fc|ap|段位/i.test(String(event.text || ''));
    const late = hour >= 0 && hour < 6;

    const self = state.self;
    self.valence = clamp(self.valence - (late ? 0.05 : 0) + (osuTopic ? 0.1 : 0));
    self.energy = clamp(self.energy - (late ? 0.15 : 0.03));
    self.interest = clamp(self.interest + (osuTopic ? 0.35 : question ? 0.15 : 0.03));
    self.updatedAt = at;

    let person = groupState.people[String(event.userId)];
    if (!person) {
      person = {
        userId: String(event.userId),
        impression: '',
        warmth: 50,
        familiarity: 0,
        lastSeenAt: at,
        evidenceIds: [],
      };
      groupState.people[String(event.userId)] = person;
    }
    person.warmth = clamp(person.warmth + (direct ? 0.35 : 0.06));
    person.familiarity = clamp(person.familiarity + (direct ? 0.12 : 0.02));
    person.lastSeenAt = at;
    person.evidenceIds = [...person.evidenceIds, event.messageId].slice(-40);
    const peopleCount = Object.keys(groupState.people).length;
    if (peopleCount > MAX_PEOPLE) {
      const oldest = Object.values(groupState.people)
        .sort((a, b) => String(a.lastSeenAt).localeCompare(String(b.lastSeenAt)))[0];
      if (oldest) delete groupState.people[oldest.userId];
    }

    runtime.pending.push({
      messageId: event.messageId,
      userId: String(event.userId),
      nickname: String(event.nickname || event.userId),
      text: String(event.text || '').slice(0, 600),
      at,
      atTargets: event.atTargets || [],
      replyTo: event.replyMessageId || '',
      imageCount: event.images?.length || 0,
      direct,
      question,
    });
    if (runtime.pending.length > MAX_PENDING) runtime.pending.splice(0, runtime.pending.length - MAX_PENDING);
    groupState.updatedAt = at;
    state.updatedAt = at;
    if (options.schedule !== false) scheduleBatch(runtime);
  } catch (error) {
    // Observation must never break normal message handling.
    console.error('[presence] observe failed:', String((error as any)?.message || error).slice(0, 300));
  }
}

function parseObject(raw: unknown): any {
  const value = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('presence output is not JSON');
  return JSON.parse(value.slice(start, end + 1));
}

function addThread(group: PresenceGroup, input: any, evidenceIds: string[]) {
  const topic = text(input?.topic, 120);
  if (!topic) return;
  const participants = Array.isArray(input?.participants)
    ? input.participants.map((id: unknown) => String(id)).filter(Boolean).slice(0, 8)
    : [];
  const existing = group.threads.find((thread) => thread.topic.toLowerCase() === topic.toLowerCase()
    || thread.id === String(input?.id || ''));
  const at = nowIso();
  if (existing) {
    existing.note = text(input?.note, 240) || existing.note;
    existing.status = input?.status === 'closed' ? 'closed' : 'open';
    existing.participants = [...new Set([...existing.participants, ...participants])].slice(0, 8);
    existing.evidenceIds = [...new Set([...existing.evidenceIds, ...evidenceIds])].slice(-40);
    existing.updatedAt = at;
    return;
  }
  group.threads.push({
    id: crypto.randomUUID(),
    topic,
    participants,
    status: input?.status === 'closed' ? 'closed' : 'open',
    note: text(input?.note, 240),
    evidenceIds: [...new Set(evidenceIds)].slice(-40),
    createdAt: at,
    updatedAt: at,
  });
  group.threads = group.threads
    .sort((a, b) => Number(a.status === 'open' ? 0 : 1) - Number(b.status === 'open' ? 0 : 1)
      || String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, MAX_THREADS);
}

function addCulture(group: PresenceGroup, input: any, evidenceIds: string[]) {
  const phrase = text(input?.phrase, 60);
  if (!phrase) return;
  const existing = group.culture.find((item) => item.phrase.toLowerCase() === phrase.toLowerCase());
  const at = nowIso();
  if (existing) {
    existing.meaning = text(input?.meaning, 160) || existing.meaning;
    existing.strength = Math.min(10, existing.strength + 1);
    existing.evidenceIds = [...new Set([...existing.evidenceIds, ...evidenceIds])].slice(-40);
    existing.updatedAt = at;
    return;
  }
  group.culture.push({
    phrase,
    meaning: text(input?.meaning, 160),
    strength: 1,
    evidenceIds: [...new Set(evidenceIds)].slice(-40),
    updatedAt: at,
  });
  group.culture = group.culture
    .sort((a, b) => b.strength - a.strength || String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, MAX_CULTURE);
}

function applyObservations(state: PresenceState, group: PresenceGroup, observations: any[], batch: PendingMessage[]) {
  const allowedIds = new Set(batch.map((message) => message.messageId));
  const allowedUsers = new Set(batch.map((message) => message.userId));
  const at = nowIso();
  let added = 0;
  for (const raw of Array.isArray(observations) ? observations : []) {
    if (!raw || typeof raw !== 'object') continue;
    const messageIds = (Array.isArray(raw.messageIds) ? raw.messageIds : [])
      .map((id: unknown) => String(id))
      .filter((id: string) => allowedIds.has(id));
    if (!messageIds.length) continue;
    const salience = clamp(Number(raw.salience) || 0, 0, 1);
    const noticed = text(raw.noticed, 240);
    const topic = text(raw.topic, 100);
    const sentiment = text(raw.sentiment, 80);

    state.self.valence = clamp(state.self.valence + clamp(Number(raw.moodDelta) || 0, -1, 1) * 0.6);
    state.self.energy = clamp(state.self.energy + clamp(Number(raw.energyDelta) || 0, -1, 1) * 0.6);
    state.self.interest = clamp(state.self.interest + clamp(Number(raw.interestDelta) || 0, -1, 1) * 0.6);
    state.self.updatedAt = at;

    for (const personDelta of Array.isArray(raw.people) ? raw.people : []) {
      if (!personDelta || !allowedUsers.has(String(personDelta.userId))) continue;
      const userId = String(personDelta.userId);
      const person = group.people[userId] || {
        userId,
        impression: '',
        warmth: 50,
        familiarity: 0,
        lastSeenAt: at,
        evidenceIds: [],
      };
      person.warmth = clamp(person.warmth + clamp(Number(personDelta.warmthDelta) || 0, -2, 2) * 0.6);
      person.familiarity = clamp(person.familiarity + clamp(Number(personDelta.familiarityDelta) || 0, -1, 1) * 0.6);
      if (personDelta.impression) person.impression = text(personDelta.impression, 240);
      person.evidenceIds = [...new Set([...person.evidenceIds, ...messageIds])].slice(-40);
      person.lastSeenAt = at;
      group.people[userId] = person;
    }

    if (raw.openThread && typeof raw.openThread === 'object') addThread(group, raw.openThread, messageIds);
    if (raw.culture && typeof raw.culture === 'object') addCulture(group, raw.culture, messageIds);

    if (noticed) {
      group.observations.push({
        id: crypto.randomUUID(),
        messageIds,
        topic,
        sentiment,
        salience,
        noticed,
        createdAt: at,
      });
      added += 1;
      if (salience >= 0.45) {
        group.noticing = [...new Set([noticed, ...group.noticing])].slice(0, MAX_NOTICING);
      }
    }
  }
  group.observations = group.observations.slice(-MAX_OBSERVATIONS);
  group.updatedAt = at;
  state.updatedAt = at;
  if (added) {
    state.self.mood.reason = group.noticing[0] || state.self.mood.reason;
    state.self.mood.updatedAt = at;
  }
}

async function observeWithModel(db: any, state: PresenceState, group: PresenceGroup, batch: PendingMessage[], invoke: typeof completeChat) {
  const payload = {
    now: nowIso(),
    self: {
      mood: state.self.mood.label,
      valence: Math.round(state.self.valence),
      energy: Math.round(state.self.energy),
      interest: Math.round(state.self.interest),
      focus: state.self.focus.slice(-4),
    },
    group: {
      knownPeople: Object.values(group.people).slice(-12).map((person) => ({
        userId: person.userId,
        impression: person.impression,
        warmth: Math.round(person.warmth),
        familiarity: Math.round(person.familiarity),
      })),
      openThreads: group.threads.filter((thread) => thread.status === 'open').slice(-4)
        .map((thread) => ({ topic: thread.topic, note: thread.note })),
      culture: group.culture.slice(0, 6).map((item) => ({ phrase: item.phrase, meaning: item.meaning })),
    },
    messages: batch.map((message) => ({
      messageId: message.messageId,
      userId: message.userId,
      nickname: message.nickname,
      text: message.text.slice(0, 300),
      direct: message.direct,
      question: message.question,
      images: message.imageCount,
      at: message.at,
    })),
  };
  const response = await invoke(db, {
    model: presenceModel(db),
    messages: [
      {
        role: 'system',
        content: [
          '你是 Pippi 的后台观察层，不是回复者。只输出 JSON，不要写群聊回复。',
          '你会看到一批群消息，以及 Pippi 当前的心情、精力、兴趣和本群已有印象。',
          '记录她注意到了什么，以及这些消息对她和群友的微小影响。单条消息影响要小；没有值得注意的内容可以少输出或返回空数组。',
          '只使用输入中真实存在的 messageId 和 userId；禁止编造事实、线下经历或输入中没有的信息。',
          '影响是缓慢累积的：moodDelta/energyDelta/interestDelta 在 -1..1，warmthDelta 在 -1..1，familiarityDelta 在 0..0.5。',
          '输出格式：{"observations":[{"messageIds":["..."],"topic":"","sentiment":"","salience":0.0,"noticed":"","moodDelta":0,"energyDelta":0,"interestDelta":0,"people":[{"userId":"","warmthDelta":0,"familiarityDelta":0,"impression":""}],"openThread":null,"culture":null}]}',
          'openThread 可为 null 或 {"topic":"","participants":["userId"],"note":""}；culture 可为 null 或 {"phrase":"","meaning":""}。',
        ].join('\n'),
      },
      { role: 'user', content: JSON.stringify(payload) },
    ],
    temperature: 0.2,
    maxTokens: 700,
    completionBudget: 1400,
    timeoutMs: 30_000,
    requestMaxRetries: 0,
    retryOnEmpty: false,
    promptStudioApplied: true,
    label: 'Pippi 常驻感知',
    tracePurpose: 'presence_observe',
    traceRole: 'background',
  });
  const parsed = parseObject(response?.text);
  applyObservations(state, group, parsed?.observations, batch);
  return Number(response?.usage?.total_tokens || 0);
}

async function reflectWithModel(db: any, state: PresenceState, group: PresenceGroup, invoke: typeof completeChat) {
  const observations = group.observations.slice(-40);
  const payload = {
    now: nowIso(),
    self: {
      mood: state.self.mood,
      valence: Math.round(state.self.valence),
      energy: Math.round(state.self.energy),
      interest: Math.round(state.self.interest),
      focus: state.self.focus.slice(-5),
    },
    people: Object.values(group.people).slice(-20).map((person) => ({
      userId: person.userId,
      impression: person.impression,
      warmth: Math.round(person.warmth),
      familiarity: Math.round(person.familiarity),
    })),
    threads: group.threads.slice(-8).map((thread) => ({
      topic: thread.topic,
      status: thread.status,
      note: thread.note,
      participants: thread.participants,
    })),
    culture: group.culture.slice(0, 12).map((item) => ({ phrase: item.phrase, meaning: item.meaning, strength: item.strength })),
    observations: observations.map((observation) => ({
      messageIds: observation.messageIds,
      topic: observation.topic,
      sentiment: observation.sentiment,
      salience: observation.salience,
      noticed: observation.noticed,
    })),
  };
  const response = await invoke(db, {
    model: presenceModel(db),
    messages: [
      {
        role: 'system',
        content: [
          '你是 Pippi 的后台内化层，不是回复者。只输出 JSON。',
          '根据最近的观察记录，缓慢更新 Pippi 的心情、精力、兴趣、对群友的印象、未完成话题和群文化。',
          '变化必须缓慢、可衰减；不要因为一两条消息产生剧烈变化；没有证据不要新增事实。',
          '最多保留 8 个高显著性人物印象、6 个未完成话题、6 个群文化条目、5 条 noticing。',
          '输出格式：{"self":{"mood":{"label":"","reason":""},"energy":0,"interest":0,"valence":0,"focus":[""]},"people":[{"userId":"","impression":"","warmthDelta":0,"familiarityDelta":0}],"threads":[{"topic":"","status":"open|closed","participants":["userId"],"note":""}],"culture":[{"phrase":"","meaning":""}],"noticing":[""]}',
          'people 的 userId 必须来自输入；warmthDelta 在 -5..5，familiarityDelta 在 0..3。',
        ].join('\n'),
      },
      { role: 'user', content: JSON.stringify(payload) },
    ],
    temperature: 0.2,
    maxTokens: 900,
    completionBudget: 1600,
    timeoutMs: 30_000,
    requestMaxRetries: 0,
    retryOnEmpty: false,
    promptStudioApplied: true,
    label: 'Pippi 内心整理',
    tracePurpose: 'presence_reflect',
    traceRole: 'background',
  });
  const parsed = parseObject(response?.text);
  const at = nowIso();
  const self = parsed?.self;
  if (self && typeof self === 'object') {
    state.self.valence = clamp(Number(self.valence ?? state.self.valence));
    state.self.energy = clamp(Number(self.energy ?? state.self.energy));
    state.self.interest = clamp(Number(self.interest ?? state.self.interest));
    state.self.focus = Array.isArray(self.focus)
      ? self.focus.map((item: unknown) => text(item, 80)).filter(Boolean).slice(-5)
      : state.self.focus;
    if (self.mood && typeof self.mood === 'object' && text(self.mood.label, 40)) {
      state.self.mood = {
        label: text(self.mood.label, 40),
        reason: text(self.mood.reason, 200),
        updatedAt: at,
      };
    }
    state.self.updatedAt = at;
  }
  const allowedUsers = new Set(Object.keys(group.people));
  for (const raw of Array.isArray(parsed?.people) ? parsed.people : []) {
    const userId = String(raw?.userId || '');
    if (!allowedUsers.has(userId)) continue;
    const person = group.people[userId];
    person.warmth = clamp(person.warmth + clamp(Number(raw.warmthDelta) || 0, -5, 5));
    person.familiarity = clamp(person.familiarity + clamp(Number(raw.familiarityDelta) || 0, 0, 3));
    if (raw.impression) person.impression = text(raw.impression, 240);
    person.lastSeenAt = at;
  }
  const evidenceIds = observations.flatMap((observation) => observation.messageIds).slice(-24);
  for (const raw of Array.isArray(parsed?.threads) ? parsed.threads : []) addThread(group, raw, evidenceIds);
  for (const raw of Array.isArray(parsed?.culture) ? parsed.culture : []) addCulture(group, raw, evidenceIds);
  if (Array.isArray(parsed?.noticing)) {
    const noticing = (parsed.noticing as unknown[])
      .map((item) => text(item, 240))
      .filter((item): item is string => Boolean(item));
    group.noticing = [...new Set<string>(noticing)].slice(0, MAX_NOTICING);
  }
  group.observations = group.observations.slice(-80);
  group.updatedAt = at;
  state.updatedAt = at;
  return { tokens: Number(response?.usage?.total_tokens || 0), observations: observations.length };
}

function persistState(state: PresenceState) {
  updateDb((draft) => {
    if (!draft.socialV2) return;
    draft.socialV2.presence = state;
  });
  state.updatedAt = nowIso();
}

/** Flush one group's pending observations through the model. */
export async function flushPresence(groupId: string, options: { invoke?: typeof completeChat } = {}): Promise<void> {
  const runtime = runtimeFor(groupId);
  if (runtime.batchInflight || !runtime.pending.length) return;
  if (Date.now() < runtime.failureUntil) return;
  const db = readDb();
  if (db.settings.presenceEnabled !== true) return;
  const state = stateFor(db);
  const group = groupFor(state, groupId);
  const batch = runtime.pending.splice(0, BATCH_SIZE);
  runtime.batchInflight = true;
  try {
    const invoke = options.invoke || completeChat;
    await observeWithModel(db, state, group, batch, invoke);
    runtime.lastBatchAt = Date.now();
    runtime.failureUntil = 0;
    runtime.failureReason = '';
    if (Date.now() - runtime.lastPersistAt >= PERSIST_INTERVAL_MS) {
      persistState(state);
      runtime.lastPersistAt = Date.now();
    }
    if (group.observations.length >= REFLECTION_MIN_OBSERVATIONS
      && Date.now() - runtime.lastReflectionAt >= REFLECTION_DELAY_MS) {
      scheduleReflection(runtime);
    }
  } catch (error) {
    // Back off instead of retrying every message. The pending batch is dropped;
    // deterministic micro-effects already happened.
    runtime.failureUntil = Date.now() + FAILURE_BACKOFF_MS;
    runtime.failureReason = String((error as any)?.message || error).slice(0, 300);
    console.error('[presence] batch failed:', runtime.failureReason);
  } finally {
    runtime.batchInflight = false;
    if (runtime.pending.length) scheduleBatch(runtime);
  }
}

/** Consolidate recent observations into durable mood / impressions / threads. */
export async function reflectPresence(groupId: string, options: { invoke?: typeof completeChat; force?: boolean } = {}): Promise<void> {
  const runtime = runtimeFor(groupId);
  if (runtime.reflectInflight) return;
  const db = readDb();
  if (db.settings.presenceEnabled !== true) return;
  const state = stateFor(db);
  const group = groupFor(state, groupId);
  if (!options.force) {
    if (group.observations.length < REFLECTION_MIN_OBSERVATIONS) return;
    if (Date.now() - runtime.lastReflectionAt < REFLECTION_DELAY_MS) return;
  }
  runtime.reflectInflight = true;
  try {
    const invoke = options.invoke || completeChat;
    await reflectWithModel(db, state, group, invoke);
    runtime.lastReflectionAt = Date.now();
    runtime.lastPersistAt = Date.now();
    persistState(state);
  } catch (error) {
    runtime.failureUntil = Date.now() + FAILURE_BACKOFF_MS;
    runtime.failureReason = String((error as any)?.message || error).slice(0, 300);
    console.error('[presence] reflection failed:', runtime.failureReason);
  } finally {
    runtime.reflectInflight = false;
  }
}

/** Compact, evidence-bounded block for the reply prompt. */
export function presencePromptBlock(db: any, event: BotEvent): string {
  if (db?.settings?.presenceEnabled !== true || event.type !== 'group') return '';
  const state = stateFor(db);
  const group = state.groups[String(event.groupId)];
  if (!group) return '';
  const observations = [...group.observations]
    .sort((a, b) => b.salience - a.salience || String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 3)
    .map((item) => item.noticed)
    .filter(Boolean);
  const threads = group.threads.filter((thread) => thread.status === 'open').slice(0, 2)
    .map((thread) => thread.note ? `${thread.topic}（${thread.note}）` : thread.topic);
  const culture = group.culture.slice(0, 2)
    .map((item) => item.meaning ? `${item.phrase}（${item.meaning}）` : item.phrase);
  const currentPerson = group.people[String(event.userId)];
  const personLine = currentPerson?.impression ? `对当前发言者的印象：${currentPerson.impression}` : '';
  const focus = state.self.focus.slice(-2);
  if (!observations.length && !threads.length && !culture.length && !personLine && !focus.length) return '';
  return [
    '【你最近在群里注意到的】（只是背景，不要逐条汇报）',
    `你现在的状态：心情=${state.self.mood.label}，精力=${Math.round(state.self.energy)}/100，兴趣=${Math.round(state.self.interest)}/100。`,
    personLine,
    focus.length ? `最近在意：${focus.join('；')}` : '',
    observations.length ? `你注意到：${observations.join('；')}` : '',
    threads.length ? `未完成话题：${threads.join('；')}` : '',
    culture.length ? `群里的梗/习惯：${culture.join('；')}` : '',
    '使用规则：只在当前话题真正相关时自然带出；不要为了证明你看到了而强行引用；不要每轮都提；不要解释记忆机制。',
  ].filter(Boolean).join('\n');
}

export function presenceSnapshot(db: any = readDb()) {
  const state = stateFor(db);
  return {
    enabled: db?.settings?.presenceEnabled === true,
    self: {
      mood: state.self.mood,
      valence: Math.round(state.self.valence),
      energy: Math.round(state.self.energy),
      interest: Math.round(state.self.interest),
      focus: state.self.focus,
    },
    groups: Object.fromEntries(Object.entries(state.groups).map(([groupId, group]) => [groupId, {
      people: Object.values(group.people).length,
      threads: group.threads.filter((thread) => thread.status === 'open').length,
      culture: group.culture.length,
      observations: group.observations.length,
      recent: group.observations.slice(-8).map((item) => ({
        messageIds: item.messageIds,
        noticed: item.noticed,
        topic: item.topic,
        sentiment: item.sentiment,
        salience: item.salience,
        createdAt: item.createdAt,
      })),
      openThreads: group.threads.filter((thread) => thread.status === 'open').slice(-6),
      noticing: group.noticing,
    }])),
    updatedAt: state.updatedAt,
  };
}

/** Test/maintenance helper: forget in-memory queues and reload from the store. */
export function resetPresenceRuntime(): void {
  for (const runtime of runtimes.values()) {
    if (runtime.timer) clearTimeout(runtime.timer);
  }
  runtimes.clear();
  cachedState = null;
  cachedDataDir = '';
}
