// @ts-nocheck -- legacy runtime module; new typed modules remain checked by tsc.
import WebSocket from 'ws';
import { readDb } from './store.js';
import { oneBotToInternal, processIncoming } from './bot.js';
import { extractImageInputs, normalizeMessage } from './bot/cleaning.js';
import {
  setOneBotConnected,
  setOneBotEvent,
  setOneBotError,
  setOneBotDetail,
  recordSendSuccess,
  recordSendError,
  recordGroupActivity,
  getConnectionAggregates,
  resetRecentGroupSample,
} from './health.js';
import { createConnectionStatus } from './onebotStatus.js';
import { tryResolveBotResponse } from './bots/executor.js';

let ws;
let reconnectTimer = null;
let reconnectEnabled = false;
let reconnectAttempt = 0;
let reconnectStableTimer = null;
let statusProbeTimer = null;
let statusSampleTimer = null;

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
// Backoff only resets after the connection proved itself stable. Resetting on
// every 'open' would let a server that accepts and immediately closes (e.g. an
// auth rejection) drive a fixed 1s accept-close storm forever.
const RECONNECT_STABLE_AFTER_MS = 30_000;

// P0-A: four-dimensional connection observer (transport / NapCat API /
// QQ session / heartbeat). It never reconnects or restarts anything; it only
// records evidence so "WS alive but QQ dead" is observable.
const connectionStatus = createConnectionStatus({
  getAggregates: getConnectionAggregates,
});

// OneBot adapter responsibilities:
// - Connect to NapCat's WebSocket server to receive QQ events.
// - Send normal QQ messages or merged-forward cards through NapCat HTTP.
// The AI/chat logic deliberately lives in bot.ts, not here.
export function getOneBotStatus() {
  return connectionStatus.snapshot();
}

function scheduleReconnect() {
  if (!reconnectEnabled || reconnectTimer) return;
  const attempt = reconnectAttempt;
  reconnectAttempt += 1;
  // Exponential backoff with jitter prevents a fixed 5s loop from turning a
  // NapCat outage into an endless reconnect storm, while keeping the first
  // retry fast for a routine close. Jitter only applies while ramping up:
  // once the backoff reaches the 30s cap the delay is exactly the cap.
  const backoff = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** attempt);
  const delay = Math.min(RECONNECT_MAX_DELAY_MS, backoff + Math.floor(Math.random() * 500));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectionStatus.markReconnect();
    syncHealth();
    connectOneBot();
  }, delay);
}

function closeSocketQuietly(socket) {
  if (!socket) return;
  // A WebSocket closed while CONNECTING still emits an 'error' event. Without
  // a listener that EventEmitter error is an uncaught exception that kills the
  // process, so install a no-op error handler after detaching real handlers.
  socket.removeAllListeners();
  socket.on('error', () => {});
  try {
    socket.close();
  } catch {
    // Ignore close errors during replacement/shutdown.
  }
}

function oneBotHeaders(db) {
  const headers = { 'Content-Type': 'application/json' };
  if (db?.settings?.oneBotAccessToken) {
    headers.Authorization = `Bearer ${db.settings.oneBotAccessToken}`;
  }
  return headers;
}

function clearReconnectStableTimer() {
  if (reconnectStableTimer) {
    clearTimeout(reconnectStableTimer);
    reconnectStableTimer = null;
  }
}

function armReconnectStableTimer() {
  clearReconnectStableTimer();
  reconnectStableTimer = setTimeout(() => {
    reconnectStableTimer = null;
    reconnectAttempt = 0;
  }, RECONNECT_STABLE_AFTER_MS);
  reconnectStableTimer.unref?.();
}

