import type { BotEvent, Db } from '../../types.js';
import type { OwnerDirective, SocialAssessment, SocialPerson, SocialState, SocialTransition, SocialView } from './types.js';

export const SOCIAL_DEFAULT_SCORE = 50;
export const isSystemOwner = (db: Pick<Db, 'settings'>, event: Pick<BotEvent, 'userId'>) =>
  Boolean(db.settings.ownerQq && String(db.settings.ownerQq) === String(event.userId));
export const socialScope = (event: Pick<BotEvent, 'type' | 'groupId' | 'userId'>) =>
  event.type === 'private' ? `private:${event.userId}` : `group:${event.groupId}`;
export const viewKey = (scope: string, userId: string) => `${scope}/${userId}`;
const plainObject = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export function emptySocialState(): SocialState {
  return { schemaVersion: 1, revision: 0, people: {}, views: {}, transitions: [], decisions: [], processed: [], feedback: [] };
}

export function validSocialState(value: unknown): value is SocialState {
  if (!plainObject(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0) return false;
  if (!plainObject(value.people) || !plainObject(value.views)) return false;
  if (!['transitions', 'decisions', 'processed', 'feedback'].every((key) => Array.isArray(value[key]))) return false;
  return Object.values(value.people).every((p: any) => plainObject(p) && typeof p.userId === 'string'
    && Number.isSafeInteger(p.revision) && Number.isFinite(p.familiarity) && p.familiarity >= 0 && p.familiarity <= 100
    && plainObject(p.affinity) && (p.affinity.kind === 'owner' ? p.affinity.label === '特殊' && !('score' in p.affinity)
      : p.affinity.kind === 'ordinary' && Number.isFinite(p.affinity.score) && p.affinity.score >= 0 && p.affinity.score <= 100))
    && Object.values(value.views).every((v: any) => plainObject(v) && typeof v.summary === 'string'
      && Array.isArray(v.preferredNames) && v.preferredNames.every((n: unknown) => typeof n === 'string')
      && typeof v.style === 'string' && Number.isSafeInteger(v.revision) && plainObject(v.mood)
      && typeof v.mood.label === 'string' && typeof v.mood.reason === 'string');
}

export function normalizeSocialState(db: any) {
  if (db.socialV2 === undefined) db.socialV2 = emptySocialState();
  if (!validSocialState(db.socialV2)) throw new Error('无效的 socialV2 数据；拒绝静默清空，请从备份恢复');
  db.ownerDirectives ??= [];
  if (!Array.isArray(db.ownerDirectives)) throw new Error('无效的 Owner 指令记录');
  // Identity is configuration, never an LLM-controlled score or a cached role.
  for (const p of Object.values(db.socialV2.people) as SocialPerson[]) {
    if (isSystemOwner(db, p)) p.affinity = { kind: 'owner', label: '特殊' };
    else if (p.affinity.kind === 'owner') p.affinity = { kind: 'ordinary', score: SOCIAL_DEFAULT_SCORE };
  }
}

export function readSocialPerson(db: any, userId: string): SocialPerson | null {
  const stored = db.socialV2?.people?.[userId];
  if (isSystemOwner(db, { userId })) return {
    userId, familiarity: 0, revision: 0, updatedAt: '', ...stored, affinity: { kind: 'owner', label: '特殊' },
  };
  if (!stored) return null;
  return { ...stored, affinity: stored.affinity.kind === 'owner' ? { kind: 'ordinary', score: SOCIAL_DEFAULT_SCORE } : stored.affinity };
}

export function readSocialView(db: any, scope: string, userId: string): SocialView | null {
  return db.socialV2?.views?.[viewKey(scope, userId)] || null;
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));
export function commitSocialAssessment(db: any, input: {
  event: BotEvent; messageIds: string[]; assessment: SocialAssessment;
  expectedPersonRevision: number; expectedViewRevision: number;
}): { applied: boolean; reason: string } {
  normalizeSocialState(db);
  const state = db.socialV2 as SocialState;
  const { event, assessment: a, messageIds } = input;
  const scope = socialScope(event), key = viewKey(scope, event.userId);
  const dedupeIds = messageIds.map((id) => `${scope}/${event.userId}/${id}`);
  if (dedupeIds.some((id) => state.processed.includes(id))) return { applied: false, reason: 'duplicate' };
  const beforePerson = readSocialPerson(db, event.userId), beforeView = readSocialView(db, scope, event.userId);
  if ((beforePerson?.revision || 0) !== input.expectedPersonRevision || (beforeView?.revision || 0) !== input.expectedViewRevision) {
    return { applied: false, reason: 'stale-revision' };
  }
  const now = new Date().toISOString();
  const owner = isSystemOwner(db, event);
  const person: SocialPerson = {
    userId: event.userId,
    affinity: owner ? { kind: 'owner', label: '特殊' } : { kind: 'ordinary', score: clamp(
      (beforePerson?.affinity.kind === 'ordinary' ? beforePerson.affinity.score : SOCIAL_DEFAULT_SCORE) + a.affinityDelta) },
    familiarity: clamp((beforePerson?.familiarity || 0) + a.familiarityDelta),
    revision: (beforePerson?.revision || 0) + 1, updatedAt: now,
  };
  const view: SocialView = {
    lastEvaluatedAt: now, lastReason: a.reason,
    summary: a.summary ?? beforeView?.summary ?? '',
    preferredNames: a.preferredNames ?? beforeView?.preferredNames ?? [],
    style: a.style ?? beforeView?.style ?? '',
    mood: a.mood ? { ...a.mood, updatedAt: now } : beforeView?.mood || { label: '尚未判断', reason: '', updatedAt: '' },
    revision: (beforeView?.revision || 0) + 1, updatedAt: now,
  };
  const changed = !beforePerson || !beforeView || a.affinityDelta !== 0 || a.familiarityDelta !== 0
    || a.summary !== null || a.preferredNames !== null || a.style !== null || a.mood !== null;
  state.processed = [...state.processed, ...dedupeIds].slice(-6000);
  if (changed) {
    const transition: SocialTransition = { id: crypto.randomUUID(), userId: event.userId, scope, messageIds,
      source: 'llm', reason: a.reason, before: { person: beforePerson, view: beforeView }, after: { person, view }, createdAt: now };
    state.people[event.userId] = person;
    state.views[key] = view;
    state.transitions = [...state.transitions, transition].slice(-1000);
  } else if (beforeView) {
    state.views[key] = { ...beforeView, lastEvaluatedAt: now, lastReason: a.reason };
  }
  state.revision++;
  return { applied: true, reason: changed ? 'updated' : 'unchanged' };
}

