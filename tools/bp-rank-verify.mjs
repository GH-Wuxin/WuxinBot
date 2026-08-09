import {
  buildBpListRenderOptions,
  executeToolCall,
  parseEmbeddedBpCommand,
  parseBpSelectionFromUserText,
  resolveBpQuerySelection,
  selectBpScores,
  tryResolveBotResponse,
} from '../server/bots/executor.ts';
import { validateOperation } from '../server/bots/guard.ts';
import { DEFAULT_BOTS, buildBotToolSchemas, findCommand } from '../server/bots/registry.ts';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function toolCall(id, args) {
  return {
    id,
    type: 'function',
    function: { name: 'query_bot', arguments: JSON.stringify(args) },
  };
}

for (const bpRank of [1, 10, 100, '10']) {
  assert(validateOperation({
    type: 'query_bot',
    params: { bot: 'yumu', command: 'bp', bp_rank: bpRank },
  }).ok, `valid BP rank ${bpRank} must pass`);
}

for (const bpRank of [0, 101, 1.5, '1.5', true]) {
  assert(!validateOperation({
    type: 'query_bot',
    params: { bot: 'yumu', command: 'bp', bp_rank: bpRank },
  }).ok, `invalid BP rank ${String(bpRank)} must be rejected`);
}

assert(validateOperation({
  type: 'query_bot',
  params: { bot: 'yumu', command: 'bp', bp_start: 11, bp_end: 20 },
}).ok, 'a complete ascending BP range must pass');
assert(!validateOperation({
  type: 'query_bot',
  params: { bot: 'yumu', command: 'bp', bp_start: 10 },
}).ok, 'a half-specified BP range must be rejected');
assert(!validateOperation({
  type: 'query_bot',
  params: { bot: 'yumu', command: 'bp', bp_start: 20, bp_end: 10 },
}).ok, 'a descending BP range must be rejected');
assert(!validateOperation({
  type: 'query_bot',
  params: { bot: 'yumu', command: 'bp', bp_rank: 10, bp_start: 1, bp_end: 10 },
}).ok, 'single-rank and range selectors must not be mixed');
assert(validateOperation({
  type: 'query_bot',
  params: { bot: 'yumu', command: 'bp', bp_start: 1, bp_end: 21 },
}).ok, 'a range wider than 20 must pass (up to 100)');
assert(validateOperation({
  type: 'query_bot',
  params: { bot: 'yumu', command: 'bp', bp_start: 1, bp_end: 100 },
}).ok, 'a BP1-100 range must pass');
assert(!validateOperation({
  type: 'query_bot',
  params: { bot: 'yumu', command: 'bp', bp_start: 1, bp_end: 101 },
}).ok, 'a BP range wider than 100 must be rejected');
assert(validateOperation({
  type: 'query_bot',
  params: { bot: 'yumu', command: 'bp', bp_rank: 100 },
}).ok, 'single BP100 must remain available');

const querySchema = buildBotToolSchemas({
  bots: DEFAULT_BOTS,
  updatedAt: new Date(0).toISOString(),
}).find((tool) => tool.function.name === 'query_osu');
const queryProperties = querySchema?.function.parameters.properties || {};
assert(queryProperties.capability, 'query_osu schema must expose capability');
assert(queryProperties.bp_rank, 'query_osu schema must expose bp_rank');
assert(queryProperties.bp_start && queryProperties.bp_end, 'query_osu schema must expose BP range endpoints');
assert(
  String(queryProperties.bp_rank?.description || '').includes('单张'),
  'bp_rank schema must describe single-rank semantics',
);
assert(
  String(queryProperties.bp_start?.description || '').includes('范围') &&
    String(queryProperties.bp_end?.description || '').includes('范围'),
  'bp_start/bp_end schema must describe range semantics',
);

for (const botId of ['yumu', 'kanon', 'lazybot']) {
  const bot = DEFAULT_BOTS.find((entry) => entry.id === botId);
  const command = bot && findCommand(bot, 'bp');
  assert(command, `${botId}/bp must exist`);
  assert(command.params.some((param) => param.name === 'bp_rank'), `${botId}/bp must advertise bp_rank`);
}

const defaultSelection = resolveBpQuerySelection({});
assert(
  defaultSelection.startRank === 1 &&
  defaultSelection.endRank === 10 &&
  !defaultSelection.explicit,
  'plain BP must remain the BP1-10 list',
);
const bp10Selection = resolveBpQuerySelection({ bp_rank: 10 });
assert(
  bp10Selection.startRank === 10 &&
  bp10Selection.endRank === 10 &&
  bp10Selection.single,
  'bp_rank=10 must resolve to only BP10',
);
const rangeSelection = resolveBpQuerySelection({ bp_start: 11, bp_end: 13 });
assert(
  rangeSelection.startRank === 11 &&
  rangeSelection.endRank === 13 &&
  !rangeSelection.single,
  'range parameters must retain their exact inclusive ranks',
);

