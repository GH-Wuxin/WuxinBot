// TEMPORARY spike: probe local bot OneBot WS servers as a second client.
// Injects harmless commands with a fake group id and reports what comes back.
import WebSocket from 'ws';
import fs from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function summarize(text) {
  try {
    const j = JSON.parse(text);
    if (j.action) {
      const params = JSON.stringify(j.params || {});
      const imageMark = /base64:\/\//.test(params) ? ` [含base64图 ${Math.round(params.length / 1024)}KB]` : '';
      return `ACTION ${j.action}${imageMark} params=${params.slice(0, 90)}`;
    }
    if (j.post_type) {
      const msg = typeof j.message === 'string' ? j.message.slice(0, 50) : JSON.stringify(j.message || '').slice(0, 50);
      return `EVENT ${j.post_type}/${j.message_type || ''} msg=${msg}`;
    }
    return `FRAME ${JSON.stringify(j).slice(0, 120)}`;
  } catch {
    return `RAW ${text.slice(0, 120)}`;
  }
}

function probe(name, url, options, event, waitMs = 20000) {
  return new Promise((resolve) => {
    const log = [];
    const ws = new WebSocket(url, options);
    const timer = setTimeout(() => { try { ws.close(); } catch { /* noop */ } }, waitMs);
    ws.on('open', () => {
      log.push(`[${name}] OPEN ${url}`);
      if (event) {
        ws.send(JSON.stringify(event));
        log.push(`[${name}] EVENT SENT: ${event.message}`);
      }
    });
    ws.on('message', (data) => {
      log.push(`[${name}] MSG ${summarize(data.toString())}`);
    });
    ws.on('close', (code) => { clearTimeout(timer); log.push(`[${name}] CLOSE ${code}`); resolve(log.join('\n')); });
    ws.on('error', (err) => { clearTimeout(timer); log.push(`[${name}] ERROR ${err.message}`); resolve(log.join('\n')); });
  });
}

const now = Math.floor(Date.now() / 1000);
// 900000007 = ExpTest：group-bot-config.json 里四个 bot 都启用，泄漏影响为零
const fakeGroup = '900000007';
const fakeUser = '900000008';
// 独立 self_id：不与 NapCat 的 900000029 冲突（Shiro 按 self_id 只允许一个客户端）
const spikeSelfId = '900000030';
const sender = { user_id: Number(fakeUser), nickname: 'Spike', card: '', role: 'member' };
const groupEvent = (message) => ({
  post_type: 'message',
  message_type: 'group',
  time: now,
  self_id: Number(spikeSelfId),
  sub_type: 'normal',
  message_id: Math.floor(Date.now() / 1000) + 99999,
  group_id: Number(fakeGroup),
  user_id: Number(fakeUser),
  anonymous: null,
  message,
  raw_message: message,
  font: 0,
  sender,
});
const groupEventArray = (text) => ({
  ...groupEvent([{ type: 'text', data: { text } }]),
  raw_message: text,
});

const hydrantToken = (() => {
  try {
    const cfg = JSON.parse(fs.readFileSync('<BOTS_ROOT>/configs/private/hydrant/appsettings.json', 'utf8'));
    return cfg.Hydrant?.ServerAccessToken || '';
  } catch { return ''; }
})();

const results = [];

const roleHeaders = { 'X-Client-Role': 'Universal', 'X-Self-ID': spikeSelfId };

// 1) LazyBot: /help（文字回复，安全）
results.push(await probe('lazybot', 'ws://127.0.0.1:1145/lazybot', { headers: roleHeaders }, groupEvent('/help'), 20000));

// 2) 雨沐: Shiro 真实路径 /pub/onebotSocket（假群，回复应回到本连接）
results.push(await probe('yumu-connect', 'ws://127.0.0.1:8388/pub/onebotSocket', { headers: roleHeaders }, null, 8000));
results.push(await probe('yumu-bp', 'ws://127.0.0.1:8388/pub/onebotSocket', { headers: roleHeaders }, groupEvent('!bp [TST]Alpha 1-3'), 45000));

// 3) 猫猫: 握手 + ping
results.push(await probe('kanon-connect', 'ws://127.0.0.1:7700/', { headers: roleHeaders }, null, 8000));
results.push(await probe('kanon-ping', 'ws://127.0.0.1:7700/', { headers: roleHeaders }, groupEventArray('ping'), 15000));

// 4) 消防栓: 握手（token 变体）+ where
const hydrantVariants = [
  ['raw+self', { headers: { Authorization: hydrantToken, 'X-Self-ID': spikeSelfId, 'X-Client-Role': 'Universal' } }],
  ['bearer+self', { headers: { Authorization: `Bearer ${hydrantToken}`, 'X-Self-ID': spikeSelfId, 'X-Client-Role': 'Universal' } }],
  ['query+self', { headers: { 'X-Self-ID': spikeSelfId, 'X-Client-Role': 'Universal' } }],
];
for (const [label, opts] of hydrantVariants) {
  const url = label.startsWith('query') ? `ws://127.0.0.1:8800/?access_token=${hydrantToken}` : 'ws://127.0.0.1:8800/';
  results.push(await probe(`hydrant-${label}`, url, opts, groupEventArray('where'), 12000));
}

console.log(results.join('\n\n'));
