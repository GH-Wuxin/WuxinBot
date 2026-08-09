// reasoning-wire-verify.mjs
// Phase 2 v1 wire-contract regression, fully offline:
//   - real completeChat against a local fake HTTP server (no external network)
//   - OFF/HIGH/MAX wire params on the actual request body
//   - thinking requests omit max_tokens
//   - reasoning budget exhaustion retry keeps tools and omits max_tokens
//   - kill-switch (disabled) request keeps the legacy max_tokens behavior
//   - runToolLoop preserves assistant.reasoning_content into the next round
// Exit 0 on all pass, non-zero on any failure.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { completeChat, normalizeLlmMessages } =
  await import(pathToFileURL(path.join(REPO, 'server', 'bot', 'llm.ts')).href);
const { runToolLoop } = await import(pathToFileURL(path.join(REPO, 'server', 'bots', 'executor.ts')).href);
const { createShadowReasoningRouter } =
  await import(pathToFileURL(path.join(REPO, 'server', 'bot', 'reasoningRouter.ts')).href);

let passed = 0;
let failed = 0;
function pass(label) {
  console.log(`PASS [${label}]`);
  passed++;
}
function fail(label, msg) {
  console.error(`FAIL [${label}]: ${msg}`);
  failed++;
}
function assert(cond, label, msg) {
  if (cond) pass(label);
  else fail(label, msg);
}
function eq(actual, expected, label) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function withFakeServer(responses, fn) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* keep {} */ }
      requests.push(parsed);
      const payload = responses[requests.length - 1] || responses[responses.length - 1];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const value = await fn(`http://127.0.0.1:${port}`, requests);
    return value;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const TOOLS = [{
  type: 'function',
  function: {
    name: 'lookup_profile',
    description: 'Look up an osu! player profile by player name.',
    parameters: { type: 'object', properties: { player: { type: 'string' } }, required: ['player'] },
  },
}];

const NORMAL_RESPONSE = (text = 'ok') => ({
  choices: [{ message: { role: 'assistant', content: text, tool_calls: null }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, completion_tokens_details: { reasoning_tokens: 0 } },
});

const EXHAUSTION_RESPONSE = {
  choices: [{ message: { role: 'assistant', content: '', tool_calls: null }, finish_reason: 'length' }],
  usage: { prompt_tokens: 10, completion_tokens: 64, total_tokens: 74, completion_tokens_details: { reasoning_tokens: 64 } },
};

function deepseekDb(baseUrl) {
  return {
    settings: {
      llmProvider: 'deepseek',
      model: 'deepseek-v4-flash',
      apiBaseUrl: baseUrl,
      apiKey: 'test-key',
      deepseekApiKey: 'test-key',
      temperature: 0.4,
      maxTokens: 64,
      visionMode: 'auto',
      visionImageTransport: 'auto',
      visionMaxImages: 3,
      visionMaxImageBytes: 6000000,
      visionImageTimeoutMs: 8000,
      visionMemoryEnabled: false,
      reasoningEnabled: true,
    },
  };
}

// ── 1. MAX wire: thinking enabled, reasoning_effort max, no max_tokens, tools kept ──
{
  const label = 'wire:max';
  const result = await withFakeServer([NORMAL_RESPONSE()], async (baseUrl, requests) => {
    const response = await completeChat(deepseekDb(baseUrl), {
      messages: [{ role: 'user', content: 'query player-one' }],
      tools: TOOLS,
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
      maxTokens: 64,
    });
    return { response, requests };
  });
  eq(result.requests.length, 1, `${label}:request-count`);
  const body = result.requests[0];
  eq(body.thinking, { type: 'enabled' }, `${label}:thinking`);
  eq(body.reasoning_effort, 'max', `${label}:effort`);
  assert(body.tools?.length === 1, `${label}:tools`, 'tools must be present');
  assert(!('max_tokens' in body), `${label}:no-max-tokens`, 'max_tokens must be omitted on thinking');
  assert(result.response.text === 'ok', `${label}:text`, result.response.text);
}

// ── 2. HIGH wire: effort high ──
{
  const label = 'wire:high';
  const result = await withFakeServer([NORMAL_RESPONSE()], async (baseUrl, requests) => {
    const response = await completeChat(deepseekDb(baseUrl), {
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    });
    return { response, requests };
  });
  eq(result.requests[0].thinking, { type: 'enabled' }, `${label}:thinking`);
  eq(result.requests[0].reasoning_effort, 'high', `${label}:effort`);
  assert(!('max_tokens' in result.requests[0]), `${label}:no-max-tokens`, 'max_tokens must be omitted on thinking');
}

// ── 3. OFF wire / kill switch: disabled + legacy max_tokens, no effort ──
{
  const label = 'wire:off';
  const result = await withFakeServer([NORMAL_RESPONSE()], async (baseUrl, requests) => {
    const response = await completeChat(deepseekDb(baseUrl), {
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'disabled' },
      maxTokens: 64,
    });
    return { response, requests };
  });
  const body = result.requests[0];
  eq(body.thinking, { type: 'disabled' }, `${label}:thinking`);
  assert(!('reasoning_effort' in body), `${label}:no-effort`, 'reasoning_effort must not be sent when off');
  eq(body.max_tokens, 64, `${label}:max-tokens`);
}

