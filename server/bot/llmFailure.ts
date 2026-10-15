/**
 * 模型调用失败的分类与说法。
 *
 * 用途是让 pippi 在下一轮能开口时知道自己刚才为什么开不了口。挂掉的那一轮她
 * 根本不存在，没有她说话的余地；但她再开口时应当能说清楚，而不是猜。
 *
 * 分类判断一律字面比较，不用模式匹配。标记取自线上实际出现的错误消息。
 */

export type LlmFailureKind = 'capacity' | 'timeout' | 'auth' | 'other';

const UNAVAILABLE_MARKERS = [
  'at capacity', 'over capacity', 'overloaded', 'rate limit', 'rate-limit',
  'too many requests', 'temporarily unavailable', 'service unavailable',
];

/** 上游明确表示没空。重试和等待都无意义，等容量恢复即可。 */
export function isModelUnavailableError(error: unknown): boolean {
  const status = Number((error as any)?.status || (error as any)?.code || 0);
  if (status === 429 || status === 503 || status === 529) return true;
  const message = String((error as any)?.message || error || '').toLowerCase();
  return UNAVAILABLE_MARKERS.some((marker) => message.includes(marker));
}

/** 调用超时。'timed out' 中间有空格，只查 'timeout' 会漏。 */
export function isModelTimeoutError(error: unknown): boolean {
  const message = String((error as any)?.message || error || '');
  const lower = message.toLowerCase();
  return (error as any)?.name === 'AbortError'
    || message.includes('超时')
    || lower.includes('timeout')
    || lower.includes('timed out');
}

export function isModelAuthError(error: unknown): boolean {
  const status = Number((error as any)?.status || (error as any)?.code || 0);
  const message = String((error as any)?.message || error || '');
  const lower = message.toLowerCase();
  return status === 401 || status === 403
    || lower.includes('authentication') || lower.includes('unauthorized')
    || lower.includes('api key') || lower.includes('invalid key');
}

export function classifyLlmFailure(error: unknown): LlmFailureKind {
  if (isModelUnavailableError(error)) return 'capacity';
  if (isModelTimeoutError(error)) return 'timeout';
  if (isModelAuthError(error)) return 'auth';
  return 'other';
}

/** 写进她自己上下文的说法。像人话，不像错误码。 */
export const LLM_FAILURE_SELF_TEXT: Record<LlmFailureKind, string> = {
  capacity: '模型容量不足',
  timeout: '响应超时',
  auth: '模型凭据有问题',
  other: '模型调用报错',
};

export function describeLlmFailure(kind: LlmFailureKind): string {
  return LLM_FAILURE_SELF_TEXT[kind] || LLM_FAILURE_SELF_TEXT.other;
}