export function revertSocialTransition(db: any, id: string) {
  normalizeSocialState(db);
  const state: SocialState = db.socialV2;
  const entry = state.transitions.find((t) => t.id === id);
  if (!entry) throw new Error('找不到这条变化记录');
  const p = readSocialPerson(db, entry.userId), v = readSocialView(db, entry.scope, entry.userId);
  if (p?.revision !== entry.after.person.revision || v?.revision !== entry.after.view.revision) throw new Error('状态已变化，请刷新后撤销最新记录');
  const now = new Date().toISOString();
  const person: SocialPerson = { ...(entry.before.person || { userId: entry.userId, familiarity: 0,
    affinity: { kind: 'ordinary', score: SOCIAL_DEFAULT_SCORE } }), revision: p.revision + 1, updatedAt: now };
  person.affinity = isSystemOwner(db, person) ? { kind: 'owner', label: '特殊' }
    : person.affinity.kind === 'ordinary' ? person.affinity : { kind: 'ordinary', score: SOCIAL_DEFAULT_SCORE };
  const view: SocialView = { ...(entry.before.view || { summary: '', preferredNames: [], style: '',
    mood: { label: '尚未判断', reason: '', updatedAt: '' } }), revision: v.revision + 1, updatedAt: now };
  state.people[entry.userId] = person;
  state.views[viewKey(entry.scope, entry.userId)] = view;
  state.transitions = [...state.transitions, { ...entry, id: crypto.randomUUID(), source: 'console-revert' as const,
    reason: `撤销 ${id}`, before: { person: p, view: v }, after: { person, view }, createdAt: now }].slice(-1000);
  state.revision++;
}

