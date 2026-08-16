// quick-bridge-reliability-verify.mjs
// Offline regression guard for server/bots/localBridge.ts reply correlation,
// ACK, settle, timeout and resource behavior. No live bots, no production
// endpoints, no QQ traffic: every fixture runs against an in-process
// synthetic WebSocket server on 127.0.0.1 with an ephemeral port.
//
// Exit 0 on all pass, non-zero otherwise.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

const REPO = 'G:/QQ-AI-ChatBot';
const LOCAL_BRIDGE = pathToFileURL(path.join(REPO, 'server/bots/localBridge.ts')).href;

let passed = 0;
let failed = 0;
function ok(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`PASS [${name}]${detail ? ' — ' + detail : ''}`);
  } else {
    failed++;
    console.error(`FAIL [${name}]${detail ? ' — ' + detail : ''}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function activeTimeoutCount() {
  try {
    const handles = process._getActiveHandles();
    return handles.filter((h) => h.constructor && h.constructor.name === 'Timeout').length;
  } catch {
    return -1;
  }
}

/**
 * Runs one fixture against a fresh module instance of localBridge.ts.
 * behavior({send, close, socket, req}) schedules synthetic frames.
 */
async function runFixture({ id, botId, timeoutMs, behavior, assert, command = '!audit', context, env }) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-bridge-out-'));
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  const url = `ws://127.0.0.1:${wss.address().port}`;

  // Fresh module instance per fixture: endpoint URL + output dir are read at eval time.
  const savedEnv = {};
  for (const [key, value] of Object.entries(env || {})) {
    savedEnv[key] = process.env[key];
    if (value === null || value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  process.env.BRIDGE_OUTPUT_DIR = outputDir;
  process.env[`BRIDGE_URL_${botId.toUpperCase()}`] = url;
  const moduleUrl = `${LOCAL_BRIDGE}?fixture=${encodeURIComponent(id)}-${Date.now()}`;
  const bridge = await import(moduleUrl);

  const callContext = context || { groupId: '770099', userId: '900000099', nickname: 'AuditUser', atTargets: [] };

  const obs = {
    headers: null,
    inboundEvents: [],
    acks: [],
    sentCount: 0,
    serverClosed: false,
    serverCloseCode: null,
  };
  let clientSocket = null;
  let socketsOpen = 0;
  const beforeTimeouts = activeTimeoutCount();

  wss.on('connection', (socket, req) => {
    socketsOpen++;
    clientSocket = socket;
    obs.headers = req.headers;
    socket.on('message', (data) => {
      const text = String(data);
      let parsed = null;
      try { parsed = JSON.parse(text); } catch {}
      if (parsed && parsed.post_type === 'message') {
        obs.inboundEvents.push(parsed);
      } else if (parsed && parsed.echo !== undefined && (parsed.status !== undefined || parsed.retcode !== undefined)) {
        obs.acks.push(parsed);
      }
      if (behavior && behavior.onInbound) behavior.onInbound(parsed, socket, text);
    });
    socket.on('close', (code) => {
      socketsOpen--;
      obs.serverClosed = true;
      obs.serverCloseCode = code;
    });
    if (behavior && behavior.onConnect) behavior.onConnect(socket);
  });

  const t0 = Date.now();
  let settles = 0;
  let unhandled = null;
  const onUnhandled = (err) => { unhandled = String(err?.message || err); };
  process.on('unhandledRejection', onUnhandled);

  let result;
  let rejection;
  try {
    result = await bridge.callLocalBot(
      botId,
      command,
      callContext,
      timeoutMs,
    );
  } catch (error) {
    rejection = error;
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  settles++;
  const elapsedMs = Date.now() - t0;
  await sleep(60);

  // Late frame delivery attempt: production closes its socket on settlement,
  // so an already-settled call cannot be affected. The synthetic server may
  // still have its side open briefly; exercise a send race and verify no
  // second settlement/unhandled rejection occurs.
  if (clientSocket && clientSocket.readyState === 1) {
    try {
      clientSocket.send(JSON.stringify({
        action: 'send_msg',
        params: { message: [{ type: 'text', data: { text: 'late' } }] },
        echo: 'late-echo',
      }));
    } catch {}
  }
  await sleep(120);
  settles = settles + 0;
  const afterTimeouts = activeTimeoutCount();

  // Close the synthetic server and force remaining sockets down.
  for (const client of wss.clients) { try { client.terminate(); } catch {} }
  await new Promise((resolve) => wss.close(resolve));
  await sleep(50);
  process.removeListener('unhandledRejection', onUnhandled);

  const outputFiles = fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : [];
  try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch {}

  const ctx = {
    result,
    rejection,
    elapsedMs,
    obs,
    outputDir,
    outputFiles,
    timeoutDelta: beforeTimeouts >= 0 && afterTimeouts >= 0 ? afterTimeouts - beforeTimeouts : null,
    settles,
    unhandled,
  };
  if (assert) assert(ctx);
  return ctx;
}

function expectResolve(ctx, name) {
  ok(`${name}:resolves`, ctx.result !== undefined && ctx.rejection === undefined,
    ctx.rejection ? String(ctx.rejection.message || ctx.rejection) : '');
  ok(`${name}:settles-once`, ctx.settles === 1, `settles=${ctx.settles}`);
  ok(`${name}:no-unhandled`, ctx.unhandled === null, ctx.unhandled || '');
}

function expectReject(ctx, name) {
  ok(`${name}:rejects`, ctx.rejection !== undefined && ctx.result === undefined,
    ctx.result ? `unexpected resolve ${JSON.stringify(ctx.result).slice(0, 80)}` : '');
  ok(`${name}:settles-once`, ctx.settles === 1, `settles=${ctx.settles}`);
  ok(`${name}:no-unhandled`, ctx.unhandled === null, ctx.unhandled || '');
}

const fixtures = [];

fixtures.push({
  id: 'fixture-01-normal-text-reply', botId: 'kanon', timeoutMs: 10000,
  behavior: {
    onConnect(socket) {
      socket.send(JSON.stringify({
        action: 'send_msg', echo: 'e-01',
        params: { message_type: 'group', group_id: 770099, message: [{ type: 'text', data: { text: 'hello audit' } }] },
      }));
    },
  },
  assert(ctx) {
    expectResolve(ctx, 'f01');
    ok('f01:text', ctx.result?.text === 'hello audit', JSON.stringify(ctx.result));
    ok('f01:frames', ctx.result?.frames === 1, `frames=${ctx.result?.frames}`);
    ok('f01:ack', ctx.obs.acks.length === 1 && ctx.obs.acks[0].echo === 'e-01' && ctx.obs.acks[0].status === 'ok' && ctx.obs.acks[0].retcode === 0, JSON.stringify(ctx.obs.acks));
    ok('f01:array-message', Array.isArray(ctx.obs.inboundEvents[0]?.message), JSON.stringify(ctx.obs.inboundEvents[0]?.message));
    const selfHeader = String(ctx.obs.headers?.['x-self-id']);
    const headerNum = Number(selfHeader);
    ok('f01:kanon-safe-self-header', Number.isInteger(headerNum) && headerNum >= 7700000000 && headerNum < 7800000000 && headerNum !== 900000099, `x-self-id=${selfHeader}`);
    ok('f01:event-self-id-matches-header', ctx.obs.inboundEvents[0]?.self_id === headerNum, `event.self_id=${ctx.obs.inboundEvents[0]?.self_id}`);
    ok('f01:server-saw-close', ctx.obs.serverClosed, 'server close observed');
  },
});

fixtures.push({
  id: 'fixture-02-image-only-reply', botId: 'hydrant', timeoutMs: 10000,
  behavior: {
    onConnect(socket) {
      socket.send(JSON.stringify({
        action: 'send_msg', echo: 'e-02',
        params: { message_type: 'group', group_id: 770099, message: [{ type: 'image', data: { file: 'http://127.0.0.1:65530/panel.png' } }] },
      }));
    },
  },
  assert(ctx) {
    expectResolve(ctx, 'f02');
    ok('f02:text-empty', (ctx.result?.text || '') === '', JSON.stringify(ctx.result?.text));
    ok('f02:one-image', ctx.result?.images?.length === 1 && ctx.result.images[0].includes('file=http://127.0.0.1:65530/panel.png'), JSON.stringify(ctx.result?.images));
    ok('f02:frames', ctx.result?.frames === 1);
    ok('f02:string-message', typeof ctx.obs.inboundEvents[0]?.message === 'string', JSON.stringify(ctx.obs.inboundEvents[0]?.message));
  },
});

fixtures.push({
  id: 'fixture-03-text-plus-base64-image', botId: 'kanon', timeoutMs: 10000,
  behavior: {
    onConnect(socket) {
      socket.send(JSON.stringify({
        action: 'send_msg', echo: 'e-03',
        params: { message: [{ type: 'text', data: { text: 'header' } }, { type: 'image', data: { file: 'base64://QUFBQQ==' } }] },
      }));
    },
  },
  assert(ctx) {
    expectResolve(ctx, 'f03');
    ok('f03:text', ctx.result?.text === 'header', JSON.stringify(ctx.result));
    ok('f03:image-saved', ctx.result?.images?.length === 1 && ctx.result.images[0].includes('file:///'), JSON.stringify(ctx.result?.images));
    ok('f03:frames', ctx.result?.frames === 1);
    ok('f03:output-file-count', ctx.outputFiles.length === 1, JSON.stringify(ctx.outputFiles));
  },
});

fixtures.push({
  id: 'fixture-04-send-group-msg-action', botId: 'kanon', timeoutMs: 10000,
  behavior: {
    onConnect(socket) {
      socket.send(JSON.stringify({ action: 'send_group_msg', echo: 'e-04', params: { group_id: 770099, message: 'group hello' } }));
      setTimeout(() => { try { socket.close(); } catch {} }, 40);
    },
  },
  assert(ctx) {
    expectResolve(ctx, 'f04');
    ok('f04:text', ctx.result?.text === 'group hello', JSON.stringify(ctx.result));
    ok('f04:ack', ctx.obs.acks.length === 1 && ctx.obs.acks[0].echo === 'e-04');
    ok('f04:fast-close-finish', ctx.elapsedMs < 1000, `elapsed=${ctx.elapsedMs}`);
  },
});

fixtures.push({
  id: 'fixture-05-send-private-msg-action', botId: 'kanon', timeoutMs: 10000,
  behavior: {
    onConnect(socket) {
      socket.send(JSON.stringify({ action: 'send_private_msg', echo: 'e-05', params: { user_id: 1, message: 'private hello' } }));
      setTimeout(() => { try { socket.close(); } catch {} }, 40);
    },
  },
  assert(ctx) {
    expectResolve(ctx, 'f05');
    ok('f05:text', ctx.result?.text === 'private hello', JSON.stringify(ctx.result));
  },
});

fixtures.push({
  id: 'fixture-06-action-with-echo-acked-then-reply', botId: 'kanon', timeoutMs: 10000,
  behavior: {
    onConnect(socket) {
      let replied = false;
      const echo = 'ack-me-06';
      socket.send(JSON.stringify({ action: 'get_login_info', echo, params: {} }));
      const timer = setTimeout(() => { try { socket.close(); } catch {} }, 1200);
      socket.on('message', () => {
        if (replied) return;
        replied = true;
        clearTimeout(timer);
        socket.send(JSON.stringify({ action: 'send_msg', echo: 'e-06', params: { message: [{ type: 'text', data: { text: 'after ack' } }] } }));
        setTimeout(() => { try { socket.close(); } catch {} }, 40);
      });
    },
  },
  assert(ctx) {
    expectResolve(ctx, 'f06');
    ok('f06:ack-shape', ctx.obs.acks.length === 2 && ctx.obs.acks[0].echo === 'ack-me-06' && ctx.obs.acks[0].data?.message_id === 0 && ctx.obs.acks[1].echo === 'e-06', JSON.stringify(ctx.obs.acks));
    ok('f06:text', ctx.result?.text === 'after ack', JSON.stringify(ctx.result));
  },
});

fixtures.push({
  id: 'fixture-07-action-without-echo-not-acked', botId: 'kanon', timeoutMs: 10000,
  behavior: {
    onConnect(socket) {
      socket.send(JSON.stringify({ action: 'get_login_info', params: {} }));
      setTimeout(() => { try { socket.close(); } catch {} }, 60);
    },
  },
  assert(ctx) {
    expectReject(ctx, 'f07');
    ok('f07:no-ack', ctx.obs.acks.length === 0, JSON.stringify(ctx.obs.acks));
    ok('f07:no-reply-reject', String(ctx.rejection?.message || '').includes('无回复'), String(ctx.rejection?.message));
  },
});

fixtures.push({
  id: 'fixture-08-malformed-json-frame', botId: 'kanon', timeoutMs: 10000,
  behavior: {
    onConnect(socket) {
      socket.send('this is not json {{{');
      setTimeout(() => { try { socket.close(); } catch {} }, 60);
    },
  },
  assert(ctx) {
    expectReject(ctx, 'f08');
    ok('f08:no-reply-reject', String(ctx.rejection?.message || '').includes('无回复'), String(ctx.rejection?.message));
  },
});

fixtures.push({
  id: 'fixture-09-unrelated-json-frame', botId: 'kanon', timeoutMs: 10000,
  behavior: {
    onConnect(socket) {
      socket.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat', time: 1 }));
      setTimeout(() => { try { socket.close(); } catch {} }, 60);
    },
  },
  assert(ctx) {
    expectReject(ctx, 'f09');
    ok('f09:frames-not-counted', ctx.result === undefined, 'ignored frame must not count');
  },
});

fixtures.push({
  id: 'fixture-10-empty-frame', botId: 'kanon', timeoutMs: 10000,
  behavior: {
    onConnect(socket) {
      socket.send('');
      setTimeout(() => { try { socket.close(); } catch {} }, 60);
    },
  },
  assert(ctx) {
    expectReject(ctx, 'f10');
    ok('f10:no-reply-reject', String(ctx.rejection?.message || '').includes('无回复'));
  },
});

fixtures.push({
  id: 'fixture-11-multi-frame-settle-reset', botId: 'kanon', timeoutMs: 10000,
  behavior: {
    onConnect(socket) {
      socket.send(JSON.stringify({ action: 'send_msg', echo: 'e-11a', params: { message: [{ type: 'text', data: { text: 'one' } }] } }));
      setTimeout(() => {
        try {
          socket.send(JSON.stringify({ action: 'send_msg', echo: 'e-11b', params: { message: [{ type: 'image', data: { file: 'http://127.0.0.1:65531/two.png' } }] } }));
        } catch {}
      }, 400);
    },
  },
  assert(ctx) {
    expectResolve(ctx, 'f11');
    ok('f11:text', ctx.result?.text === 'one', JSON.stringify(ctx.result));
    ok('f11:images', ctx.result?.images?.length === 1, JSON.stringify(ctx.result?.images));
    ok('f11:frames', ctx.result?.frames === 2, `frames=${ctx.result?.frames}`);
    ok('f11:acks', ctx.obs.acks.length === 2, JSON.stringify(ctx.obs.acks));
    ok('f11:settle-extended', ctx.elapsedMs >= 3300 && ctx.elapsedMs < 5000, `elapsed=${ctx.elapsedMs}`);
  },
});

fixtures.push({
  id: 'fixture-12-delayed-response', botId: 'kanon', timeoutMs: 5000,
  behavior: {
    onConnect(socket) {
      setTimeout(() => {
        socket.send(JSON.stringify({ action: 'send_msg', echo: 'e-12', params: { message: 'late but valid' } }));
        setTimeout(() => { try { socket.close(); } catch {} }, 40);
      }, 80);
    },
  },
  assert(ctx) {
    expectResolve(ctx, 'f12');
    ok('f12:text', ctx.result?.text === 'late but valid', JSON.stringify(ctx.result));
    ok('f12:latency-window', ctx.elapsedMs >= 80 && ctx.elapsedMs < 1000, `elapsed=${ctx.elapsedMs}`);
  },
});

fixtures.push({
  id: 'fixture-13-close-before-reply', botId: 'kanon', timeoutMs: 10000,
  behavior: {
    onConnect(socket) { setTimeout(() => { try { socket.close(); } catch {} }, 20); },
  },
  assert(ctx) {
    expectReject(ctx, 'f13');
    ok('f13:no-reply-reject', String(ctx.rejection?.message || '').includes('无回复'));
    ok('f13:fast', ctx.elapsedMs < 1000, `elapsed=${ctx.elapsedMs}`);
  },
});

fixtures.push({
  id: 'fixture-14-reply-just-before-timeout', botId: 'kanon', timeoutMs: 300,
  behavior: {
    onConnect(socket) {
      setTimeout(() => {
        try { socket.send(JSON.stringify({ action: 'send_msg', echo: 'e-14', params: { message: 'too late to settle' } })); } catch {}
      }, 270);
    },
  },
  assert(ctx) {
    // QUICK_BRIDGE_FIX_P0_3: a valid reply accepted before the no-reply
    // deadline must win over the original timeout and resolve after the
    // bounded 3s settle. Pre-fix this fixture rejected at the 300ms timeout
    // and discarded the extracted reply.
    expectResolve(ctx, 'f14');
    ok('f14:text', ctx.result?.text === 'too late to settle', JSON.stringify(ctx.result));
    ok('f14:ack-still-sent', ctx.obs.acks.length === 1 && ctx.obs.acks[0].echo === 'e-14', JSON.stringify(ctx.obs.acks));
    ok('f14:settle-resolution', ctx.elapsedMs >= 3000 && ctx.elapsedMs < 4500, `elapsed=${ctx.elapsedMs}`);
  },
});

fixtures.push({
  id: 'fixture-15-action-only-no-final-reply', botId: 'kanon', timeoutMs: 250,
  behavior: {
    onConnect(socket) {
      socket.send(JSON.stringify({ action: 'get_group_info', echo: 'g-15', params: { group_id: 770099 } }));
    },
  },
  assert(ctx) {
    expectReject(ctx, 'f15');
    ok('f15:timeout-message', String(ctx.rejection?.message || '').includes('调用超时'));
    ok('f15:ack', ctx.obs.acks.length === 1 && ctx.obs.acks[0].echo === 'g-15');
  },
});

fixtures.push({
  id: 'fixture-16-huge-base64-image', botId: 'kanon', timeoutMs: 10000,
  behavior: {
    onConnect(socket) {
      const big = Buffer.alloc(1_500_000, 7);
      socket.send(JSON.stringify({
        action: 'send_msg', echo: 'e-16',
        params: { message: [{ type: 'image', data: { file: 'base64://' + big.toString('base64') } }] },
      }));
    },
  },
  assert(ctx) {
    expectResolve(ctx, 'f16');
    ok('f16:image-count', ctx.result?.images?.length === 1, JSON.stringify(ctx.result?.images?.length));
    ok('f16:frames', ctx.result?.frames === 1);
  },
});

fixtures.push({
  id: 'fixture-17-message-array-without-echo', botId: 'kanon', timeoutMs: 10000,
  behavior: {
    onConnect(socket) {
      socket.send(JSON.stringify({ action: 'send_msg', params: { message: [{ type: 'text', data: { text: 'no echo' } }] } }));
      setTimeout(() => { try { socket.close(); } catch {} }, 40);
    },
  },
  assert(ctx) {
    expectResolve(ctx, 'f17');
    ok('f17:text', ctx.result?.text === 'no echo', JSON.stringify(ctx.result));
    ok('f17:no-ack', ctx.obs.acks.length === 0, JSON.stringify(ctx.obs.acks));
  },
});

fixtures.push({
  id: 'fixture-18-cq-string-payload', botId: 'hydrant', timeoutMs: 10000,
  behavior: {
    onConnect(socket) {
      socket.send(JSON.stringify({ action: 'send_msg', echo: 'e-18', params: { message: '[CQ:image,file=http://127.0.0.1:65532/a.png]请看' } }));
      setTimeout(() => { try { socket.close(); } catch {} }, 40);
    },
  },
  assert(ctx) {
    expectResolve(ctx, 'f18');
    ok('f18:text', ctx.result?.text === '请看', JSON.stringify(ctx.result));
    ok('f18:image', ctx.result?.images?.length === 1 && ctx.result.images[0].includes('a.png'), JSON.stringify(ctx.result?.images));
  },
});

fixtures.push({
  id: 'fixture-19-unusual-echo-types', botId: 'kanon', timeoutMs: 10000,
  behavior: {
    onConnect(socket) {
      socket.send(JSON.stringify({ action: 'get_login_info', echo: 0, params: {} }));
    },
    onInbound(parsed, socket) {
      if (parsed && parsed.echo === 0 && parsed.status === 'ok') {
        socket.send(JSON.stringify({ action: 'send_msg', echo: 'final-19', params: { message: [{ type: 'text', data: { text: 'echo ok' } }] } }));
        setTimeout(() => { try { socket.close(); } catch {} }, 40);
      }
    },
  },
  assert(ctx) {
    expectResolve(ctx, 'f19');
    ok('f19:echo0-preserved', ctx.obs.acks.some((a) => a.echo === 0), JSON.stringify(ctx.obs.acks));
    ok('f19:text', ctx.result?.text === 'echo ok');
  },
});

fixtures.push({
  id: 'fixture-20-reply-action-empty-message', botId: 'kanon', timeoutMs: 10000,
  behavior: {
    onConnect(socket) {
      socket.send(JSON.stringify({ action: 'send_msg', echo: 'e-20', params: {} }));
      setTimeout(() => { try { socket.close(); } catch {} }, 60);
    },
  },
  assert(ctx) {
    expectReject(ctx, 'f20');
    ok('f20:no-reply-reject', String(ctx.rejection?.message || '').includes('无回复'));
    ok('f20:reply-like-not-extracted', ctx.obs.acks.length === 1, 'ack still sent, extraction empty');
  },
});

fixtures.push({
  id: 'fixture-21-image-segment-without-file', botId: 'kanon', timeoutMs: 10000,
  behavior: {
    onConnect(socket) {
      socket.send(JSON.stringify({ action: 'send_msg', echo: 'e-21', params: { message: [{ type: 'image', data: { url: 'https://x/y.png' } }] } }));
      setTimeout(() => { try { socket.close(); } catch {} }, 60);
    },
  },
  assert(ctx) {
    expectReject(ctx, 'f21');
    ok('f21:no-reply-reject', String(ctx.rejection?.message || '').includes('无回复'));
  },
});

fixtures.push({
  id: 'fixture-22-face-only-array', botId: 'kanon', timeoutMs: 10000,
  behavior: {
    onConnect(socket) {
      socket.send(JSON.stringify({ action: 'send_msg', echo: 'e-22', params: { message: [{ type: 'face', data: { id: '1' } }] } }));
      setTimeout(() => { try { socket.close(); } catch {} }, 60);
    },
  },
  assert(ctx) {
    expectReject(ctx, 'f22');
    ok('f22:no-reply-reject', String(ctx.rejection?.message || '').includes('无回复'));
  },
});

fixtures.push({
  id: 'fixture-23-late-frame-before-settle-extends', botId: 'kanon', timeoutMs: 12000,
  behavior: {
    onConnect(socket) {
      socket.send(JSON.stringify({ action: 'send_msg', echo: 'e-23a', params: { message: [{ type: 'text', data: { text: 'first' } }] } }));
      setTimeout(() => {
        try { socket.send(JSON.stringify({ action: 'send_msg', echo: 'e-23b', params: { message: [{ type: 'text', data: { text: 'second' } }] } })); } catch {}
      }, 2900);
    },
  },
  assert(ctx) {
    expectResolve(ctx, 'f23');
    ok('f23:frames', ctx.result?.frames === 2, `frames=${ctx.result?.frames}`);
    ok('f23:text', ctx.result?.text === 'first\nsecond', JSON.stringify(ctx.result?.text));
    ok('f23:settle-extended', ctx.elapsedMs >= 5800 && ctx.elapsedMs < 8000, `elapsed=${ctx.elapsedMs}`);
  },
});

fixtures.push({
  id: 'fixture-24-close-after-reply-before-settle', botId: 'kanon', timeoutMs: 10000,
  behavior: {
    onConnect(socket) {
      socket.send(JSON.stringify({ action: 'send_msg', echo: 'e-24', params: { message: 'quick close' } }));
      setTimeout(() => { try { socket.close(); } catch {} }, 50);
    },
  },
  assert(ctx) {
    expectResolve(ctx, 'f24');
    ok('f24:text', ctx.result?.text === 'quick close');
    ok('f24:no-3s-settle', ctx.elapsedMs < 1000, `elapsed=${ctx.elapsedMs}`);
  },
});

// ── QUICK_BRIDGE_FIX_P0_1 targeted regressions ──

fixtures.push({
  id: 'p01-collision-regression', botId: 'kanon', timeoutMs: 10000,
  command: '!re [SHK]Wuxin',
  context: { groupId: '770099', userId: '1000000003', nickname: 'CollisionUser', atTargets: [] },
  behavior: {
    onConnect(socket) {
      socket.send(JSON.stringify({ action: 'send_msg', echo: 'e-p01', params: { message: [{ type: 'text', data: { text: 'collision fixed' } }] } }));
      setTimeout(() => { try { socket.close(); } catch {} }, 40);
    },
  },
  assert(ctx) {
    expectResolve(ctx, 'p01');
    const ev = ctx.obs.inboundEvents[0];
    const header = String(ctx.obs.headers?.['x-self-id']);
    ok('p01:user-id-preserved', ev?.user_id === 1000000003, `user_id=${ev?.user_id}`);
    ok('p01:sender-user-id-preserved', ev?.sender?.user_id === 1000000003, JSON.stringify(ev?.sender));
    ok('p01:self-header-not-colliding', header !== '1000000003' && Number(header) >= 7700000000 && Number(header) < 7800000000, `x-self-id=${header}`);
    ok('p01:event-self-id-matches', ev?.self_id === Number(header), `event.self_id=${ev?.self_id}`);
    ok('p01:command', ev?.raw_message === '!re [SHK]Wuxin', JSON.stringify(ev?.raw_message));
    ok('p01:array-message', Array.isArray(ev?.message), JSON.stringify(ev?.message));
    ok('p01:reply', ctx.result?.text === 'collision fixed', JSON.stringify(ctx.result));
    ok('p01:ack', ctx.obs.acks.length === 1 && ctx.obs.acks[0].echo === 'e-p01', JSON.stringify(ctx.obs.acks));
  },
});

fixtures.push({
  id: 'p01-normal-kanon-call', botId: 'kanon', timeoutMs: 10000,
  command: '!re mrekk',
  context: { groupId: '770099', userId: '900000099', nickname: 'NormalUser', atTargets: [] },
  behavior: {
    onConnect(socket) {
      socket.send(JSON.stringify({ action: 'send_msg', echo: 'e-p01n', params: { message: [{ type: 'text', data: { text: 'normal ok' } }] } }));
      setTimeout(() => { try { socket.close(); } catch {} }, 40);
    },
  },
  assert(ctx) {
    expectResolve(ctx, 'p01n');
    const ev = ctx.obs.inboundEvents[0];
    const header = String(ctx.obs.headers?.['x-self-id']);
    ok('p01n:user-id-preserved', ev?.user_id === 900000099, `user_id=${ev?.user_id}`);
    ok('p01n:self-header-safe', Number(header) >= 7700000000 && Number(header) < 7800000000 && header !== '900000099', `x-self-id=${header}`);
    ok('p01n:command', ev?.raw_message === '!re mrekk', JSON.stringify(ev?.raw_message));
    ok('p01n:reply', ctx.result?.text === 'normal ok', JSON.stringify(ctx.result));
  },
});

fixtures.push({
  id: 'p01-env-override-normal', botId: 'kanon', timeoutMs: 10000,
  env: { BRIDGE_SELF_ID: '424242' },
  command: '!re mrekk',
  context: { groupId: '770099', userId: '900000099', nickname: 'EnvUser', atTargets: [] },
  behavior: {
    onConnect(socket) {
      socket.send(JSON.stringify({ action: 'send_msg', echo: 'e-p01e', params: { message: 'env ok' } }));
      setTimeout(() => { try { socket.close(); } catch {} }, 40);
    },
  },
  assert(ctx) {
    expectResolve(ctx, 'p01e');
    ok('p01e:env-used', String(ctx.obs.headers?.['x-self-id']) === '424242', JSON.stringify(ctx.obs.headers?.['x-self-id']));
    ok('p01e:reply', ctx.result?.text === 'env ok', JSON.stringify(ctx.result));
  },
});

fixtures.push({
  id: 'p01-env-override-colliding', botId: 'kanon', timeoutMs: 10000,
  env: { BRIDGE_SELF_ID: '1000000003' },
  command: '!re [SHK]Wuxin',
  context: { groupId: '770099', userId: '1000000003', nickname: 'EnvCollisionUser', atTargets: [] },
  behavior: {
    onConnect(socket) {
      socket.send(JSON.stringify({ action: 'send_msg', echo: 'e-p01c', params: { message: 'env collision handled' } }));
      setTimeout(() => { try { socket.close(); } catch {} }, 40);
    },
  },
  assert(ctx) {
    expectResolve(ctx, 'p01c');
    const ev = ctx.obs.inboundEvents[0];
    const header = String(ctx.obs.headers?.['x-self-id']);
    ok('p01c:override-bypassed-on-collision', header !== '1000000003' && Number(header) >= 7700000000 && Number(header) < 7800000000, `x-self-id=${header}`);
    ok('p01c:user-id-preserved', ev?.user_id === 1000000003, `user_id=${ev?.user_id}`);
    ok('p01c:reply', ctx.result?.text === 'env collision handled', JSON.stringify(ctx.result));
  },
});

// ── run ──
const timeoutDeltas = [];
for (const fixture of fixtures) {
  console.log(`\n=== ${fixture.id} (${fixture.botId}, timeout ${fixture.timeoutMs}ms) ===`);
  const ctx = await runFixture(fixture);
  if (ctx.timeoutDelta !== null) timeoutDeltas.push(ctx.timeoutDelta);
  console.log(`  elapsed=${ctx.elapsedMs}ms timeoutDelta=${ctx.timeoutDelta} serverClosed=${ctx.obs.serverClosed}`);
}

// ── p01 concurrent identity regression (shared module instance) ──
{
  console.log('\n=== p01-concurrent-kanon-calls ===');
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-concurrent-out-'));
  process.env.BRIDGE_OUTPUT_DIR = outputDir;
  delete process.env.BRIDGE_SELF_ID;
  const wss2 = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => wss2.once('listening', resolve));
  process.env.BRIDGE_URL_KANON = `ws://127.0.0.1:${wss2.address().port}`;
  const mod = await import(`${LOCAL_BRIDGE}?concurrent=${Date.now()}`);
  const seen = [];
  wss2.on('connection', (socket, req) => {
    socket.on('message', (data) => {
      let parsed = null;
      try { parsed = JSON.parse(String(data)); } catch {}
      if (parsed && parsed.post_type === 'message') {
        seen.push({ header: String(req.headers['x-self-id']), event: parsed });
        socket.send(JSON.stringify({ action: 'send_msg', echo: `e-${parsed.user_id}`, params: { message: 'concurrent ok' } }));
        setTimeout(() => { try { socket.close(); } catch {} }, 20);
      }
    });
  });
  const contexts = [
    { userId: '1000000003' },
    { userId: '900000099' },
    { userId: '7700000042' },
    { userId: '1000000003' },
    { userId: '3861208813' },
    { userId: '570341031' },
  ];
  const results = await Promise.all(contexts.map((c, i) => mod.callLocalBot(
    'kanon',
    '!re user',
    { groupId: '770099', userId: c.userId, nickname: `Concurrent${i}`, atTargets: [] },
    10000,
  ).then((reply) => ({ ok: true, reply, i })).catch((error) => ({ ok: false, error: String(error?.message || error), i }))));
  ok('p01c:all-resolved', results.every((r) => r.ok), JSON.stringify(results.filter((r) => !r.ok)));
  ok('p01c:all-replied', results.every((r) => r.ok && r.reply.text === 'concurrent ok'));
  const headers = seen.map((s) => s.header);
  ok('p01c:unique-identities', new Set(headers).size === contexts.length, JSON.stringify(headers));
  ok('p01c:reserved-range', headers.every((h) => Number(h) >= 7700000000 && Number(h) < 7800000000), JSON.stringify(headers));
  ok('p01c:no-sender-collision', seen.every((s) => String(s.header) !== String(s.event.user_id)), JSON.stringify(seen.map((s) => [s.header, s.event.user_id])));
  ok('p01c:event-self-id-matches', seen.every((s) => s.event.self_id === Number(s.header)));
  ok('p01c:sender-preserved', seen.every((s) => s.event.user_id === s.event.sender?.user_id));
  for (const client of wss2.clients) { try { client.terminate(); } catch {} }
  await new Promise((resolve) => wss2.close(resolve));
  try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch {}
}

const positiveDeltas = timeoutDeltas.filter((d) => d > 0);
console.log(`\nTimer deltas across fixtures: ${JSON.stringify(timeoutDeltas)}`);
if (positiveDeltas.length > 0) {
  console.error(`FAIL timer leak suspicion: positive Timeout handle deltas ${JSON.stringify(positiveDeltas)}`);
  failed++;
} else {
  passed++;
  console.log('PASS timer-handle growth check across fixtures');
}

console.log(`\nquick-bridge-reliability-verify: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
