import assert from 'node:assert/strict';
import { completeCodexAppServerChat, shutdownCodexAppServer } from '../server/codexAppServer.ts';

if (process.argv.includes('--debug')) process.env.CODEX_APP_SERVER_DEBUG = '1';

const modelArg = process.argv.find((value) => value.startsWith('--model='));
const db = {
  settings: {
    codexExecutable: process.env.CODEX_EXECUTABLE || 'codex',
    codexModel: modelArg?.slice('--model='.length) || process.env.CODEX_MODEL || 'gpt-5.6-luna',
    codexReasoningEffort: 'low',
    codexTimeoutMs: 90000,
  },
};

try {
  const final = process.argv.includes('--tool-only') ? null : await completeCodexAppServerChat(db, {
    messages: [
      { role: 'system', content: '这是直连探针。只需简短确认，不要使用任何工具。' },
      { role: 'user', content: '回复“直连成功”。' },
    ],
    timeoutMs: 90000,
  });
  if (final) assert.match(final.text, /直连成功/);

  const tool = process.argv.includes('--final-only') ? null : await completeCodexAppServerChat(db, {
    messages: [
      { role: 'system', content: '必须调用给定的 echo_probe 工具，不要直接回答。' },
      { role: 'user', content: '调用 echo_probe，text 参数设为 ok。' },
    ],
    tools: [{
      type: 'function',
      function: {
        name: 'echo_probe',
        description: '直连工具契约探针',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['text'],
          properties: { text: { type: 'string' } },
        },
      },
    }],
    timeoutMs: 90000,
  });
  const call = tool?.raw?.choices?.[0]?.message?.tool_calls?.[0];
  if (tool) {
    assert.equal(call?.function?.name, 'echo_probe');
    assert.deepEqual(JSON.parse(call.function.arguments), { text: 'ok' });
  }
  console.log(JSON.stringify({
    ok: true,
    provider: final?.provider || tool?.provider,
    model: final?.model || tool?.model,
    reply: final?.text || null,
    toolName: call?.function?.name || null,
    totalTokens: Number(final?.usage?.total_tokens || 0) + Number(tool?.usage?.total_tokens || 0),
  }, null, 2));
} finally {
  shutdownCodexAppServer();
}
