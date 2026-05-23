import WebSocket from 'ws';
import { readDb } from './store.js';
import { oneBotToInternal, processIncoming } from './bot.js';
import { setOneBotConnected, setOneBotEvent, setOneBotError, recordSendSuccess, recordSendError } from './health.js';

let ws;
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

    const response = await fetch(`${baseUrl.replace(/\/$/, '')}${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const message = await response.text();
      recordSendError(`合并转发失败：${response.status}`);
      throw new Error(`发送 QQ 合并转发失败：${response.status} ${message}`);
    }
    recordSendSuccess();
    return;
  }

  const endpoint = event.type === 'private' ? '/send_private_msg' : '/send_group_msg';
  const body = event.type === 'private'
    ? { user_id: Number(event.userId), message: text }
    : { group_id: Number(event.groupId), message: text };

  const response = await fetch(`${baseUrl.replace(/\/$/, '')}${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const message = await response.text();
    recordSendError(`消息发送失败：${response.status}`);
    throw new Error(`发送 QQ 消息失败：${response.status} ${message}`);
  }
  recordSendSuccess();
}

export function connectOneBot() {
  const db = readDb();
  const url = db.settings.oneBotWsUrl;
  if (!url) {
    status = { connected: false, lastError: '没有填写 OneBot WebSocket 地址', lastEventAt: status.lastEventAt };
    setOneBotConnected(false);
    setOneBotError('没有填写 OneBot WebSocket 地址');
    return;
  }

  if (ws) ws.close();
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
  });

  ws.on('error', (error) => {
    status.connected = false;
    status.lastError = error.message;
    setOneBotConnected(false);
    setOneBotError(error.message);
  });
}
