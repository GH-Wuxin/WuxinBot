// Global inbound admission boundary.
//
// Per-user reply FIFOs preserve ordering, but they do not stop different
// users from entering the expensive pipeline at the same time. This small
// process-wide gate keeps message bursts from multiplying DB writes, prompt
// construction and provider waits before the LLM admission boundary.

type InboundEntry<T = unknown> = {
  label: string;
  task: () => Promise<T> | T;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  enqueuedAt: number;
  timer?: NodeJS.Timeout;
};

const MAX_ACTIVE = 6;
const MAX_WAITING = 48;
const MAX_WAIT_MS = 180_000;

let accepting = true;
let active = 0;
let sequence = 0;
const waiting: Array<InboundEntry> = [];
const activePromises = new Set<Promise<unknown>>();
const activeLabels = new Map<Promise<unknown>, { id: string; label: string; startedAt: string; startedAtMs: number }>();
let rejected = 0;
let timedOut = 0;

function startEntry<T>(entry: InboundEntry<T>): void {
  active += 1;
  const startedAtMs = Date.now();
  const promise = Promise.resolve().then(entry.task);
  const id = `in-${startedAtMs.toString(36)}-${(++sequence).toString(36)}`;
  activePromises.add(promise);
  activeLabels.set(promise, { id, label: entry.label, startedAt: new Date(startedAtMs).toISOString(), startedAtMs });

  promise.then(
    (value) => entry.resolve(value),
    (error) => entry.reject(error),
  ).finally(() => {
    active -= 1;
    activePromises.delete(promise);
    activeLabels.delete(promise);
    drain();
  });
}

function drain(): void {
  while (accepting && active < MAX_ACTIVE && waiting.length > 0) {
    const entry = waiting.shift()!;
    if (entry.timer) clearTimeout(entry.timer);
    startEntry(entry);
  }
}

export function runInboundTask<T>(label: string, task: () => Promise<T> | T): Promise<T> {
  if (!accepting) return Promise.reject(new Error('INBOUND_SHUTDOWN: 服务正在关闭，拒绝新的消息处理'));
  const normalizedLabel = String(label || 'inbound');
  if (active < MAX_ACTIVE) {
    return new Promise<T>((resolve, reject) => {
      startEntry({ label: normalizedLabel, task, resolve, reject, enqueuedAt: Date.now() });
    });
  }
  if (waiting.length >= MAX_WAITING) {
    rejected += 1;
    return Promise.reject(new Error(`INBOUND_CAPACITY_EXHAUSTED: 消息处理等待队列已满（${MAX_WAITING}），请稍后重试`));
  }

  return new Promise<T>((resolve, reject) => {
    const entry: InboundEntry<T> = {
      label: normalizedLabel,
      task,
      resolve,
      reject,
      enqueuedAt: Date.now(),
    };
    entry.timer = setTimeout(() => {
      const index = waiting.indexOf(entry as InboundEntry);
      if (index >= 0) waiting.splice(index, 1);
      timedOut += 1;
      reject(new Error('INBOUND_CAPACITY_EXHAUSTED: 消息处理等待超时，请稍后重试'));
    }, MAX_WAIT_MS);
    entry.timer.unref?.();
    waiting.push(entry as InboundEntry);
    drain();
  });
}

/** Stop accepting new work and reject work that has not entered the pipeline. */
export function stopInboundAdmission(): void {
  if (!accepting) return;
  accepting = false;
  while (waiting.length > 0) {
    const entry = waiting.shift()!;
    if (entry.timer) clearTimeout(entry.timer);
    rejected += 1;
    entry.reject(new Error('INBOUND_SHUTDOWN: 服务正在关闭，排队消息未执行'));
  }
}

export async function waitForInboundTasks(timeoutMs = 1_200) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (activePromises.size > 0 && Date.now() < deadline) {
    const pending = [...activePromises];
    const remainingMs = Math.max(1, deadline - Date.now());
    await Promise.race([
      Promise.allSettled(pending),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, remainingMs);
        timer.unref?.();
      }),
    ]);
  }
  return { drained: activePromises.size === 0, active: activePromises.size };
}

export function getInboundAdmissionStats() {
  return {
    accepting,
    active,
    waiting: waiting.length,
    maxActive: MAX_ACTIVE,
    maxWaiting: MAX_WAITING,
    maxWaitMs: MAX_WAIT_MS,
    rejected,
    timedOut,
    activeTasks: [...activeLabels.values()]
      .sort((a, b) => a.startedAtMs - b.startedAtMs)
      .slice(0, MAX_ACTIVE)
      .map(({ id, label, startedAt }) => ({ id, label, startedAt })),
  };
}
