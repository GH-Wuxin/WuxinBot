import crypto from 'node:crypto';
import { readDb } from '../store.js';
import { redactTraceValue } from '../requestTrace.js';
import { getAllCommandHelpEntries, canViewCommand, canListCommand, permissionSentence } from './commands/index.js';
import { CAPABILITY_CATALOG } from '../bots/capabilityCatalog.js';
import { hasCommandPermission } from './commands.js';
import { registeredPublicFeatures, type FeatureState } from './features.js';
import { stickerAvailabilityForGroup } from './stickers/delivery.js';
import { tokenSaving } from './tokenSaving.js';
import { isOsuSearchAvailable } from '../osu/search.js';
import { loadRegistry, enabledBots } from '../bots/registry.js';
import { findMessageFact, messageInConversation, messageAccount, conversationKey } from '../messageFacts.js';
import { settlePendingQuickObservations } from './quickContext.js';
import { inspectOwnMessages, ownMessageInspectionTool, publicOwnMessage } from './ownMessageInspection.js';

interface CapabilityView { id: string; description: string; entry: string; kind: string; state: FeatureState; permission?: string }
function safeText(value: unknown, limit = 320) {
  return String(redactTraceValue(String(value || ''))).replace(/\[CQ:[^\]]*\]/gi, '')
    .replace(/https?:\/\/(?:localhost|127\.[\d.]+|10\.[\d.]+|192\.168\.[\d.]+)(?::\d+)?[^\s，。；]*/gi,'[内部地址]')
    .replace(/(?:[A-Z]:[\\/]|file:\/\/|\/(?:home|root|etc|var)\/|Bearer\s+|\bsk-[A-Za-z0-9])[^\s，。；]*/gi, '[内部信息]').slice(0, limit);
}
function identity(db: any, event: any) {
  const owner = Boolean(db.settings?.ownerQq && String(db.settings.ownerQq) === String(event.userId));
  const user = (db.users || []).find((u: any) => String(u.groupId) === String(event.groupId) && String(u.userId) === String(event.userId)) || {};
  const group = (db.groups || []).find((g: any) => String(g.groupId) === String(event.groupId));
  const admin = owner || ['owner', 'admin'].includes(event.senderRole) || user.policy === 'admin' || user.allowCommands === true;
  // Owner-only documentation is private, even when the Owner asks in a group.
  return { owner, user, group, permissions: { isOwner: owner && event.type === 'private', isAdmin: admin },
    allowed: event.type === 'private' ? owner : Boolean(group?.enabled && user.policy !== 'blocked') };
}
export function runtimeCapabilities(db: any, event: any): CapabilityView[] {
  const who = identity(db, event);
  if (!who.allowed) return [];
  const paused = db.settings?.globalPaused || who.group?.mode === 'silent';
  const binding = db.osuBindings?.[String(event.userId)];
  const commands: CapabilityView[] = getAllCommandHelpEntries().filter(entry => entry.status === 'active'
    && canViewCommand(entry.visibility, who.permissions)
    && canListCommand(entry.visibility, entry.discoverability, entry.permission, who.permissions)).map(entry => {
    const permitted = entry.permissionKey ? hasCommandPermission(db, who.user, {isOwner: who.owner,isAdmin: who.permissions.isAdmin}, entry.permissionKey)
      : entry.permission === 'all' || entry.permission === 'group_admin' && who.permissions.isAdmin || entry.permission === 'owner' && who.owner;
    const disabled = entry.source && db.groupBotConfig?.[String(event.groupId)]?.[entry.source] === false;
    return { id: `command.${entry.namespace}.${entry.source || 'pippi'}.${entry.id}`, description: safeText(entry.description),
      entry: safeText(entry.canonicalSyntax), kind: 'command', permission: permissionSentence(entry.permission),
      state: paused || disabled ? 'disabled' : !permitted ? 'needs_permission' : 'command_only' };
  });
  const toolEnabled = !paused && !tokenSaving(db) && who.group?.mode !== 'osu';
  const botsEnabled = enabledBots(loadRegistry(db)).length > 0;
  const tools: CapabilityView[] = CAPABILITY_CATALOG.filter(item => item.callable && (item.rollout !== 'owner_canary' || who.owner))
    .map(item => ({id:`tool.${item.name}`,description:safeText(item.description),entry:item.name,kind:'tool',
      // No binding is needed when an explicit public player is supplied.
      state: toolEnabled && botsEnabled ? 'available' : 'disabled'}));
  const modules: CapabilityView[] = registeredPublicFeatures().map(feature => {
    let state: FeatureState = 'unknown';try{
      const resolved=feature.state(db,event);
      if(['available','disabled','command_only','automatic','needs_permission','needs_binding','unknown'].includes(resolved))state=resolved;
    }catch{/* no internal errors in public output */}
    return {id:`feature.${feature.id}`,description:safeText(feature.description),entry:feature.trigger,kind:feature.trigger,state};
  });
  const sticker = stickerAvailabilityForGroup(db, event.groupId);
  return [...commands,...tools,...modules,
    {id:'feature.reply_sticker',description:'在聊天回复中按语境选择可用表情，与自动随机发图相互独立。',entry:'conversation',kind:'conversation',state:sticker==='live'?'available':'disabled'},
    {id:'feature.osu_search',description:'搜索和阅读 osu! 官方资料；不提供任意站点的通用浏览。',entry:'conversation',kind:'tool',state:toolEnabled&&isOsuSearchAvailable(db)?'available':'disabled'},
    {id:'feature.osu_binding',description:binding?'当前发言者已有 osu! 绑定，可查询自己的游戏数据。':'可通过绑定指令关联自己的 osu! 账号，指定公开玩家的查询不要求自己先绑定。',entry:'/w osu bind',kind:'command',state:binding?'command_only':'needs_binding'},
  ];
}
export function inspectCapabilities(db: any, event: any, args: any = {}) {
  if (!args || typeof args !== 'object' || Object.keys(args).some(k=>!['query','id','offset','view'].includes(k))
    || args.view !== undefined && !['overview','entries'].includes(args.view)) return {ok:false,error:'invalid_arguments'};
  const all=runtimeCapabilities(db,event);
  const version=crypto.createHash('sha256').update(JSON.stringify(all)).digest('hex').slice(0,16);
  if (args.view === 'overview' || !args.view && !args.query && !args.id && args.offset === undefined) {
    const features = all.filter(item => item.id.startsWith('feature.'));
    const tools = all.filter(item => item.id.startsWith('tool.'));
    const commands = all.filter(item => item.kind === 'command');
    return {ok:true,view:'overview',version,total:all.length,
      features:features.map(({description,entry,state}) => ({description,entry,state})),
      dataQueries:tools.map(({description,state}) => ({description:description.slice(0,100),state})),
      commands:{count:commands.length,examples:commands.slice(0,5).map(({description,entry,state}) => ({description:description.slice(0,80),entry,state}))},
      detail:'主要功能可据此回答，无需遍历指令表；用户需要全部指令时用 view=entries、offset 分页，具体功能可用 query 或 id 查询。',
      boundary:'仅描述当前会话可见的能力和状态，不授予执行权限。'};
  }
  const query=String(args.query||'').trim().slice(0,80).toLowerCase();
  const filtered=all.filter(item=>(!args.id||item.id===args.id)&&(!query||`${item.id} ${item.description} ${item.entry}`.toLowerCase().includes(query)));
  const offset=Math.max(0,Math.min(500,Number.isInteger(args.offset)?args.offset:0));
  // Pack complete entries into the executor's result limit. Pagination should
  // make the whole current catalog reachable within the normal tool budget.
  const items: Array<Pick<CapabilityView,'id'|'description'|'entry'|'state'> & Partial<CapabilityView>>=[];
  const page=()=>({ok:true,version,total:filtered.length,items,nextOffset:offset+items.length<filtered.length?offset+items.length:null,
    boundary:'目录说明能力，不授予执行权限；状态可能变化，执行时仍需校验。'});
  for(const item of filtered.slice(offset,offset+32)){
    items.push(args.id||filtered.length<=4?item:{id:item.id,description:item.description.slice(0,120),entry:item.entry,state:item.state,
      ...(item.state==='needs_permission'?{permission:item.permission}:{})});
    if(JSON.stringify(page()).length>3800){items.pop();break;}
  }
  return page();
}
export function inspectMessage(db: any, event: any, args: any = {}) {
  if (!identity(db,event).allowed || !args || Object.keys(args).some(k=>!['message_id','recent_self','include_summary'].includes(k))) return {ok:false,error:'not_available'};
  const rows=args.recent_self===true ? (db.messages||[]).filter((m:any)=>m.role==='assistant'&&m.deliveryOutcome==='confirmed_success'
    &&messageInConversation(m,event,messageAccount(db,event))).slice(-5) : [findMessageFact(db,event,args.message_id||event.replyMessageId)].filter(Boolean);
  // The transport may have verified an older/directly sent quote through QQ
  // even when the local journal has no row. Preserve that scoped author fact.
  const quote=event.quotedMessage, wanted=String(args.message_id||event.replyMessageId||'');
  if(!rows.length&&args.recent_self!==true&&quote?.verified===true&&quote.scope===conversationKey(event)
    &&quote.accountId===messageAccount(db,event)&&String(quote.messageId)===wanted){
    return {ok:true,messages:[{messageId:wanted,sender:quote.isSelf===true?'pippi':'participant',
      nickname:quote.isSelf===true?'pippi':safeText(quote.nickname,80),text:safeText(quote.text,1200),
      origin:quote.originModule||'unknown',imageCount:Array.isArray(quote.images)?quote.images.length:0,
      delivery:'platform_verified',summaryStatus:'not_available'}],
      boundary:'作者已通过本会话 QQ 引用核验。来源 unknown 表示没有触发原因记录；不能根据当前功能开关猜测历史发送原因。'};
  }
  return {ok:true,messages:rows.map((row:any)=>{
    const m=row.role==='assistant'?(findMessageFact(db,event,row.sourceMessageId||row.messageId)||row):row;
    const provenance=m.role==='assistant'?publicOwnMessage(m,event,false):undefined;
    return {messageId:String(m.sourceMessageId||m.messageId||''),sender:m.role==='assistant'?'pippi':'participant',
    nickname:m.role==='assistant'?'pippi':safeText(m.nickname,80),text:safeText(m.content,1200),origin:provenance?.source.chain.at(-1)?.module||(m.role==='assistant'?'unknown':'received'),
    imageCount:m.mediaImageCount??m.media?.images?.length??0,delivery:m.deliveryOutcome||'received',summaryStatus:m.pendingQuickId?'pending':m.contextSummary?'ready':'not_available',
    ...(provenance?{provenance}:{}),
    ...(args.include_summary===true&&m.contextSummary?{summary:safeText(m.contextSummary,1200)}:{})};})};
}
export const INTROSPECTION_TOOL_NAMES = ['inspect_capabilities','inspect_message','inspect_own_messages'];
export function buildIntrospectionTools() {
  return [
    ownMessageInspectionTool(),
    {type:'function',function:{name:'inspect_capabilities',description:'只读查看实际注册的功能和当前可用性。默认 overview 一次返回主要功能与数据查询概览；只有需要全部指令才用 entries 分页。query/id 查具体条目。不会执行功能或修改设置。',parameters:{type:'object',additionalProperties:false,properties:{view:{type:'string',enum:['overview','entries']},query:{type:'string'},id:{type:'string'},offset:{type:'integer',minimum:0}}}}},
    {type:'function',function:{name:'inspect_message',description:'只读核对本会话引用消息或最近自己确认发出的消息。用于确认作者、随机发图来源和发送结果；不查询他群或私聊。只有确实需要图片查询的具体数据时设 include_summary=true，未完成会明确返回 pending，不得猜测。',parameters:{type:'object',additionalProperties:false,properties:{message_id:{type:'string'},recent_self:{type:'boolean'},include_summary:{type:'boolean'}}}}},
  ];
}
export async function executeIntrospection(db: any, event: any, call: any) {
  let args:any;try{args=JSON.parse(call.function.arguments||'{}');}catch{return {toolCallId:call.id,ok:false,content:'参数格式无效'};}
  if(call.function.name==='inspect_message'&&args?.include_summary===true&&identity(db,event).allowed){
    const record=findMessageFact(db,event,args.message_id||event.replyMessageId);
    if(record?.pendingQuickId)await settlePendingQuickObservations({...event,userId:record.replyToUserId||event.userId},undefined,{recordId:record.pendingQuickId,timeoutMs:5000});
  }
  const result=call.function.name==='inspect_capabilities'?inspectCapabilities(db,event,args)
    :call.function.name==='inspect_own_messages'?inspectOwnMessages(readDb(),event,args):inspectMessage(readDb(),event,args);
  return {toolCallId:call.id,ok:result.ok,content:JSON.stringify(result),metadata:{provider:'pippi-self-inspection'}};
}
export function capabilityContext(db: any, event: any): string {
  if (!identity(db,event).allowed) return '';
  return '【按需自查】可自主调用 inspect_capabilities 查实际功能，inspect_message 核对引用作者，inspect_own_messages 查自己消息的具体来源、发送原因、对象与结果。需要依据时再查；不凭当前开关猜历史原因。工具只读且限当前会话，向群友用自然名称说明。';
}
