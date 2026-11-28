import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';
import { createTestDataDir, assertNotProduction } from './test-isolation.mjs';

const dataDir = createTestDataDir('wuxin-pippi-draw');
assertNotProduction(dataDir);
process.env.PIPPI_DRAW_OUTPUT_DIR = path.join(dataDir, 'test-output');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPioAAAAASUVORK5CYII=', 'base64');
const selfRef = await fs.readFile(new URL('../server/assets/pippi-draw-reference.png', import.meta.url));
const selfRefHash = createHash('sha256').update(selfRef).digest('hex');
const privatePrompt = 'DRAW_TEST_PRIVATE_PROMPT_SHOULD_NOT_BE_IN_TRACE';
const calls = { chat: [], images: [], qq: [], media: [] };
const nativeFetch = globalThis.fetch;
let plan;
let delayedGeneration;
let imageResponseStatus = 200;
let nextMessage = 6000;
let quoteResult;
const waitFor = async condition => {
  for (let n = 0; n < 200 && !condition(); n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(condition(), 'condition did not settle');
};
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

// Completely offline. A mistaken new outbound route is an assertion error,
// not an accidental production API charge or QQ message.
globalThis.fetch = async (input, init) => {
  const address = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (address.origin === 'https://api.openai.com' && /\/v1\/(?:responses|chat\/completions)$/.test(address.pathname)) {
    const request = JSON.parse(init.body);
    calls.chat.push(request);
    const { model } = request;
    const tool = plan === undefined ? undefined : {
      id: 'draw-call', name: 'Draw', arguments: JSON.stringify(plan), type: 'function',
    };
    const publicText = tool ? '' : '可以做成白底，不过原配色也不错。';
    if (address.pathname.endsWith('/responses')) {
      return json({ id: 'response-fixture', status: 'completed', model,
        output: tool ? [{ type: 'function_call', call_id: 'draw-call', name: tool.name, arguments: tool.arguments, status: 'completed' }] :
          [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: publicText }] }],
        usage: { input_tokens: 100, output_tokens: 30, total_tokens: 130 } });
    }
    return json({ id: 'completion-fixture', model,
      choices: [{ message: { role: 'assistant', content: publicText,
        ...(tool ? { tool_calls: [{ id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments } }] } : {}) },
        finish_reason: tool ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } });
  }
  if (address.origin === 'https://api.openai.com' && address.pathname.startsWith('/v1/images/')) {
    const { body } = init;
    const imageParts = body instanceof FormData
      ? await Promise.all(body.getAll('image[]').map(async f => createHash('sha256').update(Buffer.from(await f.arrayBuffer())).digest('hex')))
      : [];
    calls.images.push({ path: address.pathname, args: body instanceof FormData ? { model: body.get('model'), prompt: body.get('prompt'), n: body.get('n') } : JSON.parse(body),
      parts: imageParts, auth: new Headers(init.headers).get('authorization') });
    if (delayedGeneration) await delayedGeneration;
    return imageResponseStatus === 200
      ? json({ data: [{ b64_json: png.toString('base64') }], usage: { input_tokens: 11, output_tokens: 23 } })
      : json({ error: { message: privatePrompt } }, imageResponseStatus);
  }
  if (address.origin === 'http://127.0.0.1:29012') {
    const data = JSON.parse(init.body);
    if (address.pathname === '/get_msg') return json({ status: 'ok', retcode: 0, data: quoteResult });
    if (address.pathname === '/get_group_member_info') return json({ status: 'ok', retcode: 0, data: { nickname: 'pippi' } });
    assert.equal(address.pathname, '/send_group_msg');
    calls.qq.push(data);
    return json({ status: 'ok', retcode: 0, data: { message_id: ++nextMessage } });
  }
  if (address.origin === 'https://gchat.qpic.cn') {
    calls.media.push(address.pathname);
    return new Response(png, { headers: { 'content-type': 'image/png' } });
  }
  assert.fail('unexpected network target: ' + address.origin);
};

