// Failure finalization for a conversation turn. This owns the user-visible
// "generation failed" notice and the failure ledger, but not the turn's timer
// cleanup (that stays in the caller's catch/finally boundary).
import crypto from 'node:crypto';
import { nowIso, updateDb } from '../store.js';
import { recordDecisionError } from '../health.js';
import { currentRequestTraceId, traceEvent } from '../requestTrace.js';
import { sourceDetails } from '../messageProvenance.js';
import { sendOptionalNotice } from './notice.js';
import { pickCodeSticker, withSticker } from './stickers/index.js';
import { appendReplyFailure } from './replyFailures.js';
import { classifyLlmFailure } from './llmFailure.js';

export interface ConversationFailureInput {
  event: any;
  sendMessage?: any;
  decision: any;
  error: any;
  deliveryStarted: boolean;
  modelStageStarted: boolean;
}

export async function recordConversationFailure(input: ConversationFailureInput): Promise<{
  replied: false;
  error: string;
  reason: string;
}> {
  const { event, sendMessage, decision, error, deliveryStarted, modelStageStarted } = input;
  traceEvent(deliveryStarted ? 'SEND' : 'ERROR', deliveryStarted ? 'qq_delivery_failed_or_unknown' : 'reply_generation_failed', { status: 'error', error: String(error) });
  // Once QQ delivery starts, timeout may mean accepted-but-unacknowledged.
  // Do not resend the answer or a contradictory failure notice in that case.
  // Natural group participation is opportunistic. If its model turn fails,
  // do not create a second unsolicited group message just to announce the
  // failure. Direct @mentions explicitly asked for a response and may still
  // receive the existing failure notice.
  const directConversation = event.type === 'private';
  if (modelStageStarted && !deliveryStarted && sendMessage
    && (event.replyToCurrentMessage === true || directConversation)) {
    // 这是最该配图的一条：回复内容没生成出来，但「服务挂了、举白旗认输」这个意思
    // 是确定的，而 service_down 正是 gate=code 的状态图 —— 走 withSticker 不经过 LLM，
    // 所以 LLM 超时/挂掉时它照样发得出去。
    // service_down 现在是一组 8 张差分（跪地举旗 / 站立举旗 / 摊手 / 趴桌 …），
    // 由代码随机取一张。取不到时退回纯文字 —— 兜底提示本身不能因为贴纸发不出去。
    const failureNotice = '[系统] 这次查询或回复未能完成，请稍后重试。';
    const noticeSticker = pickCodeSticker('service_down');
    await sendOptionalNotice(() => sendMessage(event,
      noticeSticker ? withSticker(failureNotice, noticeSticker.id) : failureNotice,
      sourceDetails({module:'conversation',operation:'failure_notice'},
        {code:'generation_failed',description:'本轮查询或生成未能完成，向明确请求的发言者反馈失败。',audience:'requester'},event)));
  }
  // 只记「回复根本没生成出来」这一种 —— 也就是她压根没开口的那种。发图失败、
  // 权限拒绝、冷却拦截各有自己的结果记录，不进这里。分开是有意的：这样这行字
  // 只能解释她的缺席，没法拿来解释她做过的事，也就堵住了「拿它当理由」。
  if (!deliveryStarted) {
    updateDb((draft) => {
      draft.replyFailures = appendReplyFailure(draft.replyFailures, {
        at: nowIso(),
        groupId: String(event.groupId || ''),
        kind: classifyLlmFailure(error),
      });
    });
  }
  recordDecisionError(`回复失败：${String(error?.message || error).slice(0, 500)}`);
  updateDb((draft) => {
    draft.usage.errors += 1;
    draft.usageEvents ||= [];
    draft.usageEvents.push({
      id: crypto.randomUUID(), kind: 'reply-delivery', requestId: currentRequestTraceId(),
      groupId: event.groupId, userId: event.userId,
      status: deliveryStarted ? 'failed_or_unknown' : 'generation_failed',
      accountingExcluded: true, createdAt: nowIso(),
    });
    draft.usageEvents = draft.usageEvents.slice(-5000);
    draft.decisions.push({
      id: crypto.randomUUID(),
      requestId: currentRequestTraceId(),
      messageId: event.messageId,
      groupId: event.groupId,
      userId: event.userId,
      shouldReply: false,
      reason: `调用失败：${error.message}`,
      createdAt: nowIso()
    });
  });
  return { replied: false, error: error.message, reason: decision.reason };
}
