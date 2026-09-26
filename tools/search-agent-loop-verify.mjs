import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-search-agent-'));
process.env.DATA_DIR = dataDir;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const requests = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  requests.push(Object.fromEntries(url.searchParams.entries()));
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    results: [{
      title: 'DeepSeek official update',
      content: 'The official page describes the newest experimental model.',
      url: 'https://api-docs.deepseek.com/news/news250821',
      engine: 'fixture',
    }],
  }));
});

function toolCallResponse(query) {
  const toolCall = {
    id: 'search-call-1',
    type: 'function',
    function: {
      name: 'search_web',
      arguments: JSON.stringify({
        query,
        category: 'news',
        time_range: 'month',
        language: 'all',
      }),
    },
  };
  return {
    text: '',
    usage: { total_tokens: 10, prompt_tokens: 7, completion_tokens: 3 },
    raw: { choices: [{ message: { content: '', tool_calls: [toolCall] } }] },
  };
}

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const { ensureStore, readDb, updateDb } = await import('../server/store.ts');
  const { buildSearchToolSchema, executeSearchToolCall } = await import('../server/bot/search.ts');
  const { runToolLoop } = await import('../server/bots/executor.ts');
  ensureStore();
  updateDb((db) => {
    db.settings.enableWebSearch = true;
    db.settings.searchProvider = 'searxng';
    db.settings.searchBaseUrl = baseUrl;
    db.settings.searchMaxResults = 5;
    db.settings.searchTimeoutMs = 5000;
  });

  const rewrittenQuery = 'DeepSeek experimental vision model official August 2026';
  let plannerCalls = 0;
  let executorCalls = 0;
  let synthesisSawUrl = false;
  const searchDecisionModel = async (_db, options) => {
    plannerCalls += 1;
    if (plannerCalls === 1) {
      assert(options.tool_choice === 'auto', 'normal search planning must use automatic tool choice');
      assert(options.tools?.some((tool) => tool.function.name === 'search_web'), 'search_web schema must be exposed to the model');
      return toolCallResponse(rewrittenQuery);
    }
    const toolMessage = options.messages.find((message) => message.role === 'tool');
    synthesisSawUrl = Boolean(toolMessage?.content.includes('https://api-docs.deepseek.com/news/news250821'));
    return {
      text: 'DeepSeek 发布了新的实验模型。来源：https://api-docs.deepseek.com/news/news250821',
      usage: { total_tokens: 8, prompt_tokens: 5, completion_tokens: 3 },
      raw: { choices: [{ message: { content: 'done' } }] },
    };
  };

  const searched = await runToolLoop(searchDecisionModel, {
    db: readDb(),
    messages: [
      { role: 'system', content: 'Decide whether and how to search.' },
      { role: 'user', content: '联网搜一下 DeepSeek 最新动态' },
    ],
    tools: [buildSearchToolSchema()],
    userId: 'fixture-user',
    maxIterations: 3,
    executeToolCallFn: async (toolCall, context) => {
      executorCalls += 1;
      return executeSearchToolCall(toolCall, context);
    },
  });

  assert(executorCalls === 1 && searched.toolCallsMade === 1, 'model-selected search must execute exactly once');
  assert(requests.length === 1, 'one SearXNG request must be issued');
  assert(requests[0].q === rewrittenQuery, 'SearXNG must receive the model-rewritten query, not the raw user message');
  assert(requests[0].categories === 'news', 'model-selected search category must reach SearXNG');
  assert(requests[0].time_range === 'month', 'model-selected time range must reach SearXNG');
  assert(requests[0].language === 'all', 'model-selected language must reach SearXNG');
  assert(synthesisSawUrl, 'safe source URLs must survive into the synthesis context');
  assert(searched.text.includes('api-docs.deepseek.com'), 'final synthesis must be returned to the user');

  let noSearchExecutorCalls = 0;
  const noSearch = await runToolLoop(async (_db, options) => {
    assert(options.tools?.some((tool) => tool.function.name === 'search_web'), 'automatic search tool must still be available');
    return {
      text: '你好呀。',
      usage: { total_tokens: 3, prompt_tokens: 2, completion_tokens: 1 },
      raw: { choices: [{ message: { content: '你好呀。' } }] },
    };
  }, {
    db: readDb(),
    messages: [{ role: 'user', content: '你好' }],
    tools: [buildSearchToolSchema()],
    userId: 'fixture-user',
    maxIterations: 3,
    executeToolCallFn: async () => {
      noSearchExecutorCalls += 1;
      throw new Error('search must not execute when the model answered directly');
    },
  });

  assert(noSearchExecutorCalls === 0, 'the model must be able to decide not to search');
  assert(noSearch.toolCallsMade === 0 && noSearch.text === '你好呀。', 'direct answer path must remain a one-call conversation');

  const botSource = fs.readFileSync(path.resolve('server/bot.ts'), 'utf8');
  assert(botSource.includes('buildSearchToolGuidance'), 'conversation path must inject search decision guidance');
  assert(botSource.includes("requiredTool: { toolName: SEARCH_TOOL_NAME"), 'explicit search must retain an executor-backed fallback');
  assert(!botSource.includes('正在搜索：'), 'old fixed-query progress message must be removed');

  console.log('PASS search agent loop: model decides whether, what and how to search; synthesis receives sources');
}

main()
  .finally(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
