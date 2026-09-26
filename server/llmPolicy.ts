import { AsyncLocalStorage } from 'node:async_hooks';
import { traceEvent } from './requestTrace.js';

interface TurnPolicy { deadline: number; calls: number; maxCalls: number; fallbackKeys: Set<string> }
const context = new AsyncLocalStorage<TurnPolicy>();
let activeInvocations = 0;
const MAX_CONCURRENT_INVOCATIONS = 4;

export function withLlmTurnPolicy<T>(fn: () => T, limits = { maxCalls: 12, timeoutMs: 180_000 }): T {
  return context.run({ deadline: Date.now() + limits.timeoutMs, calls: 0, maxCalls: limits.maxCalls, fallbackKeys: new Set() }, fn);
}

export function reserveLlmInvocation(timeoutMs: number) {
  const turn = context.getStore();
  const remainingMs = turn ? turn.deadline - Date.now() : timeoutMs;
  if (remainingMs <= 0 || (turn && turn.calls >= turn.maxCalls)) {
    throw new Error('LLM_TURN_BUDGET_EXHAUSTED: 本轮模型调用次数或总时限已达到上限');
  }
  if (activeInvocations >= MAX_CONCURRENT_INVOCATIONS) {
    throw new Error('LLM_CAPACITY_EXHAUSTED: 模型并发已满，请稍后重试');
  }
  if (turn) turn.calls++;
  activeInvocations++;
  let released = false;
  const deadline = Date.now() + Math.min(Math.max(1, timeoutMs), remainingMs);
  traceEvent('MODEL', 'llm_budget_reserved', { calls: turn?.calls, maxCalls: turn?.maxCalls, remainingMs });
  return {
    remainingMs: () => Math.max(0, deadline - Date.now()),
    release: () => { if (!released) { released = true; activeInvocations--; } },
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