export function correctSocialPreferences(db: any, userId: string, scope: string, names: string[], style: string, revision: number) {
  normalizeSocialState(db);
  const person = readSocialPerson(db, userId), view = readSocialView(db, scope, userId);
  if (!person || !view) throw new Error('本会话尚无可校正的关系记录');
  if (view.revision !== revision) throw new Error('记录已变化，请刷新后重试');
  if (!Array.isArray(names) || names.length > 3 || names.some((n) => typeof n !== 'string' || !n.trim() || n.length > 24)
    || typeof style !== 'string' || style.length > 200) throw new Error('称呼最多 3 个、各 24 字，表达偏好最多 200 字');
  const now = new Date().toISOString();
  const afterPerson = { ...person, revision: person.revision + 1, updatedAt: now };
  const afterView = { ...view, preferredNames: names.map((n) => n.trim()), style, revision: view.revision + 1, updatedAt: now };
  db.socialV2.people[userId] = afterPerson;
  db.socialV2.views[viewKey(scope, userId)] = afterView;
  db.socialV2.transitions = [...db.socialV2.transitions, { id: crypto.randomUUID(), userId, scope, messageIds: [],
    source: 'console-correction', reason: '控制台校正已接受称呼与表达偏好', before: { person, view },
    after: { person: afterPerson, view: afterView }, createdAt: now }].slice(-1000);
  db.socialV2.revision++;
}

export function updateOwnerDirective(db: any, event: BotEvent, key: string, text: string, active = true) {
  if (!isSystemOwner(db, event)) throw new Error('只有系统 Owner 可以修改长期指令');
  if (!/^[\p{L}\p{N}_-]{1,32}$/u.test(key) || (active && (!text.trim() || text.length > 600))) throw new Error('指令名称限 32 字，内容限 600 字');
  const scope = socialScope(event);
  const history: OwnerDirective[] = db.ownerDirectives || [];
  const previous = history.filter((d) => d.scope === scope && d.key === key && d.authorId === event.userId).at(-1);
  if (!active && !previous?.active) throw new Error('没有这条有效指令');
  const current = activeOwnerDirectives(db, scope);
  if (active && !previous?.active && current.length >= 20) throw new Error('本会话最多保存 20 条有效指令');
  db.ownerDirectives = [...history, { id: crypto.randomUUID(), key, text: active ? text.trim() : '', scope,
    authorId: event.userId, sourceMessageId: event.messageId, version: (previous?.version || 0) + 1, active,
    createdAt: new Date().toISOString() }];
  // Keep latest versions (including revocations); dropping a tombstone could revive an old instruction.
  if (db.ownerDirectives.length > 2000) {
    const latest = new Map<string, OwnerDirective>();
    for (const d of db.ownerDirectives) latest.set(`${d.authorId}/${d.scope}/${d.key}`, d);
    db.ownerDirectives = [...latest.values()];
  }
}

export function activeOwnerDirectives(db: any, scope: string): OwnerDirective[] {
  const latest = new Map<string, OwnerDirective>();
  for (const d of (db.ownerDirectives || []) as OwnerDirective[]) {
    if (d.authorId === String(db.settings.ownerQq || '') && d.scope === scope) latest.set(d.key, d);
  }
  return [...latest.values()].filter((d) => d.active);
}