process.env.PIPPI_DRAW_OPENAI_API_KEY = 'draw-test-key';
const { ensureStore, updateDb, readDb } = await import('../server/store.ts');
const { handleOneBotEvent } = await import('../server/onebot.ts');
const { waitForBackgroundTasks } = await import('../server/backgroundTasks.ts');
const { listRequestTraces } = await import('../server/requestTrace.ts');
const { buildPippiDrawCapability, isAllowedDrawAttachmentUrl, reservePippiDraw } = await import('../server/bot/pippiDraw.ts');
const { extractImageInputs } = await import('../server/bot/cleaning.ts');
const { listPromptCalls } = await import('../server/promptStudio.ts');
const QQ = 900000019;
const REQUESTER = 900000018;
const GROUP_ON = 1201;
const GROUP_OFF = 1202;
const base = (groupId, extra = {}) => ({ groupId: String(groupId), name: 'fixture', mode: 'mention', enabled: true,
  randomImageEnabled: false, maxPerHour: 200, cooldownSec: 0, ...extra });
ensureStore();
updateDb(db => {
  Object.assign(db.settings, {
    selfQq: String(QQ), ownerQq: String(REQUESTER), botNames: 'pippi', globalPaused: false,
    llmProvider: 'openai-compatible', apiBaseUrl: 'https://api.openai.com/v1', apiKey: 'chat-test-key',
    model: 'gpt-6-luna', oneBotHttpUrl: 'http://127.0.0.1:29012',
    visionMode: 'off', thinkingNoticeMode: 'off', osuSearchEnabled: false, profileEnabled: false,
    tokenSavingMode: false, socialV2Enabled: true, pippiFastReplies: true, presenceEnabled: false,
  });
  db.settings.botRegistry = [];
  db.groups = [base(GROUP_ON, { pippiDrawEnabled: true }), base(GROUP_OFF)];
});
const setGroup = enabled => updateDb(db => { db.groups[0].pippiDrawEnabled = enabled; });
const emit = (id, group, text, extra = []) => handleOneBotEvent({
  post_type: 'message', message_type: 'group', self_id: QQ,
  message_id: id, group_id: group, user_id: REQUESTER, sender: { nickname: 'fixture-user', role: 'member' },
  message: [{ type: 'at', data: { qq: String(QQ) } }, { type: 'text', data: { text } }, ...extra],
});
const img = url => ({ type: 'image', data: { url } });
const quoted = id => ({ type: 'reply', data: { id: String(id) } });
const reset = (next) => {
  plan = next;
  delayedGeneration = undefined;
  quoteResult = undefined;
  imageResponseStatus = 200;
  for (const log of Object.values(calls)) log.length = 0;
};

after(async () => {
  await waitForBackgroundTasks(5000);
  globalThis.fetch = nativeFetch;
});

test('only enabled group exposes the extra system prompt and Draw, discussion uses no image request', async () => {
  reset(undefined);
  assert.notEqual(readDb().groups.find(g => g.groupId === String(GROUP_OFF)).pippiDrawEnabled, true);
  updateDb(db => { db.settings.socialV2Enabled = false; });
  await emit(1001, GROUP_OFF, '这张画成白底会不会更好？');
  assert.equal(calls.chat.length, 1);
  assert.ok(!JSON.stringify(calls.chat[0]).includes('【Pippi 生图｜当前群已开启】'));
  assert.ok(!calls.chat[0].tools?.some(t => (t?.name || t?.function?.name) === 'Draw'));
  assert.equal(calls.images.length, 0);
  reset(undefined);
  await emit(1002, GROUP_ON, '这张画成白底会不会更好？');
  assert.equal(calls.chat.length, 1);
  assert.match(JSON.stringify(calls.chat[0]), /【Pippi 生图｜当前群已开启】/);
  assert.ok(calls.chat[0].tools.some(t => (t?.name || t?.function?.name) === 'Draw'));
  assert.equal(calls.images.length, 0);
  updateDb(db => { db.settings.socialV2Enabled = true; });
});

