// In-memory health state — not persisted to DB. Modules update this as side effects.
import { getKbHealth } from './bot/knowledgeBase.js';

const state = {
  onebot: {
    connected: false,
    transportConnected: false,
    apiReachable: null,
    accountOnline: null,
    heartbeatFresh: false,
    heartbeatGood: null,
    lastEventAt: '',
    lastError: '',
    lastHeartbeatAt: '',
    lastGetStatusAt: '',
    lastGetStatusError: '',
    reconnectCount: 0,
    lastReconnectAt: '',
  },
  sendMessage: {
    lastSuccessAt: '',
    lastError: '',
    recentFailures: 0,
    successCount: 0,
    failureCount: 0,
    totalLatencyMs: 0,
    callCount: 0,
  },
  llm: { lastSuccessAt: '', lastError: '', recentFailures: 0, totalLatencyMs: 0, callCount: 0 },
  bot: { globalPaused: false, lastDecisionError: '' },
  osu: { api429Count: 0, renderFailures: 0 },
  requestCount: 0,
  activeProcessing: 0,
};

// Group IDs seen since the last flight-recorder sample. Kept in memory only;
// the recorder persists only the count, never group IDs.
const recentGroups = new Set<string>();

export function getHealth() {
  const avgLatency = state.llm.callCount > 0 ? Math.round(state.llm.totalLatencyMs / state.llm.callCount) : 0;
  return {
    onebot: { ...state.onebot },
    sendMessage: { ...state.sendMessage },
    llm: {
      lastSuccessAt: state.llm.lastSuccessAt,
      lastError: state.llm.lastError,
      recentFailures: state.llm.recentFailures,
      avgLatencyMs: avgLatency,
    },
    bot: { ...state.bot },
    osu: { ...state.osu },
    kb: getKbHealth(),
    requestCount: state.requestCount,
    activeProcessing: state.activeProcessing,
    status: statusSummary(),
  };
}

function statusSummary() {
  if (!state.onebot.transportConnected && !state.onebot.connected) {
    return { level: 'error', text: 'QQ未连接' };
  }
  if (state.onebot.accountOnline === false) return { level: 'error', text: 'QQ账号离线' };
  if (state.onebot.apiReachable === false) return { level: 'error', text: 'NapCat API 不可达' };
  if (state.onebot.lastHeartbeatAt && state.onebot.heartbeatFresh === false) {
    return { level: 'warn', text: 'Heartbeat 超时' };
  }
  if (state.bot.globalPaused) return { level: 'warn', text: '已暂停' };
  if (state.llm.recentFailures >= 3) return { level: 'warn', text: 'LLM近期失败较多' };
  // lastError format is now "ISO-date error-message"
  if (state.onebot.lastError) {
    const ts = state.onebot.lastError.slice(0, 24);
    try { if (Date.now() - new Date(ts).getTime() < 300_000) return { level: 'warn', text: 'QQ连接近期有错误' }; } catch { /* ignore */ }
  }
  return { level: 'ok', text: '正常运行' };
}

// ------ OneBot updates ------

export function setOneBotConnected(connected) {
  state.onebot.connected = connected;
  state.onebot.transportConnected = connected;
}

export function setOneBotEvent(time) {
  state.onebot.lastEventAt = time || new Date().toISOString();
  state.requestCount += 1;
}

export function setOneBotError(error) {
  state.onebot.lastError = error ? (new Date().toISOString() + ' ' + error) : '';
}

