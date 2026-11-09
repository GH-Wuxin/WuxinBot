import { extractAtTargets, extractReplyMessageId, normalizeMessage } from './bot/cleaning.js';
import { redactTraceValue } from './requestTrace.js';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface SourceStep {
  module: string;
  operation: string;
  producer?: string;
  outcome?: 'success' | 'fallback' | 'requested' | 'failed';
}
export interface MessageTrigger {
  kind: 'message' | 'scheduled' | 'event' | 'unknown';
  scope: string;
  messageId?: string;
  userId?: string;
  nickname?: string;
  eventId?: string;
  preview?: string;
  inputSource?: string;
}
export interface SendCause {
  code: string;
  description: string;
  audience: 'requester' | 'conversation' | 'specified' | 'unknown';
  addressedTo?: string[];
}
export interface MessageSource {
  version: 1;
  certainty: 'recorded' | 'legacy' | 'unknown';
  chain: SourceStep[];
  cause: SendCause;
  trigger: MessageTrigger;
}
export interface MessageDeliveryFacts {
  destination: { type: 'group' | 'private'; id: string };
  addressedTo: string[];
  mentions: string[];
  quoteMessageId?: string;
  forwarded: boolean;
}
export type MessageSender = (event: any, body: any, options?: any) => Promise<any>;
const producerContext = new AsyncLocalStorage<SourceStep[]>();
export function producerFacts(): SourceStep[] { return producerContext.getStore() || []; }
export function recordMessageProducer(step: SourceStep): void { producerContext.getStore()?.push(step); }
export async function collectMessageProducers<T>(work: () => Promise<T>): Promise<{value:T; producers:SourceStep[]}> {
  const producers: SourceStep[] = [];
  return producerContext.run(producers, async () => ({value: await work(), producers}));
}
function uniqueSteps(steps: SourceStep[]): SourceStep[] {
  const seen = new Set<string>();
  return steps.filter(step => {const key=JSON.stringify(step);if(seen.has(key))return false;seen.add(key);return true;});
}

/** Public text only: never expose transport URLs, credentials or local media paths. */
export function publicMessageText(input: unknown, limit = 1200): string {
  return String(redactTraceValue(normalizeMessage(String(input ?? ''))))
    .replace(/\[CQ:[^\]]*\]/gi, '')
    .replace(/https?:\/\/(?:localhost|127\.[\d.]+|10\.[\d.]+|192\.168\.[\d.]+)(?::\d+)?[^\s，。；]*/gi, '[内部地址]')
    .replace(/(?:[A-Z]:[\\/]|file:\/\/|\/(?:home|root|etc|var)\/|Bearer\s+|\bsk-[A-Za-z0-9])[^\s，。；]*/gi, '[内部信息]')
    .slice(0, limit);
}
export const eventScope = (event: any): string => event.type === 'group'
  ? `group:${String(event.groupId || '')}` : `private:${String(event.userId || '')}`;

export function messageTrigger(event: any, includePreview = false): MessageTrigger {
  return {kind: event.messageId ? 'message' : 'unknown', scope: eventScope(event),
    inputSource: String(event.source || 'unknown'),
    ...(event.messageId ? {messageId: String(event.messageId)} : {}),
    ...(event.userId ? {userId: String(event.userId), nickname: publicMessageText(event.nickname, 80)} : {}),
    ...(includePreview && event.text ? {preview:publicMessageText(event.text,400)} : {})};
}

/** Bind provenance at the execution boundary. This never classifies user text. */
export function sourceSender<T extends MessageSender | undefined>(
  send: T, step: SourceStep | (() => SourceStep[]), cause: SendCause, trigger: MessageTrigger,
): T {
  if (!send) return send;
  return ((event: any, body: any, options: any = {}) => {
    const steps = typeof step === 'function' ? step() : [step];
    const child: MessageSource | undefined = options.messageSource;
    const source: MessageSource = {
      version: 1, certainty: 'recorded',
      chain: uniqueSteps([...steps, ...(child?.chain || [])]),
      cause: child?.cause || cause, trigger: child?.trigger || trigger,
    };
    return send(event, body, {...options, messageSource: source});
  }) as T;
}

export function sourceDetails(step: SourceStep, cause: SendCause, event: any): {messageSource: MessageSource} {
  return {messageSource: {version: 1, certainty: 'recorded', chain: [step], cause, trigger: messageTrigger(event)}};
}

