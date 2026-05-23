// In-memory health state — not persisted to DB. Modules update this as side effects.

const state = {
  onebot: { connected: false, lastEventAt: '', lastError: '' },
  sendMessage: { lastSuccessAt: '', lastError: '', recentFailures: 0 },
  llm: { lastSuccessAt: '', lastError: '', recentFailures: 0, totalLatencyMs: 0, callCount: 0 },
  bot: { globalPaused: false, lastDecisionError: '' },
  requestCount: 0,
};

export function getHealth() {
  const avgLatency = state.llm.callCount > 0 ? Math.round(state.llm.totalLatencyMs / state.llm.callCount) : 0;
  return {
    onebot: { ...state.onebot },
    llm: {
      lastSuccessAt: state.llm.lastSuccessAt,
      lastError: state.llm.lastError,
      recentFailures: state.llm.recentFailures,
      avgLatencyMs: avgLatency,
    },
    bot: { ...state.bot },
    requestCount: state.requestCount,
    status: statusSummary(),
  };
}

function statusSummary() {
  if (!state.onebot.connected) return { level: 'error', text: 'QQ未连接' };
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
}

export function setOneBotEvent(time) {
  state.onebot.lastEventAt = time || new Date().toISOString();
  state.requestCount += 1;
}

export function setOneBotError(error) {
  state.onebot.lastError = error ? (new Date().toISOString() + ' ' + error) : '';
}

// ------ Send message updates ------

export function recordSendSuccess() {
  state.sendMessage.lastSuccessAt = new Date().toISOString();
}

export function recordSendError(error) {
  state.sendMessage.lastError = new Date().toISOString();
  state.sendMessage.recentFailures += 1;
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