// ── 4. Budget exhaustion retry: keep tools, omit max_tokens, second request wins ──
{
  const label = 'budget:exhaustion-retry';
  const result = await withFakeServer([EXHAUSTION_RESPONSE, NORMAL_RESPONSE('recovered')], async (baseUrl, requests) => {
    const response = await completeChat(deepseekDb(baseUrl), {
      messages: [{ role: 'user', content: 'query player-one' }],
      tools: TOOLS,
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    });
    return { response, requests };
  });
  eq(result.requests.length, 2, `${label}:request-count`);
  const first = result.requests[0];
  const second = result.requests[1];
  assert(second.tools?.length === 1, `${label}:retry-keeps-tools`, 'retry must keep tools');
  assert(!('max_tokens' in second), `${label}:retry-no-max-tokens`, 'retry must omit max_tokens');
  eq(second.thinking, { type: 'enabled' }, `${label}:retry-thinking`);
  assert(result.response.text === 'recovered', `${label}:text`, result.response.text);
  assert(first.finish_reason === undefined, `${label}:first-is-exhaustion`, 'first request should be exhaustion-shaped response');
}

// ── 5. normalizeLlmMessages preserves reasoning_content ──
{
  const label = 'normalize:reasoning-content';
  const normalized = normalizeLlmMessages([{
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup_profile', arguments: '{}' } }],
    reasoning_content: 'rc-1',
  }]);
  eq(normalized[0].reasoning_content, 'rc-1', `${label}:preserved`);
}

// ── 6. runToolLoop preserves assistant.reasoning_content into round 2 ──
{
  const label = 'loop:reasoning-content-preserved';
  const router = createShadowReasoningRouter();
  const seenMessages = [];
  let calls = 0;
  const fakeChat = async (_db, opts) => {
    calls++;
    seenMessages.push(opts.messages);
    if (calls === 1) {
      const tc = [{ id: 'c1', type: 'function', function: { name: 'fake_tool', arguments: '{}' } }];
      return {
        text: '',
        usage: {},
        meta: null,
        raw: {
          choices: [{
            message: { role: 'assistant', content: '', tool_calls: tc, reasoning_content: 'rc-1' },
            finish_reason: 'tool_calls',
          }],
        },
      };
    }
    return {
      text: 'done',
      usage: {},
      meta: null,
      raw: { choices: [{ message: { role: 'assistant', content: 'done', tool_calls: null }, finish_reason: 'stop' }] },
    };
  };
  const result = await runToolLoop(fakeChat, {
    db: {},
    messages: [{ role: 'user', content: 'do it' }],
    tools: [{
      type: 'function',
      function: { name: 'fake_tool', description: 'fake', parameters: { type: 'object', properties: {}, required: [] } },
    }],
    userId: 'u',
    groupId: 'g',
    maxIterations: 2,
    turnId: 't-rc',
    reasoningRouter: router,
  });
  assert(result.text === 'done', `${label}:text`, result.text);
  assert(seenMessages.length >= 2, `${label}:rounds`, `expected >=2 chat rounds, got ${seenMessages.length}`);
  const round2Assistant = seenMessages[1].filter((m) => m.role === 'assistant');
  assert(round2Assistant.some((m) => m.reasoning_content === 'rc-1'),
    `${label}:round2-has-reasoning-content`,
    `assistant messages: ${JSON.stringify(round2Assistant.map((m) => ({ content: m.content, rc: m.reasoning_content })))}`);

  // Lifecycle boundary: reasoning_content is a short-lived provider
  // continuation field. It must never escape the loop into the caller's
  // delivery payload, final text, or telemetry.
  const containsKey = (value, key) => {
    if (Array.isArray(value)) return value.some((item) => containsKey(item, key));
    if (value && typeof value === 'object') {
      if (Object.prototype.hasOwnProperty.call(value, key)) return true;
      return Object.values(value).some((item) => containsKey(item, key));
    }
    return false;
  };
  assert(!containsKey(result, 'reasoning_content'), `${label}:result-no-reasoning-content`,
    `runToolLoop result must not carry reasoning_content: ${JSON.stringify(result)}`);
  assert(!String(result.text).includes('rc-1'), `${label}:text-no-reasoning-content`,
    'reasoning_content must not leak into final reply text');
}

console.log(`\nREASONING-WIRE-VERIFY: passed=${passed} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