/** Legacy tags prove a broad category, never the detailed reason or executor. */
export function legacyMessageSource(record: any): MessageSource {
  const tag = String(record.originModule || '');
  const evidenced = ['random_image', 'quick_command', 'notice', 'forward'].includes(tag);
  return {version: 1, certainty: evidenced ? 'legacy' : 'unknown',
    chain: evidenced ? [{module: tag, operation: 'legacy_record'}] : [],
    cause: {code: 'not_recorded', description: '该记录只保留了来源类别，未保存具体发送原因，不能据当前开关或文本推断。', audience: 'unknown'},
    trigger: {kind: 'unknown', scope: record.type === 'group' ? `group:${record.groupId}` : `private:${record.peerId || record.replyToUserId || ''}`}};
}

export function resolveMessageSource(event: any, options: any): MessageSource {
  const source = options.messageSource;
  if (source?.version === 1 && source.certainty === 'recorded' && Array.isArray(source.chain)
    && source.chain.length && source.chain.every((s: any) => typeof s.module === 'string' && s.module.length > 0 && s.module.length <= 100
      && typeof s.operation === 'string' && s.operation.length > 0 && s.operation.length <= 150
      && (s.producer === undefined || typeof s.producer === 'string')
      && (s.outcome === undefined || ['success','fallback','requested','failed'].includes(s.outcome)))
    && typeof source.cause?.code === 'string' && typeof source.cause?.description === 'string'
    && ['requester','conversation','specified','unknown'].includes(source.cause.audience)
    && typeof source.trigger?.scope === 'string' && source.trigger.scope
    && ['message','scheduled','event','unknown'].includes(source.trigger.kind)) {
    return structuredClone(source);
  }
  const legacy = legacyMessageSource({...event, originModule:options.originModule, peerId:event.type==='private'?event.userId:undefined});
  if (legacy.certainty === 'legacy') return legacy;
  return {version: 1, certainty: 'unknown', chain: [],
    cause: {code: 'source_unavailable', description: '账号发送已被观察到，但发送方没有提供可核验的来源和原因。', audience: 'unknown'},
    trigger: {kind: 'unknown', scope: eventScope(event)}};
}

/** The caller passes the exact OneBot message envelope, including automatic @/quote. */
export function deliveryFacts(event: any, wireMessage: any, forwarded: boolean, source: MessageSource): MessageDeliveryFacts {
  const intended = source.cause.audience === 'requester' && source.trigger.scope === eventScope(event)
    ? [source.trigger.userId || ''] : source.cause.audience === 'specified' ? source.cause.addressedTo || [] : [];
  return {destination: {type: event.type, id: String(event.type === 'group' ? event.groupId : event.userId)},
    addressedTo: intended.filter(Boolean), mentions: forwarded ? [] : extractAtTargets(wireMessage),
    ...(forwarded ? {} : {quoteMessageId: extractReplyMessageId(wireMessage) || undefined}), forwarded};
}

export function publicSource(source: MessageSource | undefined, scope: string): MessageSource {
  const original = source || legacyMessageSource({type: 'group', groupId: ''});
  const local = original.trigger.scope === scope;
  return {version: 1, certainty: original.certainty,
    chain: uniqueSteps(original.chain).map(step => ({module: publicMessageText(step.module, 70),
      operation: publicMessageText(step.operation, 90), ...(step.producer ? {producer: publicMessageText(step.producer, 70)} : {}),
      ...(step.outcome ? {outcome: step.outcome} : {})})),
    cause: {code: publicMessageText(original.cause.code, 80),
      description: local ? publicMessageText(original.cause.description, 240) : '由其他会话触发；本会话不能读取原请求的身份和内容。',
      audience: original.cause.audience},
    trigger: local ? {kind: original.trigger.kind, scope,
      ...(original.trigger.messageId ? {messageId: original.trigger.messageId} : {}),
      ...(original.trigger.userId ? {userId: original.trigger.userId, nickname: publicMessageText(original.trigger.nickname, 80)} : {}),
      ...(original.trigger.eventId ? {eventId: publicMessageText(original.trigger.eventId, 100)} : {}),
      ...(original.trigger.preview ? {preview:publicMessageText(original.trigger.preview,400)} : {}),
      ...(original.trigger.inputSource ? {inputSource:publicMessageText(original.trigger.inputSource,40)} : {})}
      : {kind: original.trigger.kind, scope: 'other_conversation'}};
}
