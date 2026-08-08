// @ts-nocheck -- legacy runtime module; new typed modules remain checked by tsc.
import WebSocket from 'ws';
import { readDb } from './store.js';
import { oneBotToInternal, processIncoming } from './bot.js';
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
let statusProbeTimer = null;
let statusSampleTimer = null;

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
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectionStatus.markReconnect();
    syncHealth();
    connectOneBot();
  }, 5000);
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

async function sendOneBotMessageInner(event, text, options = {}) {
  const db = readDb();
  const baseUrl = db.settings.oneBotHttpUrl;
  if (!baseUrl) throw new Error('OneBot HTTP 地址未配置。');
  const headers = { 'Content-Type': 'application/json' };
  if (db.settings.oneBotAccessToken) headers.Authorization = `Bearer ${db.settings.oneBotAccessToken}`;

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
  const body = event.type === 'private'
    ? { user_id: Number(event.userId), message: text }
    : { group_id: Number(event.groupId), message: text };

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

async function probeGetStatus() {
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
        headers: { 'Content-Type': 'application/json' },
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
  const normalized = oneBotToInternal(event);
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
  const db = readDb();
  const url = db.settings.oneBotWsUrl;
  if (!url) {
    connectionStatus.markTransportError('没有填写 OneBot WebSocket 地址');
    setOneBotConnected(false);
    setOneBotError('没有填写 OneBot WebSocket 地址');
    return;
  }

  if (ws) {
    ws.removeAllListeners();
    ws.close();
  }
  ws = new WebSocket(url, db.settings.oneBotAccessToken ? { headers: { Authorization: `Bearer ${db.settings.oneBotAccessToken}` } } : undefined);

  ws.on('open', () => {
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
    connectionStatus.markTransportClosed(code, reason?.toString?.());
    syncHealth();
    scheduleReconnect();
  });

  ws.on('error', (error) => {
    connectionStatus.markTransportError(error.message);
    syncHealth();
    scheduleReconnect();
  });
}

export function shutdownOneBot() {
  if (statusProbeTimer) {
    clearInterval(statusProbeTimer);
    statusProbeTimer = null;
  }
  if (statusSampleTimer) {
    clearInterval(statusSampleTimer);
    statusSampleTimer = null;
  }
  if (ws) {
    ws.removeAllListeners();
    try {
      ws.close();
    } catch {
      // Ignore close errors during shutdown.
    }
    ws = null;
  }
  connectionStatus.recordEvent('shutdown', {});
}