test('natural-language OneBot entry: one LLM call, default 2.6, message pipeline returns before image settles', async () => {
  reset({ prompt: privatePrompt });
  let release;
  delayedGeneration = new Promise(resolve => { release = resolve; });
  try {
    const result = await emit(1010, GROUP_ON, '画一只骑车的鹈鹕');
    assert.equal(result.result.replied, true);
    assert.equal(calls.chat.length, 1, 'no separate rewriting, classifier or post-Draw synthesis');
    assert.equal(calls.qq.length, 1);
    assert.match(calls.qq[0].message, /^\[CQ:reply,id=1010\].*排上了/);
    await waitFor(() => calls.images.length === 1);
    assert.equal(calls.images[0].path, '/v1/images/generations');
    assert.equal(calls.images[0].args.model, 'gpt-image-2.6-sunburst');
    assert.equal(calls.images[0].auth, 'Bearer draw-test-key');
    assert.equal(calls.images[0].args.prompt, privatePrompt);
    const traceJson = JSON.stringify({ traces: listRequestTraces(), prompts: listPromptCalls() });
    assert.ok(!traceJson.includes(privatePrompt));
    assert.ok(!traceJson.includes('draw-test-key'));
  } finally { release(); }
  assert.equal((await waitForBackgroundTasks(4000)).drained, true);
  assert.equal(calls.qq.length, 2);
  assert.match(calls.qq[1].message, /^\[CQ:reply,id=1010\]gpt-image-2\.6-sunburst/);
  const produced = extractImageInputs(calls.qq[1].message)[0];
  const location = fileURLToPath(produced.file || produced.url);
  assert.equal(path.dirname(location), process.env.PIPPI_DRAW_OUTPUT_DIR);
  assert.deepEqual(await fs.readFile(location), png);
  await emit(1010, GROUP_ON, '重复推送同一条');
  assert.equal(calls.images.length, 1);
});

test('self-portrait uses bundled exact 6820; reference-only requests go to edits', async () => {
  reset({ prompt: privatePrompt, model: '2.5', references: ['pippi_self'] });
  await emit(1020, GROUP_ON, '画一个穿冬装的你自己，用2.5');
  assert.equal((await waitForBackgroundTasks(4000)).drained, true);
  assert.equal(calls.chat.length, 1);
  assert.equal(calls.images.length, 1);
  assert.equal(calls.images[0].path, '/v1/images/edits');
  assert.equal(calls.images[0].args.model, 'gpt-image-2.5-sunburst');
  assert.deepEqual(calls.images[0].parts, [selfRefHash]);
  assert.equal(calls.media.length, 0);
});

test('a posted and separately quoted in-room image retain different target/reference roles', async () => {
  reset({ prompt: privatePrompt, model: '2.0', targets: ['quoted:1'], references: ['current:1'] });
  quoteResult = { message_id: 9900, message_type: 'group', group_id: GROUP_ON, sender: { user_id: 100 },
    message: [img('https://gchat.qpic.cn/target')] };
  await emit(1030, GROUP_ON, '用2.0把引用的原图照这张配色改一下', [quoted(9900), img('https://gchat.qpic.cn/reference')]);
  assert.equal((await waitForBackgroundTasks(4000)).drained, true);
  assert.equal(calls.chat.length, 1);
  assert.equal(calls.images.length, 1);
  assert.equal(calls.images[0].args.model, 'gpt-image-2');
  assert.deepEqual(calls.media, ['/target', '/reference']);
  assert.equal(calls.images[0].parts.length, 2);
  assert.match(calls.qq[1].message, /^\[CQ:reply,id=1030\]/);
});

