import http from 'node:http';
import {
  assertNotProduction,
  cleanupTestDir,
  createTestDataDir,
  productionDbSnapshot,
  verifyProductionDbUnchanged,
} from './test-isolation.mjs';

const testDataDir = createTestDataDir('wuxin-agent-v2-process');
process.env.DATA_DIR = testDataDir;
process.env.OSU_CLIENT_ID = 'fixture-id';
process.env.OSU_CLIENT_SECRET = 'fixture-secret';
assertNotProduction(testDataDir);
const productionBefore = productionDbSnapshot();

let llmCalls = 0;
const requestToolInventories = [];
const observedToolEnvelopes = [];

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');

    if (url.pathname === '/oauth/token') {
      res.end(JSON.stringify({ access_token: 'fixture-token', token_type: 'Bearer', expires_in: 3600 }));
      return;
    }

    if (url.pathname === '/api/v2/users/1234567/osu') {
      res.end(JSON.stringify({
        id: 1234567,
        username: 'AgentFixture',
        country_code: 'CN',
        playmode: 'osu',
        statistics: {
          pp: 8123.45,
          global_rank: 12345,
          country_rank: 456,
          hit_accuracy: 98.76,
          play_count: 2345,
          play_time: 360000,
          level: { current: 100, progress: 25 },
        },
      }));
      return;
    }

    if (url.pathname === '/v1/chat/completions') {
      const body = JSON.parse(raw || '{}');
      llmCalls += 1;
      const toolNames = (body.tools || []).map((tool) => tool?.function?.name).filter(Boolean);
      requestToolInventories.push(toolNames);
      const toolResults = (body.messages || []).filter((message) => message.role === 'tool');
      if (toolResults.length > 0) {
        const latest = toolResults[toolResults.length - 1];
        observedToolEnvelopes.push(JSON.parse(latest.content));
      }

      let message;
      let finishReason = 'tool_calls';
      if (toolResults.length === 0) {
        message = {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'profile-call',
            type: 'function',
            function: { name: 'osu_get_player_profile', arguments: '{}' },
          }],
        };
      } else if (toolResults.length === 1) {
        message = {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'skill-call',
            type: 'function',
            function: { name: 'get_player_skill', arguments: JSON.stringify({ player: 'AgentFixture' }) },
          }],
        };
      } else {
        finishReason = 'stop';
        message = {
          role: 'assistant',
          content: '我把实时资料和技能快照一起核对过了：AgentFixture 当前 PP 8123.45，技能画像偏综合。',
        };
      }

      res.end(JSON.stringify({
        id: `chat-${llmCalls}`,
        object: 'chat.completion',
        created: Date.now(),
        model: 'fixture-model',
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: `unhandled fixture route ${url.pathname}` }));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
process.env.OSU_TOKEN_URL = `http://127.0.0.1:${port}/oauth/token`;
process.env.OSU_API_BASE_URL = `http://127.0.0.1:${port}/api/v2`;

