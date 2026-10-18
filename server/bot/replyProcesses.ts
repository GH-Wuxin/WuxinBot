// 正在进行的回复进程登记表。
//
// 控制台要能看见"她正在给谁回、跑了多久"，并且能一键掐断某一轮。
// 登记表按请求存在（AsyncLocalStorage），所以排队后重跑的消息会自然落到新的
// 进程条目上；掐断只影响被点中的那一轮，不会误伤同一群的其它回复。
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface ReplyProcessMeta {
  groupId?: string;
  userId?: string;
  nickname?: string;
  messageId?: string;
}

export interface ReplyProcessSnapshot {
  id: string;
  groupId: string;
  userId: string;
  nickname: string;
  messageId: string;
  startedAt: number;
  stage: string;
  aborted: boolean;
  elapsedMs: number;
}

interface ReplyProcessState {
  id: string;
  groupId: string;
  userId: string;
  nickname: string;
  messageId: string;
  startedAt: number;
  stage: string;
  aborted: boolean;
  abortHooks: Set<() => void>;
}

const storage = new AsyncLocalStorage<ReplyProcessState>();
const registry = new Map<string, ReplyProcessState>();

/** 当前这一轮回复的登记项；在没有回复进程的上下文中（后台任务）返回 undefined。 */
export function currentReplyProcess(): ReplyProcessState | undefined {
  return storage.getStore();
}

/** 这一轮是否已被掐断。发送前用它做最终裁决。 */
export function isReplyProcessAborted(): boolean {
  const state = storage.getStore();
  return Boolean(state && state.aborted);
}

export function updateReplyProcessStage(stage: string): void {
  const state = storage.getStore();
  if (state && !state.aborted) state.stage = String(stage || '').slice(0, 40);
}

/** 在一轮回复的上下文里执行任务，并在结束时把登记项摘掉。 */
export function runReplyProcess<T>(meta: ReplyProcessMeta, task: () => Promise<T>): Promise<T> {
  const state: ReplyProcessState = {
    id: 'rp-' + randomUUID().slice(0, 8),
    groupId: String(meta.groupId || ''),
    userId: String(meta.userId || ''),
    nickname: String(meta.nickname || ''),
    messageId: String(meta.messageId || ''),
    startedAt: Date.now(),
    stage: '处理中',
    aborted: false,
    abortHooks: new Set()
  };
  registry.set(state.id, state);
  return storage.run(state, async () => {
    try {
      return await task();
    } finally {
      registry.delete(state.id);
    }
  });
}

/** 掐断时注册的清理动作，例如中断正在跑的模型调用。 */
export function onReplyProcessAbort(hook: () => void): () => void {
  const state = storage.getStore();
  if (!state) return () => {};
  state.abortHooks.add(hook);
  return () => state.abortHooks.delete(hook);
}

export function listReplyProcesses(now = Date.now()): ReplyProcessSnapshot[] {
  return [...registry.values()]
    .map((state) => ({
      id: state.id,
      groupId: state.groupId,
      userId: state.userId,
      nickname: state.nickname,
      messageId: state.messageId,
      startedAt: state.startedAt,
      stage: state.aborted ? '已掐断' : state.stage,
      aborted: state.aborted,
      elapsedMs: Math.max(0, now - state.startedAt)
    }))
    .sort((a, b) => a.startedAt - b.startedAt);
}

export interface AbortReplyResult {
  ok: boolean;
  id?: string;
  reason?: string;
}

export function abortReplyProcess(id: string): AbortReplyResult {
  const state = registry.get(String(id || ''));
  if (!state) return { ok: false, reason: '这一轮已经结束了' };
  if (!state.aborted) {
    state.aborted = true;
    state.stage = '已掐断';
    for (const hook of state.abortHooks) {
      try { hook(); } catch { /* 清理动作失败不影响掐断本身 */ }
    }
  }
  return { ok: true, id: state.id };
}

/** 仅供测试：清空登记表，避免用例之间互相污染。 */
export function resetReplyProcessesForTests(): void {
  registry.clear();
}
