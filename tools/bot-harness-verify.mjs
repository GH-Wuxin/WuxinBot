import {
  executeToolCall,
  formatInternalInfoText,
  formatInternalProfileText,
  formatInternalScoreLine,
  registerPendingBotCall,
  resolveInternalPlayerTarget,
  runToolLoop,
  tryResolveBotResponse,
} from '../server/bots/executor.ts';
import { validateOperation } from '../server/bots/guard.ts';
import { enrichScoreStarRatings } from '../server/osu/starRating.ts';
import {
  DEFAULT_BOTS,
  availableCommands,
  buildBotToolSchemas,
  findCommand,
} from '../server/bots/registry.ts';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function toolCall(id, name, args) {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

const safeByName = validateOperation({
  type: 'query_bot',
  params: { bot: 'yumu', command: 'recent', username: '[TST]Alpha' },
});
assert(safeByName.ok, 'query_bot command key/name must not trip the system-command guard');
assert(validateOperation({
  type: 'query_bot',
  params: { bot: 'yumu', command: 'profile', username: '[TST]Alpha' },
}).ok, 'the legitimate profile command must not be mistaken for a file-system operation');
assert(!validateOperation({
  type: 'query_bot',
  params: { bot: 'yumu', command: 'read_file', username: '[TST]Alpha' },
}).ok, 'file-system operation tokens separated by underscores must remain blocked');

const safeByTrigger = validateOperation({
  type: 'query_bot',
  params: { bot: 'kanon', command: '!get recommend', username: 'Commander' },
});
assert(safeByTrigger.ok, 'literal registry triggers and data-like usernames must pass lexical validation');

assert(!validateOperation({
  type: 'query_bot',
  params: { bot: 'yumu', command: 'recent', username: 'x', extra: 'read file' },
}).ok, 'query_bot must reject parameters outside its exact schema');
assert(!validateOperation({
  type: 'query_bot',
  params: { bot: 'yumu', command: 'recent; rm', username: 'x' },
}).ok, 'query_bot must reject shell-like command syntax');
assert(!validateOperation({
  type: 'query_bot',
  params: { bot: 'yumu', command: 'recent', username: '[CQ:image,file=x]' },
}).ok, 'query_bot must reject CQ injection in usernames');

const yumu = DEFAULT_BOTS.find((bot) => bot.id === 'yumu');
const kanon = DEFAULT_BOTS.find((bot) => bot.id === 'kanon');
const lazybot = DEFAULT_BOTS.find((bot) => bot.id === 'lazybot');
assert(yumu && kanon && lazybot, 'default bot fixtures must exist');
assert(findCommand(yumu, 'recent')?.trigger === '/r', 'registry command name must resolve');
assert(findCommand(yumu, '/r')?.name === 'recent', 'registry literal trigger must resolve');
assert(!findCommand(yumu, 'map'), 'unimplemented internal commands must not resolve');
assert(!findCommand(kanon, '!search'), 'unimplemented native commands must stay hidden in internal mode');
assert(!findCommand(lazybot, 'nochoke'), 'internal nochoke must not be advertised before implementation');
assert(availableCommands(yumu).every((command) => command.name !== 'map'), 'available command list must be implementation-aware');

const schemas = buildBotToolSchemas({
  bots: DEFAULT_BOTS,
  updatedAt: new Date(0).toISOString(),
});
const querySchema = schemas.find((tool) => tool.function.name === 'query_osu');
assert(querySchema, 'query_osu schema must be built');
assert(!querySchema.function.description.includes('nochoke'), 'tool schema must not advertise internal nochoke');
assert(!querySchema.function.description.includes('谱面搜索'), 'tool schema must not advertise internal map search');

const unsupported = await executeToolCall(
  toolCall('unsupported', 'query_bot', { bot: 'yumu', command: 'map', username: 'test' }),
  { db: { settings: {} }, userId: '10001' },
);
assert(!unsupported.ok, 'an unimplemented internal command must return a failed ToolResult');
assert(!unsupported.content.includes('已通过'), 'an unimplemented internal command must never be wrapped as success');
const ordinaryToolAnswer = await executeToolCall(
  toolCall('ordinary-list-bots', 'list_bots', {}),
  { db: { settings: {} }, userId: '10001' },
);
assert(ordinaryToolAnswer.ok, 'ordinary informational tools must still execute');
assert(!ordinaryToolAnswer.directContent, 'ordinary tool Q&A must remain available for LLM summarization');

const bindingTarget = resolveInternalPlayerTarget(
  { osuBindings: { 'REDACTED_QQ_001': 1234567 } },
  'REDACTED_QQ_001',
  '',
);
assert(bindingTarget?.kind === 'id' && bindingTarget.value === 1234567, 'numeric osuBindings value must resolve as osu! user ID');
const stringBindingTarget = resolveInternalPlayerTarget(
  { osuBindings: { 'REDACTED_QQ_001': '1234567' } },
  'REDACTED_QQ_001',
  '',
);
assert(stringBindingTarget?.kind === 'id' && stringBindingTarget.value === 1234567, 'serialized numeric binding must resolve as osu! user ID');
const explicitTarget = resolveInternalPlayerTarget(
  { osuBindings: { 'REDACTED_QQ_001': 1234567 } },
  'REDACTED_QQ_001',
  '[TST]Alpha',
);
assert(explicitTarget?.kind === 'username' && explicitTarget.value === '[TST]Alpha', 'explicit username must override binding');

const userFixture = {
  id: 2,
  username: '[TST]Alpha',
  country_code: 'CN',
  country: { name: 'China' },
  avatar_url: '',
  is_online: false,
  join_date: '2020-11-08T00:00:00Z',
  follower_count: 0,
  support_level: 0,
  grade_counts: { ssh: 45, ss: 8, sh: 438, s: 26, a: 1288 },
  statistics: {
    level: { current: 101, progress: 48 },
    global_rank: 6217,
    country_rank: 87,
    pp: 10285.6,
    ranked_score: 0,
    total_score: 0,
    total_hits: 0,
    hit_accuracy: 98.8,
    play_count: 60895,
    play_time: 39 * 86400 + 7 * 3600,
    maximum_combo: 0,
    replays_watched_by_others: 0,
    is_ranked: true,
    // Deliberately conflicting nested values: the complete top-level API
    // grade_counts object must be used for every displayed grade.
    grade_counts: { ssh: 1, ss: 2, sh: 3, s: 4, a: 5 },
  },
};
const profileText = formatInternalProfileText(userFixture);
assert(profileText.includes('游戏时间: 943 小时'), 'profile output must convert API statistics.play_time seconds to hours');
assert(profileText.includes('SSH 45，SS 8，SH 438，S 26，A 1288'), 'profile output must label every official grade count correctly');
const infoText = formatInternalInfoText(userFixture);
assert(infoText.includes('游戏时间: 943 小时'), 'info text fallback must use API statistics.play_time too');

const scoreFixture = {
  id: 1,
  accuracy: 0.9815,
  max_combo: 765,
  mods: ['HD', 'DT'],
  pp: 539.2,
  rank: 'S',
  score: 123,
  statistics: {},
  beatmap: {
    id: 1002,
    difficulty_rating: 4.90,
    version: 'Another',
    max_combo: 1000,
  },
  beatmapset: {
    title: 'Fixture Song',
    title_unicode: '测试曲',
  },
  created_at: '2026-01-01T00:00:00Z',
  mode: 'osu',
  user_id: 2,
  weight: { pp: 500.0 },
};
let requestedAttributes = null;
const [enrichedScore] = (await enrichScoreStarRatings(
  [scoreFixture],
  'osu',
  async (beatmapId, mode, mods) => {
    requestedAttributes = { beatmapId, mode, mods };
    return { attributes: { star_rating: 7.48 } };
  },
)).scores;
assert(requestedAttributes?.beatmapId === 1002, 'attributes request must use the score beatmap ID');
assert(requestedAttributes?.mode === 'osu', 'attributes request must use the score ruleset');
assert(requestedAttributes?.mods.join(',') === 'DT,HD', 'attributes request must include the complete normalized Mod set');
assert(enrichedScore.star_rating_source === 'modded', 'Modded score must be marked as officially enriched');
const scoreLine = formatInternalScoreLine(enrichedScore, { index: 1, includeWeight: true });
assert(scoreLine.includes('测试曲 [Another]'), 'score line must read title from beatmapset');
assert(scoreLine.includes('7.48★') && !scoreLine.includes('4.90★'), 'score line must use official Mod-adjusted stars');
assert(scoreLine.includes('98.15%') && !scoreLine.includes('0.98%'), 'score accuracy must be converted from API ratio to percent');
assert(scoreLine.includes('HDDT'), 'display must preserve the score Mod order');

const [failedStarScore] = (await enrichScoreStarRatings(
  [scoreFixture],
  'osu',
  async () => { throw new Error('fixture failure'); },
)).scores;
const failedStarLine = formatInternalScoreLine(failedStarScore);
assert(failedStarScore.star_rating_source === 'unavailable', 'failed attributes lookup must be marked unavailable');
assert(failedStarLine.includes('星数暂不可用'), 'failed attributes lookup must not fall back to base stars');

const qqBot = {
  id: 'fixturebot',
  name: 'Fixture Bot',
  description: 'fixture',
  qq: 'REDACTED_QQ_002',
  channel: 'qq_private',
  enabled: true,
  commands: [{
    name: 'recent',
    trigger: '/r',
    description: 'fixture recent',
    params: [],
    returns: 'both',
  }],
};
const qqDb = {
  settings: {
    botRegistry: { bots: [qqBot], updatedAt: new Date(0).toISOString() },
  },
};
const completionCalls = [];
const loopResult = await runToolLoop(
  async (_db, options) => {
    completionCalls.push(options);
    if (options.tools?.length) {
      return {
        text: '',
        usage: { total_tokens: 1, prompt_tokens: 1, completion_tokens: 0 },
        raw: {
          choices: [{
            message: {
              content: '',
              tool_calls: [toolCall('qq-image', 'query_bot', {
                bot: 'fixturebot',
                command: '/r',
                username: 'fixture',
              })],
            },
          }],
        },
      };
    }
    return {
      text: 'final answer',
      usage: { total_tokens: 1, prompt_tokens: 0, completion_tokens: 1 },
      raw: { choices: [{ message: { content: 'final answer' } }] },
    };
  },
  {
    db: qqDb,
    messages: [{ role: 'user', content: 'show score' }],
    tools: buildBotToolSchemas(qqDb.settings.botRegistry),
    userId: 'REDACTED_QQ_001',
    event: { type: 'private', userId: 'REDACTED_QQ_001', text: 'show score' },
    sendMessage: async () => {
      const resolved = tryResolveBotResponse(qqDb, {
        type: 'private',
        userId: qqBot.qq,
        text: 'rendered',
        images: [{ url: 'https://example.invalid/score.jpg' }],
        messageId: 'reply-1',
      });
      assert(resolved, 'private QQ bot response must resolve its pending route');
    },
    maxIterations: 1,
  },
);
assert(loopResult.text === 'final answer', 'tool loop must make a final completion after the cap');
assert(loopResult.images.length === 1 && loopResult.images[0].endsWith('/score.jpg'), 'tool images must be returned structurally');
assert(completionCalls.length === 2, 'max-iteration flow must perform one tool turn and one final turn');
assert(!completionCalls[1].tools?.length, 'final completion after the cap must have tools disabled');
assert(!JSON.stringify(completionCalls[1].messages).includes('example.invalid'), 'image paths/URLs must not be exposed to the LLM');

const completeBpList = [
  '[TST]Alpha 的前 10 个最佳成绩：',
  ...Array.from({ length: 10 }, (_, index) =>
    `  #${index + 1} ${index === 1 ? 'Sidetracked Day' : `Fixture Song ${index + 1}`} | 7.${String(index).padStart(2, '0')}★ | HD | 99.00% | ${560 - index}.0pp`
  ),
].join('\n');
const listBot = {
  ...qqBot,
  id: 'fixture-list-bot',
  commands: [{
    name: 'bp',
    trigger: '/bp',
    description: 'fixture complete BP list',
    params: [],
    returns: 'text',
  }],
  responsePolicy: { textSettleMs: 10, progressSettleMs: 20, imageDrainMs: 15, textDrainMs: 15, timeoutDrainMs: 15 },
};
const listDb = {
  settings: {
    botRegistry: { bots: [listBot], updatedAt: new Date(0).toISOString() },
  },
};
const listCompletionCalls = [];
const directListResult = await runToolLoop(
  async (_db, options) => {
    listCompletionCalls.push(options);
    const hasToolResult = options.messages.some((message) => message.role === 'tool');
    if (!hasToolResult) {
      return {
        text: '',
        usage: { total_tokens: 1, prompt_tokens: 1, completion_tokens: 0 },
        raw: {
          choices: [{
            message: {
              content: '',
              tool_calls: [toolCall('qq-bp-list', 'query_bot', {
                bot: listBot.id,
                command: 'bp',
                username: '[TST]Alpha',
              })],
            },
          }],
        },
      };
    }
    return {
      // Reproduce the real regression: the final LLM only emitted the start of
      // the second entry even though the tool had returned all ten.
      text: '#2 Sid...',
      usage: { total_tokens: 1, prompt_tokens: 0, completion_tokens: 1 },
      // A non-conforming provider may emit another tool call even though tools
      // were omitted for the cosmetic lead turn. It must never run.
      raw: {
        choices: [{
          message: {
            content: '#2 Sid...',
            tool_calls: [toolCall('ignored-repeat-query', 'query_bot', {
              bot: listBot.id,
              command: 'bp',
              username: '[TST]Alpha',
            })],
          },
        }],
      },
    };
  },
  {
    db: listDb,
    messages: [{ role: 'user', content: '看看我的 BP' }],
    tools: buildBotToolSchemas(listDb.settings.botRegistry),
    userId: 'REDACTED_QQ_001',
    event: { type: 'private', userId: 'REDACTED_QQ_001', text: '看看我的 BP' },
    sendMessage: async () => {
      const resolved = tryResolveBotResponse(listDb, {
        type: 'private',
        userId: listBot.qq,
        text: completeBpList,
        images: [],
        messageId: 'bp-list-reply',
      });
      assert(resolved, 'text BP response must resolve its pending route');
    },
    maxIterations: 2,
  },
);
assert(directListResult.text === '#2 Sid...', 'fixture must preserve the intentionally truncated LLM lead');
assert(listCompletionCalls.length === 2, 'a direct result must stop after one cosmetic lead turn');
assert(directListResult.directContent === completeBpList, 'complete BP list must be returned as deterministic direct content');
assert(directListResult.directContent.includes('#10 Fixture Song 10'), 'direct BP delivery must retain the final row');
assert(
  listCompletionCalls[1].messages.some((message) =>
    message.role === 'tool' && String(message.content).includes('系统会在你的回复后原样附上完整结果')
  ),
  'LLM must be told to write only a short lead for direct content'
);
assert(!listCompletionCalls[1].tools?.length, 'the cosmetic lead turn after direct delivery must not expose tools again');
await new Promise((resolve) => setTimeout(resolve, 30));

let failedLeadCalls = 0;
const directResultAfterLeadFailure = await runToolLoop(
  async () => {
    failedLeadCalls += 1;
    if (failedLeadCalls > 1) throw new Error('fixture lead timeout');
    return {
      text: '',
      usage: { total_tokens: 1, prompt_tokens: 1, completion_tokens: 0 },
      raw: {
        choices: [{
          message: {
            content: '',
            tool_calls: [toolCall('qq-bp-list-lead-failure', 'query_bot', {
              bot: listBot.id,
              command: 'bp',
              username: '[TST]Alpha',
            })],
          },
        }],
      },
    };
  },
  {
    db: listDb,
    messages: [{ role: 'user', content: '看看我的 BP' }],
    tools: buildBotToolSchemas(listDb.settings.botRegistry),
    userId: 'REDACTED_QQ_001',
    event: { type: 'private', userId: 'REDACTED_QQ_001', text: '看看我的 BP' },
    sendMessage: async () => {
      const resolved = tryResolveBotResponse(listDb, {
        type: 'private',
        userId: listBot.qq,
        text: completeBpList,
        images: [],
        messageId: 'bp-list-lead-failure-reply',
      });
      assert(resolved, 'direct result must resolve before the lead failure');
    },
    maxIterations: 2,
  },
);
assert(failedLeadCalls === 2, 'fixture must exercise a failed follow-up lead call');
assert(directResultAfterLeadFailure.text === '', 'failed cosmetic lead must fall back to deterministic caller text');
assert(
  directResultAfterLeadFailure.directContent === completeBpList,
  'a follow-up LLM failure must not discard a complete direct result'
);

const groupBot = {
  ...qqBot,
  id: 'groupbot',
  channel: 'qq_group',
};
const groupDb = {
  settings: {
    botRegistry: { bots: [groupBot], updatedAt: new Date(0).toISOString() },
  },
};
const SHORT_DRAIN_POLICY = { imageMs: 15, textMs: 15, timeoutMs: 15 };
const groupOnePromise = registerPendingBotCall({
  correlationId: 'not-prefixed-a',
  botId: groupBot.id,
  channel: 'qq_group',
  groupId: '100',
  drainPolicy: SHORT_DRAIN_POLICY,
}, 2_000);
const groupTwoPromise = registerPendingBotCall({
  correlationId: 'not-prefixed-b',
  botId: groupBot.id,
  channel: 'qq_group',
  groupId: '200',
  drainPolicy: SHORT_DRAIN_POLICY,
}, 2_000);
assert(tryResolveBotResponse(groupDb, {
  type: 'group',
  groupId: '200',
  userId: groupBot.qq,
  text: 'group two',
  images: [],
}), 'group response must match the pending bot/channel/group route');
assert(tryResolveBotResponse(groupDb, {
  type: 'group',
  groupId: '100',
  userId: groupBot.qq,
  text: 'group one',
  images: [],
}), 'another group route must remain pending independently');
const [groupOne, groupTwo] = await Promise.all([groupOnePromise, groupTwoPromise]);
assert(groupOne.text === 'group one' && groupTwo.text === 'group two', 'concurrent group routes must not cross-resolve');

const stagedBot = {
  ...qqBot,
  id: 'stagedbot',
  channel: 'qq_group',
  groupId: '300',
  responsePolicy: {
    textSettleMs: 20,
    progressSettleMs: 80,
    imageDrainMs: 15,
    textDrainMs: 15,
    timeoutDrainMs: 15,
  },
};
const stagedDb = {
  settings: {
    botRegistry: { bots: [stagedBot], updatedAt: new Date(0).toISOString() },
  },
};
const stagedPromise = registerPendingBotCall({
  correlationId: 'staged-progress-image',
  botId: stagedBot.id,
  channel: 'qq_group',
  groupId: '300',
  drainPolicy: SHORT_DRAIN_POLICY,
}, 1_000);
let stagedSettled = false;
void stagedPromise.then(() => { stagedSettled = true; });
assert(tryResolveBotResponse(stagedDb, {
  type: 'group',
  groupId: '300',
  userId: stagedBot.qq,
  text: '正在查询，请稍候',
  images: [],
  messageId: 'progress-1',
}), 'a progress event from the expected bot route must be consumed');
await new Promise((resolve) => setTimeout(resolve, 25));
assert(!stagedSettled, 'a recognized progress message must not complete the pending request immediately');
assert(tryResolveBotResponse(stagedDb, {
  type: 'group',
  groupId: '300',
  userId: stagedBot.qq,
  text: '',
  images: [{ url: 'https://example.invalid/final-panel.png' }],
  messageId: 'final-1',
}), 'the final image after a progress message must still resolve the pending request');
const stagedResult = await stagedPromise;
assert(stagedResult.images[0]?.endsWith('/final-panel.png'), 'the final image must survive a staged bot response');
await new Promise((resolve) => setTimeout(resolve, 30));
assert(!stagedResult.text.includes('正在查询'), 'progress chatter must not leak into an image result');

const pureTextPromise = registerPendingBotCall({
  correlationId: 'pure-text-result',
  botId: stagedBot.id,
  channel: 'qq_group',
  groupId: '300',
  drainPolicy: SHORT_DRAIN_POLICY,
}, 1_000);
assert(tryResolveBotResponse(stagedDb, {
  type: 'group',
  groupId: '300',
  userId: stagedBot.qq,
  text: '查询失败：该玩家不存在',
  images: [],
  messageId: 'text-final-1',
}), 'a pure-text terminal response must be consumed');
const pureTextResult = await pureTextPromise;
await new Promise((resolve) => setTimeout(resolve, 30));
assert(pureTextResult.ok && pureTextResult.text === '查询失败：该玩家不存在', 'a pure-text result must complete after the configurable quiet window');

const busyBot = {
  ...qqBot,
  id: 'busybot',
  channel: 'qq_group',
  groupId: '400',
};
const busyDb = {
  settings: {
    botRegistry: { bots: [busyBot], updatedAt: new Date(0).toISOString() },
  },
};
const heldRoutePromise = registerPendingBotCall({
  correlationId: 'held-route',
  botId: busyBot.id,
  channel: 'qq_group',
  groupId: '400',
  drainPolicy: SHORT_DRAIN_POLICY,
}, 1_000);
let busyRouteSends = 0;
const busyRouteResult = await executeToolCall(
  toolCall('busy-route-call', 'query_bot', {
    bot: busyBot.id,
    command: 'recent',
    username: '[TST]Alpha',
  }),
  {
    db: busyDb,
    userId: 'REDACTED_QQ_001',
    groupId: '400',
    event: { type: 'group', groupId: '400', userId: 'REDACTED_QQ_001', text: 'query' },
    sendMessage: async () => { busyRouteSends += 1; },
  },
);
assert(!busyRouteResult.ok && busyRouteResult.error?.includes('bot_route_busy'), 'a second request on the same uncorrelated bot route must be rejected');
assert(busyRouteSends === 0, 'a busy-route rejection must happen before another QQ command is sent');
assert(tryResolveBotResponse(busyDb, {
  type: 'group',
  groupId: '400',
  userId: busyBot.qq,
  text: 'held request result',
  images: [{ url: 'https://example.invalid/held.png' }],
  messageId: 'held-final',
}), 'the original request on a busy route must remain resolvable');
await heldRoutePromise;

const progressOnlyPromise = registerPendingBotCall({
  correlationId: 'progress-only-result',
  botId: stagedBot.id,
  channel: 'qq_group',
  groupId: '300',
  drainPolicy: SHORT_DRAIN_POLICY,
}, 1_000);
assert(tryResolveBotResponse(stagedDb, {
  type: 'group',
  groupId: '300',
  userId: stagedBot.qq,
  text: '正在查询，请稍候',
  images: [],
  messageId: 'progress-only-1',
}), 'a progress-only response must be consumed');
const progressOnlyResult = await progressOnlyPromise;
assert(progressOnlyResult.ok && progressOnlyResult.text.includes('正在查询'), 'a progress-only bot must still terminate at its configured grace period');

console.log('PASS bot harness: guard, registry, bindings, official score metrics, tool cap, images and QQ routing');
