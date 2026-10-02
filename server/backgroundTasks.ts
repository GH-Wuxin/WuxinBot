type BackgroundTaskRecord = {
  id: string;
  label: string;
  startedAt: string;
  startedAtMs: number;
};

const activeTasks = new Map<string, BackgroundTaskRecord>();
const activePromises = new Set<Promise<unknown>>();
let sequence = 0;
const stats = {
  since: new Date().toISOString(),
  started: 0,
  completed: 0,
  failed: 0,
  lastFailureAt: '',
  lastFailureLabel: '',
  lastFailure: ''
};

function errorText(error: unknown): string {
  return String((error as { message?: string } | null)?.message || error || '未知后台任务错误')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

/**
 * Run work that is intentionally detached from the request lifecycle.
 * The returned promise always settles successfully after recording a failure;
 * callers may still await it when they want the result, but a forgotten
 * fire-and-forget call cannot become a process-level unhandled rejection.
 */
export function runBackgroundTask<T>(label: string, task: () => Promise<T> | T): Promise<T | undefined> {
  const startedAtMs = Date.now();
  const id = `bg-${startedAtMs.toString(36)}-${(++sequence).toString(36)}`;
  const taskLabel = String(label || 'background');
  activeTasks.set(id, { id, label: String(label || 'background'), startedAt: new Date(startedAtMs).toISOString(), startedAtMs });
  stats.started += 1;

  let promise: Promise<T | undefined>;
  promise = Promise.resolve()
    .then(task)
    .then(
      (value) => {
        activeTasks.delete(id);
        activePromises.delete(promise);
        stats.completed += 1;
        return value;
      },
      (error) => {
        activeTasks.delete(id);
        activePromises.delete(promise);
        stats.failed += 1;
        stats.lastFailureAt = new Date().toISOString();
        stats.lastFailureLabel = taskLabel;
        stats.lastFailure = errorText(error);
        console.error(`[background] ${stats.lastFailureLabel} failed: ${stats.lastFailure}`);
        return undefined;
      },
    );
  activePromises.add(promise);
  return promise;
}

/**
 * Give detached work a bounded chance to finish during process shutdown.
 * Re-check the set after every batch so tasks that were already queued behind
 * another task are included too. The timeout is deliberately finite: a stuck
 * model request must not prevent the desktop from restarting.
 */
export async function waitForBackgroundTasks(timeoutMs = 1_200) {
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
  return {
    drained: activePromises.size === 0,
    active: activePromises.size,
  };
}

export function getBackgroundTaskStats() {
  return {
    ...stats,
    active: activeTasks.size,
    activeTasks: [...activeTasks.values()]
      .sort((a, b) => a.startedAtMs - b.startedAtMs)
      .slice(0, 50)
      .map(({ id, label, startedAt }) => ({ id, label, startedAt }))
  };
}
