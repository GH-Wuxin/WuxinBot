import WebSocket from 'ws';
import { readDb } from './store.js';
import { oneBotToInternal, processIncoming } from './bot.js';
import { setOneBotConnected, setOneBotEvent, setOneBotError, recordSendSuccess, recordSendError } from './health.js';

let ws;
let reconnectTimer = null;
let reconnectEnabled = false;
let status = {
  connected: false,
  lastError: '',
  lastEventAt: ''
};

// OneBot adapter responsibilities:
// - Connect to NapCat's WebSocket server to receive QQ events.
// - Send normal QQ messages or merged-forward cards through NapCat HTTP.
// The AI/chat logic deliberately lives in bot.ts, not here.
export function getOneBotStatus() {
  return status;
}

function scheduleReconnect() {
  if (!reconnectEnabled || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
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
    recordSendError(`${label}：HTTP ${response.status}`);
    throw new Error(`${label}：HTTP ${response.status} ${body}`);
  }

  let payload = null;
  if (body.trim()) {
    try {
      payload = JSON.parse(body);
    } catch {
      recordSendError(`${label}：返回了无效 JSON`);
      throw new Error(`${label}：OneBot 返回了无效 JSON`);
    }
  }

  const retcode = Number(payload?.retcode ?? 0);
  if (payload?.status === 'failed' || retcode !== 0) {
    const detail = payload?.message || payload?.wording || payload?.msg || body;
    recordSendError(`${label}：retcode ${retcode}`);
    throw new Error(`${label}：retcode ${retcode} ${String(detail || '').slice(0, 500)}`);
  }

  recordSendSuccess();
  return payload;
}

export async function sendOneBotMessage(event, text, options = {}) {
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

export function connectOneBot() {
  reconnectEnabled = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const db = readDb();
  const url = db.settings.oneBotWsUrl;
  if (!url) {
    status = { connected: false, lastError: '没有填写 OneBot WebSocket 地址', lastEventAt: status.lastEventAt };
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
    status = { connected: true, lastError: '', lastEventAt: status.lastEventAt };
    setOneBotConnected(true);
    setOneBotError('');
  });

  ws.on('message', async (data) => {
    status.lastEventAt = new Date().toISOString();
    setOneBotEvent(status.lastEventAt);
    try {
      const event = JSON.parse(data.toString());
      if (event.post_type === 'message') {
        // Normalize NapCat/OneBot's raw event shape before handing it to the
        // bot engine. This keeps the rest of the app independent of OneBot's
        // exact message segment format.
        await processIncoming(oneBotToInternal(event), sendOneBotMessage);
      }
    } catch (error) {
      status.lastError = error.message;
      setOneBotError(error.message);
    }
  });

  ws.on('close', () => {
    setOneBotConnected(false);
    status.connected = false;
    scheduleReconnect();
  });

  ws.on('error', (error) => {
    status.connected = false;
    status.lastError = error.message;
    setOneBotConnected(false);
    setOneBotError(error.message);
    scheduleReconnect();
  });
}
