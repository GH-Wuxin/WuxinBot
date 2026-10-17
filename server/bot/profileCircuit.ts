// 画像任务的熔断状态机。
//
// 只在「同一套模型配置连续失败」时生效：成功一次清零，换配置（指纹变化）重置，
// 长时间没有再失败也重新计。退避时长随连续失败次数递增 —— 上游长时间不可用时，
// 固定 10 分钟会让它每隔 10 分钟再白等一次 240 秒的调用。
//
// 状态由调用方持有，这里全是纯函数：行为可以直接被测，不用起服务、不用调模型。

export interface ProfileCircuitState {
  until: number;
  fingerprint: string;
  reason: string;
  failures: number;
  lastFailureAt: number;
}

// 连续失败 1 / 2 / 3 / 4 次以上分别退避 10 / 20 / 40 / 120 分钟。
export const PROFILE_CIRCUIT_BACKOFF_MS: number[] = [10, 20, 40, 120].map((minutes) => minutes * 60_000);

// 距离上一次失败超过这个时间，就不再算同一段连续失败。
export const PROFILE_CIRCUIT_STREAK_RESET_MS = 6 * 60 * 60_000;

export const PROFILE_CIRCUIT_CLOSED: ProfileCircuitState = {
  until: 0,
  fingerprint: '',
  reason: '',
  failures: 0,
  lastFailureAt: 0,
};

export function circuitBackoffMs(consecutiveFailures: number): number {
  const raw = Math.floor(Number(consecutiveFailures));
  const failures = Number.isFinite(raw) && raw > 1 ? raw : 1;
  const index = Math.min(PROFILE_CIRCUIT_BACKOFF_MS.length - 1, failures - 1);
  return PROFILE_CIRCUIT_BACKOFF_MS[index];
}

export function tripProfileCircuit(
  state: ProfileCircuitState,
  input: { now: number; fingerprint: string; reason: string },
): ProfileCircuitState {
  const sameSpell = state.fingerprint === input.fingerprint
    && input.now - (Number(state.lastFailureAt) || 0) < PROFILE_CIRCUIT_STREAK_RESET_MS;
  const failures = sameSpell ? Math.max(0, Number(state.failures) || 0) + 1 : 1;
  return {
    until: input.now + circuitBackoffMs(failures),
    fingerprint: input.fingerprint,
    reason: String(input.reason || '').slice(0, 300),
    failures,
    lastFailureAt: input.now,
  };
}

export function clearProfileCircuit(): ProfileCircuitState {
  return { ...PROFILE_CIRCUIT_CLOSED };
}

export function profileCircuitBlockReason(
  state: ProfileCircuitState,
  input: { now: number; fingerprint: string },
): string {
  if (input.now >= state.until) return '';
  if (state.fingerprint !== input.fingerprint) return '';
  return state.reason;
}