export function setOneBotDetail(detail) {
  if (!detail) return;
  if (typeof detail.transportConnected === 'boolean') state.onebot.transportConnected = detail.transportConnected;
  if (typeof detail.apiReachable === 'boolean' || detail.apiReachable === null) state.onebot.apiReachable = detail.apiReachable;
  if (typeof detail.accountOnline === 'boolean' || detail.accountOnline === null) state.onebot.accountOnline = detail.accountOnline;
  if (typeof detail.heartbeatFresh === 'boolean') state.onebot.heartbeatFresh = detail.heartbeatFresh;
  if (typeof detail.heartbeatGood === 'boolean' || detail.heartbeatGood === null) state.onebot.heartbeatGood = detail.heartbeatGood;
  if (typeof detail.lastHeartbeatAt === 'string') state.onebot.lastHeartbeatAt = detail.lastHeartbeatAt;
  if (typeof detail.lastGetStatusAt === 'string') state.onebot.lastGetStatusAt = detail.lastGetStatusAt;
  if (typeof detail.lastGetStatusError === 'string') state.onebot.lastGetStatusError = detail.lastGetStatusError;
  if (typeof detail.reconnectCount === 'number') state.onebot.reconnectCount = detail.reconnectCount;
  if (typeof detail.lastReconnectAt === 'string') state.onebot.lastReconnectAt = detail.lastReconnectAt;
}

// ------ Send message updates ------

export function recordSendSuccess(latencyMs = 0) {
  state.sendMessage.lastSuccessAt = new Date().toISOString();
  state.sendMessage.successCount += 1;
  state.sendMessage.callCount += 1;
  state.sendMessage.totalLatencyMs += latencyMs || 0;
  state.sendMessage.recentFailures = 0;
}

export function recordSendError(error, latencyMs = 0) {
  state.sendMessage.lastError = new Date().toISOString();
  state.sendMessage.recentFailures += 1;
  state.sendMessage.failureCount += 1;
  state.sendMessage.callCount += 1;
  state.sendMessage.totalLatencyMs += latencyMs || 0;
}

// ------ Connection observability aggregates ------

export function markActiveProcessing(delta) {
  state.activeProcessing = Math.max(0, state.activeProcessing + (Number(delta) || 0));
}

export function recordGroupActivity(groupId) {
  if (groupId) recentGroups.add(String(groupId));
}

export function getConnectionAggregates() {
  const sendAvgLatencyMs =
    state.sendMessage.callCount > 0
      ? Math.round(state.sendMessage.totalLatencyMs / state.sendMessage.callCount)
      : 0;
  return {
    sendSuccess: state.sendMessage.successCount,
    sendFailures: state.sendMessage.failureCount,
    sendAvgLatencyMs,
    activeGroups: recentGroups.size,
    activeProcessing: state.activeProcessing,
  };
}

export function resetRecentGroupSample() {
  recentGroups.clear();
}

// ------ LLM updates ------

export function recordLlmSuccess(latencyMs) {
  state.llm.lastSuccessAt = new Date().toISOString();
  state.llm.totalLatencyMs += latencyMs || 0;
  state.llm.callCount += 1;
  state.llm.recentFailures = 0;
}

export function recordLlmError(error) {
  state.llm.lastError = new Date().toISOString() + ' ' + (error || '');
  state.llm.recentFailures += 1;
}

// ------ Bot updates ------

export function setBotPaused(paused) {
  state.bot.globalPaused = paused;
}

export function recordDecisionError(error) {
  state.bot.lastDecisionError = new Date().toISOString() + ' ' + (error || '');
}

// ------ osu! / renderer updates ------

export function recordOsuApi429() {
  state.osu.api429Count += 1;
}

export function recordRenderFailure() {
  state.osu.renderFailures += 1;
}

// Recalc progress state
const recalcState = { running: false, total: 0, done: 0, label: '', stopped: false };

export function getRecalcProgress() { return { ...recalcState }; }

export function startRecalc(total, label) {
  recalcState.running = true; recalcState.total = total; recalcState.done = 0; recalcState.label = label; recalcState.stopped = false;
}

export function tickRecalc() { recalcState.done++; }

export function stopRecalc() { recalcState.stopped = true; }

export function finishRecalc(label) {
  if (!recalcState.stopped) recalcState.done = recalcState.total;
  recalcState.running = false; recalcState.label = label || recalcState.label;
}
