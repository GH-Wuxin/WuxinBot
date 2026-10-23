// Entirely synthetic development data; no account IDs or captured conversations.
// Loaded only by the development-only ?trace=fixture preview.
export function createDemoTraces(live = false) {
  const start = Date.now() - 6000;
  const at = (offset) => new Date(start + offset).toISOString();
  const event = (id, phase, name, offset, data, durationMs) => ({
    id: `demo-event-${id}`, phase, name, at: at(offset),
    status: 'ok', data, ...(durationMs === undefined ? {} : { durationMs }),
  });
  const events = [
    event(1, 'INGRESS', 'message_received', 0, { groupId: 'demo-group' }, 3),
    event(2, 'GATE', 'reply_gate_decided', 120, { decision: 'reply', reason: '示例请求', score: 72 }, 8),
    event(3, 'PROMPT', 'prompt_snapshot_created', 260, { promptCallId: 'demo-prompt', moduleId: 'chat', evidenceLength: 120, imageCount: 0 }, 42),
    event(4, 'MODEL', 'model_call_started', 310, { purpose: 'chat', provider: 'demo', model: 'demo-model', attempt: 1 }),
    event(5, 'MODEL', 'model_call_streaming', 900, {
      purpose: 'chat', provider: 'demo', model: 'demo-model', attempt: 1, streaming: true,
      response: { reasoningExposed: false, content: '正在整理示例结果。', toolCallsPending: 0 },
    }),
    event(6, 'TOOL', 'tool_call_started', 1020, { toolName: 'demo_lookup' }),
    event(7, 'TOOL', 'tool_call_completed', 2310, { toolName: 'demo_lookup', result: '示例结果' }, 1290),
    event(8, 'MODEL', 'model_call_completed', 4400, {
      purpose: 'chat', provider: 'demo', model: 'demo-model', attempt: 1,
      response: { content: '示例查询已完成。', usage: { promptTokens: 120, cachedTokens: 80, completionTokens: 20, totalTokens: 140 } },
    }, 4090),
    event(9, 'REWRITE', 'reply_rewrite_completed', 4900, { reason: '示例文本整理' }, 380),
    event(10, 'SEND', 'reply_sent', 5400, { count: 1 }, 120),
  ];
  const shownEvents = live ? events.slice(0, 6) : events;
  const trace = {
    id: 'demo-trace', nickname: '示例用户', userId: 'demo-user', groupId: 'demo-group',
    startedAt: at(0), ...(live ? {} : { finishedAt: at(5400) }),
    status: live ? 'active' : 'completed', eventCount: shownEvents.length, events: shownEvents,
  };
  if (live) return [trace];
  return [trace, {
    ...trace, id: 'demo-bot-trace', nickname: '示例机器人', userId: 'demo-bot',
    finishedAt: at(120), events: events.slice(0, 2), eventCount: 2,
  }];
}
