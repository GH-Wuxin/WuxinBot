// Success accounting for a conversation turn. The caller has already finished
// delivery; this module only persists the assistant history, usage totals and
// the reading proposal, then returns the public reply result.
import crypto from 'node:crypto';
import { runBackgroundTask } from '../backgroundTasks.js';
import { nowIso, updateDb } from '../store.js';
import { recordAssistantContext } from '../messageFacts.js';
import { currentRequestTraceId, traceEvent } from '../requestTrace.js';
import { activeModelName } from '../modelConfig.js';
import { applyUsageTotals, usageEventFields } from '../usage.js';
import { tokenSaving } from './tokenSaving.js';
import { commitSelfProposal, markExperienceShared } from './social/self.js';
import { replyTargetMetadata } from './inboundContext.js';

export interface ConversationSuccessInput {
  event: any;
  settings: any;
  decision: any;
  ai: any;
  deliveredText: string;
  segments: any[];
  toolImages: any[];
  toolDeliverImages: any[];
  modelStickerPath?: string;
  modelStickerHistory?: any;
  deliveredMediaImages: any[];
  readingProposal?: any;
  readingScope: string;
  readingRevision: number;
  readingSources: any[];
  confirmedReceipts: any[];
}

export function recordConversationSuccess(input: ConversationSuccessInput) {
  const {
    event, settings, decision, ai, deliveredText, segments,
    toolImages, toolDeliverImages, modelStickerPath, modelStickerHistory,
    deliveredMediaImages, readingProposal, readingScope, readingRevision,
    readingSources, confirmedReceipts,
  } = input;

  if (readingProposal) void runBackgroundTask('self.reading',()=>updateDb(draft=>{
    if(tokenSaving(draft)||draft.settings.socialV2Enabled!==true)return;
    const result=commitSelfProposal(draft,readingProposal,{scope:readingScope,sources:readingSources,
      expectedRevision:readingRevision,requiredEvidenceIds:readingSources.map(s=>s.id)});
    if(result.experienceId&&confirmedReceipts.length)markExperienceShared(draft,result.experienceId,readingScope,confirmedReceipts.at(-1)!);
    traceEvent('GATE','pippi_self_reading',result);
  }));

  updateDb((draft) => {
    recordAssistantContext(draft, {
      id: crypto.randomUUID(),
      requestId: currentRequestTraceId(),
      ...replyTargetMetadata(event),
      role: 'assistant',
      type: event.type,
      groupId: event.groupId,
      userId: 'bot',
      nickname: '机器人',
      content: deliveredText,
      media: deliveredMediaImages.length > 0 ? { images: deliveredMediaImages } : undefined,
      sticker: modelStickerHistory || undefined,
      inContext: true,
      createdAt: nowIso()
    });
    applyUsageTotals(draft.usage, ai.usage);
    if (!ai.usage?.accounted) draft.usage.requests += 1;
    draft.usage.replies += Math.max(1, segments.length);
    if (!draft.usageEvents) draft.usageEvents = [];
    draft.usageEvents.push({
      id: crypto.randomUUID(),
      kind: 'reply-delivery',
      requestId: currentRequestTraceId(),
      status: 'completed',
      groupId: event.groupId,
      userId: event.userId,
      model: ai.model || activeModelName(settings),
      provider: ai.provider || settings.llmProvider,
      ...usageEventFields(ai.usage),
      createdAt: nowIso()
    });
    draft.usageEvents = draft.usageEvents.slice(-5000);
  });

  return {
    replied: true,
    text: deliveredText,
    images: toolImages,
    stickers: [...toolDeliverImages, ...(modelStickerPath ? [modelStickerPath] : [])],
    segments,
    usage: ai.usage,
    latencyMs: ai.latencyMs,
    reason: decision.reason
  };
}
