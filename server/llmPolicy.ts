import { AsyncLocalStorage } from 'node:async_hooks';
import { traceEvent } from './requestTrace.js';

interface TurnPolicy { deadline: number; calls: number; maxCalls: number; fallbackKeys: Set<string> }
const context = new AsyncLocalStorage<TurnPolicy>();
let activeInvocations = 0;
const MAX_CONCURRENT_INVOCATIONS = 4;
const MAX_WAITING_INVOCATIONS = 32;

type SlotWaiter = {
  turn?: TurnPolicy;
  timeoutMs: number;
  enqueuedAt: number;
  timer: NodeJS.Timeout;
  resolve: (reservation: ReturnType<typeof createReservation>) => void;
  reject: (error: Error) => void;
};

const slotWaiters: SlotWaiter[] = [];

function turnRemainingMs(turn: TurnPolicy | undefined, timeoutMs: number) {
  return turn ? turn.deadline - Date.now() : timeoutMs;
}

function assertReservationAllowed(turn: TurnPolicy | undefined, timeoutMs: number) {
  const remainingMs = turnRemainingMs(turn, timeoutMs);
  if (remainingMs <= 0 || (turn && turn.calls >= turn.maxCalls)) {
    throw new Error('LLM_TURN_BUDGET_EXHAUSTED: 本轮模型调用次数或总时限已达到上限');
  }
  return remainingMs;
}

function createReservation(turn: TurnPolicy | undefined, timeoutMs: number, waitedMs = 0) {
  const remainingMs = assertReservationAllowed(turn, timeoutMs);
  if (turn) turn.calls++;
  activeInvocations++;
  let released = false;
  const deadline = Date.now() + Math.min(Math.max(1, timeoutMs), remainingMs);
  traceEvent('MODEL', 'llm_budget_reserved', {
    calls: turn?.calls,
    maxCalls: turn?.maxCalls,
    remainingMs,
    waitedMs: Math.max(0, waitedMs),
  });
  return {
    remainingMs: () => Math.max(0, deadline - Date.now()),
    release: () => {
      if (released) return;
      released = true;
      activeInvocations = Math.max(0, activeInvocations - 1);
      drainSlotWaiters();
    },
  };
}

function removeSlotWaiter(waiter: SlotWaiter) {
  const index = slotWaiters.indexOf(waiter);
  if (index >= 0) slotWaiters.splice(index, 1);
}

function drainSlotWaiters() {
  while (activeInvocations < MAX_CONCURRENT_INVOCATIONS && slotWaiters.length > 0) {
    const waiter = slotWaiters.shift()!;
    clearTimeout(waiter.timer);
    try {
      waiter.resolve(createReservation(waiter.turn, waiter.timeoutMs, Date.now() - waiter.enqueuedAt));
    } catch (error) {
      waiter.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

export function withLlmTurnPolicy<T>(fn: () => T, limits = { maxCalls: 12, timeoutMs: 180_000 }): T {
  return context.run({ deadline: Date.now() + limits.timeoutMs, calls: 0, maxCalls: limits.maxCalls, fallbackKeys: new Set() }, fn);
}

export function reserveLlmInvocation(timeoutMs: number) {
  const turn = context.getStore();
  assertReservationAllowed(turn, timeoutMs);
  if (activeInvocations >= MAX_CONCURRENT_INVOCATIONS) {
    throw new Error('LLM_CAPACITY_EXHAUSTED: 模型并发已满，请稍后重试');
  }
  return createReservation(turn, timeoutMs);
}

/**
 * Async admission path for production calls. The legacy synchronous function
 * above intentionally keeps its fail-fast contract for low-level callers and
 * tests; model requests use this path so a short burst does not turn into a
 * false provider failure merely because all slots are briefly occupied.
 */
export function waitForLlmInvocation(timeoutMs: number) {
  const turn = context.getStore();
  const remainingMs = assertReservationAllowed(turn, timeoutMs);
  if (activeInvocations < MAX_CONCURRENT_INVOCATIONS) {
    return Promise.resolve(createReservation(turn, timeoutMs));
  }
  if (slotWaiters.length >= MAX_WAITING_INVOCATIONS) {
    throw new Error('LLM_CAPACITY_EXHAUSTED: 模型等待队列已满，请稍后重试');
  }

  const waitMs = Math.max(1, Math.min(Math.max(1, timeoutMs), remainingMs));
  return new Promise<ReturnType<typeof createReservation>>((resolve, reject) => {
    const waiter = {
      turn,
      timeoutMs,
      enqueuedAt: Date.now(),
      timer: undefined as unknown as NodeJS.Timeout,
      resolve,
      reject,
    } satisfies Omit<SlotWaiter, 'timer'> & { timer: NodeJS.Timeout };
    waiter.timer = setTimeout(() => {
      removeSlotWaiter(waiter);
      reject(new Error('LLM_CAPACITY_EXHAUSTED: 模型并发已满，等待资源超时，请稍后重试'));
    }, waitMs);
    waiter.timer.unref?.();
    slotWaiters.push(waiter);
    drainSlotWaiters();
  });
}

export function getLlmAdmissionStats() {
  return {
    active: activeInvocations,
    waiting: slotWaiters.length,
    maxConcurrent: MAX_CONCURRENT_INVOCATIONS,
    maxWaiting: MAX_WAITING_INVOCATIONS,
  };
}

export function assertLlmTurnActive() {
  const turn = context.getStore();
  if (turn && Date.now() >= turn.deadline) throw new Error('LLM_TURN_BUDGET_EXHAUSTED: 本轮总时限已达到上限');
}

// Same-turn fallback memory is enough to avoid repeatedly hitting a known
// failed transport. A new user turn can retry after login/settings recover.
export function markTurnFallback(key: string) { context.getStore()?.fallbackKeys.add(key); }
export function hasTurnFallback(key: string) { return context.getStore()?.fallbackKeys.has(key) || false; }