try {
  const { ensureStore, readDb, updateDb } = await import('../server/store.ts');
  const { processIncoming } = await import('../server/bot.ts');
  const { listRequestTraces } = await import('../server/requestTrace.ts');
  ensureStore();
  updateDb((db) => {
    db.settings.ownerQq = '10001';
    db.settings.selfQq = '10002';
    db.settings.llmProvider = 'openai-compatible';
    db.settings.apiKey = 'fixture-key';
    db.settings.apiBaseUrl = `http://127.0.0.1:${port}/v1`;
    db.settings.model = 'fixture-model';
    db.settings.enableAutoModel = false;
    db.settings.agentRuntimeMode = 'model_first';
    db.settings.thinkingNoticeMode = 'off';
    db.settings.memoryEnabled = false;
    db.settings.enableWebSearch = false;
    db.settings.botRegistry = {
      updatedAt: new Date().toISOString(),
      bots: [{ id: 'yumu', name: '雨沐', description: 'fixture', qq: '', channel: 'internal', enabled: true, commands: [] }],
    };
    db.osuBindings = { ...(db.osuBindings || {}), '10001': 1234567 };
    db.skillStore = {
      updatedAt: new Date().toISOString(),
      records: [{
        userId: '10001', osuUsername: 'AgentFixture', osuUserId: 1234567,
        mode: 'osu', pp: 8000, rank: 13000, accuracy: 98.5, playCount: 2000,
        hoursPlayed: 100, level: 100, summary: '技能画像偏综合', lastAnalyzed: new Date().toISOString(), version: 1,
      }],
    };
  });

  const sends = [];
  const result = await processIncoming({
    source: 'gui', type: 'private', messageId: 'agent-v2-process', groupId: 'private',
    userId: '10001', nickname: 'Owner', text: '结合我的实时资料和技能画像评价一下我',
    atTargets: [], images: [], raw: {},
  }, async (_event, text) => { sends.push(String(text || '')); });

  if (!result.replied) throw new Error(`processIncoming did not reply: ${JSON.stringify(result)}`);
  if (llmCalls !== 3) throw new Error(`expected three model decisions, got ${llmCalls}`);
  for (const inventory of requestToolInventories) {
    if (!inventory.includes('osu_get_player_profile') || !inventory.includes('get_player_skill')) {
      throw new Error(`V2 precise tools missing from model inventory: ${JSON.stringify(inventory)}`);
    }
    if (inventory.includes('query_osu')) throw new Error('hidden query_osu mega-tool leaked to the model');
  }
  if (!sends.join('\n').includes('实时资料和技能快照')) {
    throw new Error(`final synthesis not delivered: ${JSON.stringify(sends)}`);
  }
  if (observedToolEnvelopes.length !== 2) {
    throw new Error(`expected two structured evidence envelopes, got ${observedToolEnvelopes.length}`);
  }
  const [profileEnvelope, skillEnvelope] = observedToolEnvelopes;
  if (
    profileEnvelope.schemaVersion !== 1 ||
    profileEnvelope.status !== 'success' ||
    profileEnvelope.tool?.name !== 'osu_get_player_profile' ||
    profileEnvelope.tool?.capability !== 'profile' ||
    !String(profileEnvelope.evidence?.text || '').includes('AgentFixture')
  ) {
    throw new Error(`invalid profile evidence envelope: ${JSON.stringify(profileEnvelope)}`);
  }
  if (
    skillEnvelope.schemaVersion !== 1 ||
    skillEnvelope.status !== 'success' ||
    skillEnvelope.tool?.name !== 'get_player_skill' ||
    skillEnvelope.tool?.capability !== null ||
    !String(skillEnvelope.evidence?.text || '').includes('技能画像偏综合')
  ) {
    throw new Error(`invalid skill evidence envelope: ${JSON.stringify(skillEnvelope)}`);
  }

  const db = readDb();
  const profileAudits = (db.toolCallLogs || []).filter((entry) => entry.capability === 'profile');
  if (profileAudits.length !== 1 || profileAudits[0].ok !== true) {
    throw new Error(`V2 call did not pass through canonical query_osu audit: ${JSON.stringify(profileAudits)}`);
  }

  const requestTrace = listRequestTraces(10).find((trace) => trace.messageId === 'agent-v2-process');
  if (!requestTrace) throw new Error('V2 request trace was not retained');
  const plannerEvents = requestTrace.events.filter((event) => event.name === 'agent_planner_decision');
  const evidenceEvents = requestTrace.events.filter((event) => event.name === 'tool_evidence_returned_to_model');
  if (plannerEvents.map((event) => event.data?.decision).join(',') !== 'call_tools,call_tools,finish') {
    throw new Error(`planner decision trace is incomplete: ${JSON.stringify(plannerEvents)}`);
  }
  if (evidenceEvents.map((event) => event.data?.toolName).join(',') !== 'osu_get_player_profile,get_player_skill') {
    throw new Error(`evidence-return trace is incomplete: ${JSON.stringify(evidenceEvents)}`);
  }
  const eventNames = requestTrace.events.map((event) => event.name);
  for (const evidenceEvent of evidenceEvents) {
    const evidenceIndex = eventNames.indexOf(evidenceEvent.name, evidenceEvent.seq - 1);
    const precedingCompletion = requestTrace.events
      .slice(0, evidenceIndex)
      .findLast((event) => event.name === 'tool_call_completed' && event.data?.toolCallId === evidenceEvent.data?.toolCallId);
    if (!precedingCompletion) {
      throw new Error(`evidence trace appeared before executor completion: ${JSON.stringify(evidenceEvent)}`);
    }
  }

  console.log('PASS: processIncoming defaults to model-first V2 and exposes the complete two-tool decision trace');
} finally {
  await new Promise((resolve) => server.close(resolve));
  if (!verifyProductionDbUnchanged(productionBefore)) {
    console.error('FAIL: production DB changed during isolated Agent Runtime V2 process test');
    process.exitCode = 1;
  }
  cleanupTestDir(testDataDir);
}