test('can edit the previous output by direct reply without reuploading it', async () => {
  reset({ prompt: privatePrompt });
  await emit(1040, GROUP_ON, '画个图标');
  await waitForBackgroundTasks(4000);
  const producedMessageId = nextMessage;
  reset({ prompt: privatePrompt, targets: ['quoted:1'] });
  await emit(1041, GROUP_ON, '这张改白底', [quoted(producedMessageId)]);
  assert.equal((await waitForBackgroundTasks(4000)).drained, true);
  assert.equal(calls.images.length, 1);
  assert.equal(calls.images[0].path, '/v1/images/edits');
  assert.equal(calls.images[0].parts.length, 1);
  assert.equal(calls.media.length, 0);
  assert.match(calls.qq[1].message, /^\[CQ:reply,id=1041\]/);
});

test('unknown versions, unverified quotes, arbitrary local paths and non-CDN URLs cannot invoke provider', async () => {
  reset({ prompt: privatePrompt, model: 'third-party-model' });
  await emit(1050, GROUP_ON, '用随便什么版本画');
  assert.equal(calls.images.length, 0);
  assert.match(calls.qq[0].message, /没有替你换模型/);
  reset({ prompt: privatePrompt, targets: ['quoted:1'] });
  quoteResult = { message_id: 9901, message_type: 'group', group_id: GROUP_OFF, sender: { user_id: 100 },
    message: [img('https://gchat.qpic.cn/other-group')] };
  await emit(1051, GROUP_ON, '改引用图片', [quoted(9901)]);
  assert.equal(calls.images.length, 0);
  assert.equal(calls.media.length, 0);
  reset({ prompt: privatePrompt, targets: ['current:1'] });
  await emit(1052, GROUP_ON, '改附件', [{ type: 'image', data: { file: path.join(dataDir, 'sensitive.png') } }]);
  await waitForBackgroundTasks(4000);
  assert.equal(calls.images.length, 0);
  assert.equal(calls.media.length, 0);
  assert.equal(isAllowedDrawAttachmentUrl('https://gchat.qpic.cn.evil.invalid/fake'), false);
  assert.equal(isAllowedDrawAttachmentUrl('https://gchat.qpic.cn:8443/image'), false);
  assert.equal(isAllowedDrawAttachmentUrl('http://gchat.qpic.cn/image'), false);
  assert.equal(isAllowedDrawAttachmentUrl('https://127.0.0.1/image'), false);
});

test('closing the switch after queue acknowledgement suppresses output on an already-running job', async () => {
  reset({ prompt: privatePrompt });
  let release;
  delayedGeneration = new Promise(resolve => { release = resolve; });
  try {
    await emit(1060, GROUP_ON, '排一张');
    await waitFor(() => calls.images.length === 1);
    setGroup(false);
    assert.equal(buildPippiDrawCapability(readDb(), { type: 'group', source: 'onebot', groupId: GROUP_ON }), null);
    const forged = reservePippiDraw(readDb(), { type: 'group', source: 'onebot', groupId: GROUP_ON }, {
      id: 'forged', type: 'function', function: { name: 'Draw', arguments: JSON.stringify(plan) },
    }, true, async () => assert.fail('must not send'));
    assert.equal(forged.reservation, undefined);
    assert.equal(forged.result.error, 'draw_disabled');
  } finally { release(); }
  try {
    assert.equal((await waitForBackgroundTasks(4000)).drained, true);
    assert.equal(calls.qq.length, 1);
  } finally { setGroup(true); }
});

test('unsupported model response is never retried or silently downgraded', async () => {
  reset({ prompt: privatePrompt, model: '2.5-flare' });
  imageResponseStatus = 403;
  await emit(1070, GROUP_ON, '用2.5 Flare试试');
  assert.equal((await waitForBackgroundTasks(4000)).drained, true);
  assert.deepEqual(calls.images.map(x => x.args.model), ['gpt-image-2.5-flare']);
  assert.match(calls.qq[1].message, /没有自动换模型/);
  assert.ok(!JSON.stringify(listRequestTraces()).includes(privatePrompt));
});