async function fetchWithTimeout(url, options, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`OneBot HTTP 请求超时 ${Math.round(timeoutMs / 1000)} 秒`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function assertOneBotSuccess(response, label) {
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${label}：HTTP ${response.status} ${body}`);
  }

  let payload = null;
  if (body.trim()) {
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error(`${label}：OneBot 返回了无效 JSON`);
    }
  }

  const retcode = Number(payload?.retcode ?? 0);
  if (payload?.status === 'failed' || retcode !== 0) {
    const detail = payload?.message || payload?.wording || payload?.msg || body;
    throw new Error(`${label}：retcode ${retcode} ${String(detail || '').slice(0, 500)}`);
  }

  return payload;
}

function dedupeImages(images) {
  const seen = new Set();
  return images.filter((image) => {
    const key = String(image?.url || image?.file || '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function hydrateQuotedMessage(event) {
  const replyMessageId = String(event?.replyMessageId || '').trim();
  if (!replyMessageId) return event;
  const db = readDb();
  const baseUrl = String(db.settings.oneBotHttpUrl || '').replace(/\/$/, '');
  if (!baseUrl) return event;

  try {
    const messageId = /^\d+$/.test(replyMessageId) ? Number(replyMessageId) : replyMessageId;
    const response = await fetchWithTimeout(`${baseUrl}/get_msg`, {
      method: 'POST',
      headers: oneBotHeaders(db),
      body: JSON.stringify({ message_id: messageId }),
    });
    const payload = await assertOneBotSuccess(response, '读取 QQ 引用消息失败');
    const data = payload?.data || {};
    const structured = data.message;
    const raw = data.raw_message;
    const text = normalizeMessage(structured ?? raw ?? '');
    const images = dedupeImages([
      ...extractImageInputs(structured),
      ...extractImageInputs(raw),
    ]);
    return {
      ...event,
      quotedMessage: {
        messageId: replyMessageId,
        text,
        images,
        userId: String(data.sender?.user_id || data.user_id || ''),
        nickname: String(data.sender?.card || data.sender?.nickname || data.nickname || ''),
      },
    };
  } catch (error) {
    console.warn('[onebot] 无法读取引用消息，保留本地回退内容:', error?.message || error);
    return event;
  }
}

async function sendOneBotMessageInner(event, text, options = {}) {
  const db = readDb();
  const baseUrl = db.settings.oneBotHttpUrl;
  if (!baseUrl) throw new Error('OneBot HTTP 地址未配置。');
  const headers = oneBotHeaders(db);

  // Long command output, such as /w help and /w prompt show, is sent as a QQ
  // merged-forward card so it does not occupy the whole group chat screen.
  if (options.forwardNodes?.length) {
    const endpoint = event.type === 'private' ? '/send_private_forward_msg' : '/send_group_forward_msg';
    const body = event.type === 'private'
      ? { user_id: Number(event.userId), messages: options.forwardNodes }
      : { group_id: Number(event.groupId), messages: options.forwardNodes };

    const response = await fetchWithTimeout(`${baseUrl.replace(/\/$/, '')}${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    await assertOneBotSuccess(response, '发送 QQ 合并转发失败');
    return;
  }

  const endpoint = event.type === 'private' ? '/send_private_msg' : '/send_group_msg';
  const replyToMessageId = String(options.replyToMessageId || '').trim();
  const shouldQuote = event.type === 'group' && replyToMessageId;
  const senderQq = String(event.userId || '').trim();
  const alreadyMentionsSender = senderQq && String(text || '').includes(`[CQ:at,qq=${senderQq}]`);
  const message = shouldQuote
    ? `[CQ:reply,id=${replyToMessageId}]${options.mentionSender !== false && senderQq && !alreadyMentionsSender ? `[CQ:at,qq=${senderQq}] ` : ''}${text}`
    : text;
  const body = event.type === 'private'
    ? { user_id: Number(event.userId), message }
    : { group_id: Number(event.groupId), message };

  const response = await fetchWithTimeout(`${baseUrl.replace(/\/$/, '')}${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  await assertOneBotSuccess(response, '发送 QQ 消息失败');
}

export async function sendOneBotMessage(event, text, options = {}) {
  const startedAt = Date.now();
  try {
    const result = await sendOneBotMessageInner(event, text, options);
    recordSendSuccess(Date.now() - startedAt);
    return result;
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    recordSendError(error, latencyMs);
    connectionStatus.recordEvent('send_error', {
      error: String(error?.message || error).slice(0, 300),
      latencyMs,
    });
    throw error;
  }
}

function syncHealth() {
  const s = connectionStatus.snapshot();
  setOneBotConnected(s.connected);
  setOneBotDetail({
    transportConnected: s.transportConnected,
    apiReachable: s.apiReachable,
    accountOnline: s.accountOnline,
    heartbeatFresh: s.heartbeatFresh,
    heartbeatGood: s.heartbeatGood,
    lastHeartbeatAt: s.lastHeartbeatAt,
    lastGetStatusAt: s.lastGetStatusAt,
    lastGetStatusError: s.lastGetStatusError,
    reconnectCount: s.reconnectCount,
    lastReconnectAt: s.lastReconnectAt,
  });
  setOneBotError(s.lastError || '');
}

export async function probeGetStatus() {
  let db;
  try {
    db = readDb();
  } catch {
    return;
  }
  const baseUrl = db?.settings?.oneBotHttpUrl;
  if (!baseUrl) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    let response;
    try {
      response = await fetch(`${String(baseUrl).replace(/\/$/, '')}/get_status`, {
        method: 'POST',
        headers: oneBotHeaders(db),
        body: '{}',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const body = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(body);
    } catch {
      // Invalid JSON handled below as a failed probe.
    }
    if (!response.ok || payload?.status === 'failed' || Number(payload?.retcode ?? 0) !== 0) {
      throw new Error(payload?.message || payload?.wording || `HTTP ${response.status}`);
    }
    const data = payload?.data || {};
    connectionStatus.applyGetStatus({
      ok: true,
      online: typeof data.online === 'boolean' ? data.online : undefined,
      good: typeof data.good === 'boolean' ? data.good : undefined,
    });
  } catch (error) {
    connectionStatus.applyGetStatus({
      ok: false,
      error: String(error?.message || error),
    });
  }
  syncHealth();
}

function ensureStatusProbe() {
  if (statusProbeTimer) return;
  statusProbeTimer = setInterval(() => {
    void probeGetStatus();
  }, 30_000);
  statusSampleTimer = setInterval(() => {
    connectionStatus.sampleNow();
    resetRecentGroupSample();
  }, 60_000);
  statusProbeTimer.unref?.();
  statusSampleTimer.unref?.();
}

export async function handleOneBotEvent(event, sendMessage = sendOneBotMessage) {
  if (event?.post_type !== 'message') {
    return { consumed: false, ignored: true };
  }

  // Normalize once before either routing path. Bot replies can arrive in a
  // private chat or in the configured group, and their image segments must be
  // preserved for the pending tool call instead of being discarded.
  let normalized = oneBotToInternal(event);
  normalized = await hydrateQuotedMessage(normalized);
  const resolved = tryResolveBotResponse(readDb(), {
    userId: normalized.userId,
    type: normalized.type,
    groupId: normalized.type === 'group' ? normalized.groupId : undefined,
    text: normalized.text,
    images: normalized.images || [],
    messageId: normalized.messageId
  });
  if (resolved) {
    return { consumed: true, botResponse: true };
  }

  const result = await processIncoming(normalized, sendMessage);
  return { consumed: false, botResponse: false, result };
}

export function connectOneBot() {
  reconnectEnabled = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  clearReconnectStableTimer();

  let db;
  try {
    db = readDb();
  } catch (error) {
    connectionStatus.markTransportError(`读取配置失败：${String(error?.message || error)}`);
    syncHealth();
    scheduleReconnect();
    return;
  }

  const url = db.settings.oneBotWsUrl;
  if (!url) {
    // Close a stale socket too: reporting "disconnected" while the old WS is
    // still open and receiving events would make health lie in both directions.
    if (ws) {
      const previous = ws;
      ws = null;
      closeSocketQuietly(previous);
      connectionStatus.markTransportClosed(1000, 'connect called without WS URL');
    } else {
      connectionStatus.markTransportError('没有填写 OneBot WebSocket 地址');
    }
    syncHealth();
    return;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    if (ws) {
      const previous = ws;
      ws = null;
      closeSocketQuietly(previous);
      connectionStatus.markTransportClosed(1000, 'connect called with invalid WS URL');
    } else {
      connectionStatus.markTransportError(`OneBot WebSocket 地址无效：${url}`);
    }
    syncHealth();
    return;
  }
  if (parsedUrl.protocol !== 'ws:' && parsedUrl.protocol !== 'wss:') {
    if (ws) {
      const previous = ws;
      ws = null;
      closeSocketQuietly(previous);
      connectionStatus.markTransportClosed(1000, 'connect called with unsupported WS protocol');
    } else {
      connectionStatus.markTransportError(`OneBot WebSocket 地址必须使用 ws:// 或 wss://（当前：${parsedUrl.protocol}）`);
    }
    syncHealth();
    return;
  }

  if (ws) {
    const previous = ws;
    ws = null;
    closeSocketQuietly(previous);
    connectionStatus.markTransportClosed(1000, 'replaced by new connection');
    syncHealth();
  }

  try {
    ws = new WebSocket(
      url,
      db.settings.oneBotAccessToken
        ? { headers: { Authorization: `Bearer ${db.settings.oneBotAccessToken}` } }
        : undefined,
    );
  } catch (error) {
    ws = null;
    connectionStatus.markTransportError(`OneBot WebSocket 创建失败：${String(error?.message || error)}`);
    syncHealth();
    scheduleReconnect();
    return;
  }

  ws.on('open', () => {
    armReconnectStableTimer();
    connectionStatus.markTransportOpen();
    syncHealth();
    ensureStatusProbe();
  });

  ws.on('message', async (data) => {
    try {
      const event = JSON.parse(data.toString());
      if (event?.post_type === 'meta_event') {
        if (event.meta_event_type === 'heartbeat') {
          connectionStatus.handleHeartbeat(event.status || {});
        } else {
          connectionStatus.recordEvent('meta_event', {
            meta_event_type: String(event.meta_event_type || ''),
          });
        }
        syncHealth();
        return;
      }
      if (event?.post_type === 'message' && event.group_id) {
        recordGroupActivity(String(event.group_id));
      }
      const snap = connectionStatus.markEventReceived();
      setOneBotEvent(snap.lastEventAt);
      await handleOneBotEvent(event, sendOneBotMessage);
    } catch (error) {
      connectionStatus.recordEvent('ws_message_error', {
        error: String(error?.message || error).slice(0, 300),
      });
      syncHealth();
    }
  });

  ws.on('close', (code, reason) => {
    clearReconnectStableTimer();
    connectionStatus.markTransportClosed(code, reason?.toString?.());
    syncHealth();
    scheduleReconnect();
  });

  ws.on('error', (error) => {
    clearReconnectStableTimer();
    connectionStatus.markTransportError(error.message);
    syncHealth();
    scheduleReconnect();
  });
}

export function shutdownOneBot() {
  reconnectEnabled = false;
  reconnectAttempt = 0;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  clearReconnectStableTimer();
  if (statusProbeTimer) {
    clearInterval(statusProbeTimer);
    statusProbeTimer = null;
  }
  if (statusSampleTimer) {
    clearInterval(statusSampleTimer);
    statusSampleTimer = null;
  }
  if (ws) {
    const previous = ws;
    ws = null;
    closeSocketQuietly(previous);
    connectionStatus.markTransportClosed(1000, 'shutdown');
  }
  connectionStatus.recordEvent('shutdown', {});
  syncHealth();
}