const embeddedSingle = parseEmbeddedBpCommand('/bp10');
assert(
  embeddedSingle.command === '/bp' &&
  embeddedSingle.selection?.startRank === 10 &&
  embeddedSingle.selection?.single,
  'legacy/model-generated /bp10 must normalize to /bp plus rank 10',
);
const embeddedRange = parseEmbeddedBpCommand('bplist 11-13');
assert(
  embeddedRange.command === 'bplist' &&
  embeddedRange.selection?.startRank === 11 &&
  embeddedRange.selection?.endRank === 13,
  'an embedded bplist range must normalize deterministically',
);
assert(parseEmbeddedBpCommand('bp101').error, 'embedded rank 101 must be rejected');
assert(
  parseEmbeddedBpCommand('bp1-21').selection?.endRank === 21,
  'embedded ranges wider than 20 must be accepted (up to 100)',
);
assert(
  parseEmbeddedBpCommand('bs 1-100').selection?.endRank === 100,
  'embedded !bs ranges must be accepted',
);
assert(parseEmbeddedBpCommand('bp1-101').error, 'embedded ranges wider than 100 must be rejected');
assert(
  parseBpSelectionFromUserText('看看我BP1').selection?.startRank === 1,
  'event fallback must recognize BP1 without requiring a space',
);
assert(
  parseBpSelectionFromUserText('展示 BP 10-12').selection?.endRank === 12,
  'event fallback must recognize an explicit BP range',
);
assert(
  parseBpSelectionFromUserText('展示 BP1-21').selection?.endRank === 21,
  'event fallback must accept ranges wider than 20 (up to 100)',
);
assert(
  parseBpSelectionFromUserText('展示 BP1-101').error,
  'event fallback must enforce the 100-score range cap',
);

const fixtureScores = Array.from({ length: 20 }, (_, index) => `score-${index + 1}`);
const selected = selectBpScores(fixtureScores, rangeSelection);
assert(
  selected.map((entry) => `${entry.rank}:${entry.score}`).join(',') ===
    '11:score-11,12:score-12,13:score-13',
  'BP slicing must preserve absolute rank labels and exclude unrelated scores',
);
const officialQqRenderOptions = buildBpListRenderOptions(
  Array.from({ length: 10 }, (_, index) => index + 1),
);
assert(
  officialQqRenderOptions.compact === false &&
  officialQqRenderOptions.startRank === 1 &&
  officialQqRenderOptions.ranks.length === 10,
  'BP10 must use yumu official QQ double-column layout, not Tencent compact mode',
);
const officialBsRenderOptions = buildBpListRenderOptions(
  Array.from({ length: 100 }, (_, index) => index + 1),
  true,
);
assert(
  officialBsRenderOptions.compact === true,
  '!bs 1-100 must request the compact five-column layout',
);
assert(
  parseEmbeddedBpCommand('bs 1-100').selection?.compact === true,
  'embedded bs ranges must carry the official compact style',
);
assert(
  parseEmbeddedBpCommand('bp1-100').selection?.compact !== true,
  'ordinary bp ranges stay in the QQ double-column layout',
);

const qqBot = {
  id: 'bp-fixture',
  name: 'BP Fixture',
  description: 'offline fixture',
  qq: '3000000001',
  channel: 'qq_private',
  enabled: true,
  commands: [{
    name: 'bp',
    trigger: '/bp',
    description: 'fixture BP',
    params: [],
    returns: 'text',
  }],
  // The fixture settles responses synchronously, so the post-call drain
  // quarantine (added by 38a7117 for late-response absorption) must not block
  // the back-to-back BP routing cases in this file.
  responsePolicy: { textSettleMs: 0, progressSettleMs: 0, textDrainMs: 0, imageDrainMs: 0, timeoutDrainMs: 0 },
};
const qqDb = {
  settings: {
    botRegistry: { bots: [qqBot], updatedAt: new Date(0).toISOString() },
  },
};
let sentCommand = '';
const result = await executeToolCall(
  toolCall('bp10-offline', {
    bot: qqBot.id,
    command: 'bp',
    username: '[TST]Alpha',
    bp_rank: 10,
  }),
  {
    db: qqDb,
    userId: '1000000001',
    // Explicit tool parameters have priority even if the model-facing event
    // text contains a different rank.
    event: { type: 'private', userId: '1000000001', text: '看看我 BP1' },
    sendMessage: async (_event, text) => {
      sentCommand = String(text);
      assert(tryResolveBotResponse(qqDb, {
        type: 'private',
        userId: qqBot.qq,
        text: '#10 Fixture BP',
        images: [],
        messageId: 'fixture-bp10',
      }), 'offline fixture response must resolve the active BP route');
    },
  },
);
assert(result.ok, 'ranked BP tool call must complete');
assert(sentCommand === '/bp [TST]Alpha #10', 'ranked BP selector must be carried in the bot command');
assert(result.metadata?.bpStart === 10 && result.metadata?.bpEnd === 10, 'BP ranks must remain in tool metadata');
assert(result.directContent === '#10 Fixture BP', 'text fallback must be delivered verbatim');

let fallbackCommand = '';
const fallbackResult = await executeToolCall(
  toolCall('bp1-event-fallback', {
    bot: qqBot.id,
    command: 'bp',
    username: '[TST]Alpha',
  }),
  {
    db: qqDb,
    userId: '1000000001',
    event: { type: 'private', userId: '1000000001', text: '看看我BP1' },
    sendMessage: async (_event, text) => {
      fallbackCommand = String(text);
      assert(tryResolveBotResponse(qqDb, {
        type: 'private',
        userId: qqBot.qq,
        text: '#1 Fixture BP',
        images: [],
        messageId: 'fixture-bp1',
      }), 'event-fallback fixture response must resolve the active BP route');
    },
  },
);
assert(fallbackResult.ok, 'event-text BP1 fallback must complete');
assert(fallbackCommand === '/bp [TST]Alpha #1', 'event-text BP1 must survive a model call that omitted bp_rank');
assert(
  fallbackResult.metadata?.bpStart === 1 && fallbackResult.metadata?.bpEnd === 1,
  'event-derived BP1 must remain in tool metadata',
);

console.log('BP rank verification passed.');
