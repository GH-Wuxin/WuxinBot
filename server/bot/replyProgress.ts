import { readDb } from '../store.js';
import { isDirectBotMention } from './reply.js';
import { isReplyProcessAborted, onReplyProcessAbort } from './replyProcesses.js';
import { socialDeliveryGuard } from './social/runtime.js';
import { sendOptionalNotice } from './notice.js';
import { registerPublicFeature } from './features.js';

registerPublicFeature({id:'progress_replies',description:'被 @ 的复杂请求可先简短回应，按实际进展补充，再分段给出完整结果；简单聊天直接回答。',trigger:'conversation',visibility:'public',
  state:db=>db.settings.pippiProgressReplies===false||process.env.PIPPI_PROGRESS_REPLIES==='0'?'disabled':'available'});

export function shouldUseReplyProgress(db: any, event: any, options: {longForm?:boolean;requiresData?:boolean}={}) {
  if(db.settings.pippiProgressReplies===false||process.env.PIPPI_PROGRESS_REPLIES==='0'||!isDirectBotMention(event,db.settings))return false;
  const text=String(event.text||'').replace(/\[CQ:[^\]]*\]/g,'').trim();
  return Boolean(options.longForm||text.length>180||/(?:详细|完整|逐步|一步步|深入|对比|比较|分析|规划|排查)/.test(text)
    ||options.requiresData&&/(?:分别|再查|然后|以及|一起|同时)/.test(text));
}

/** Read only the completed, leading public participation object, never reasoning. */
export function leadingSocialAction(text: string): 'pass'|'react'|'reply'|undefined {
  const value=String(text||'').slice(0,2048).trim().replace(/^```(?:json)?\s*/i,'');
  const prefix=/^\{\s*"social"\s*:\s*/.exec(value);
  if(!prefix||value[prefix[0].length]!=='{')return;
  const start=prefix[0].length;let depth=0,quoted=false,escaped=false;
  for(let i=start;i<value.length;i++){
    const char=value[i];
    if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue;}
    if(char==='"'){quoted=true;continue;}if(char==='{')depth++;if(char==='}')depth--;
    if(depth===0){try{const social=JSON.parse(value.slice(start,i+1));
      if(['pass','react','reply'].includes(social.action)&&['bot','member','group','unclear'].includes(social.addressee)
        &&typeof social.reason==='string'&&social.reason.length<=200)return social.action;
    }catch{/* incomplete or invalid content is never public progress */}return;}
  }
}

export function createReplyProgress(event: any, send: ((event:any,text:string,options?:any)=>Promise<unknown>)|undefined,
  options:{allowed:boolean;requiresData?:boolean;delayMs?:number;intervalMs?:number} ) {
  const started=Date.now(), delay=options.delayMs??1200, interval=options.intervalMs??8000;
  const controller=new AbortController();let allowed=options.allowed,closed=false,count=0,lastAt=0,stage='preparing';
  let inFlight=false,lastText='';
  const permitted=()=>!closed&&!isReplyProcessAborted()&&!socialDeliveryGuard(readDb(),event)
    &&readDb().settings.pippiProgressReplies!==false;
  const text=()=>stage==='message'?'我核对一下这条消息。':stage==='capabilities'?'我看看现在能用哪些功能。'
    :stage==='received'?'查到了，我把重点整理给你。':stage==='query'||options.requiresData?'我先查一下，等结果回来。':'我看一下，这条得分开捋。';
  const emit=()=>{
    if(!send||!allowed||!permitted()||inFlight||count>=2||Date.now()-started<delay||count&&Date.now()-lastAt<interval)return;
    const update=text();if(update===lastText)return;
    lastText=update;
    count++;lastAt=Date.now();inFlight=true;
    void sendOptionalNotice(()=>send(event,update,{originModule:'notice',suppressReply:true,signal:controller.signal}))
      .finally(()=>{inFlight=false;});
  };
  const timer=setTimeout(emit,Math.max(0,delay));timer.unref?.();
  const stop=()=>{closed=true;clearTimeout(timer);controller.abort();removeAbort();};
  const removeAbort=onReplyProcessAbort(()=>{closed=true;clearTimeout(timer);controller.abort();});
  return {
    observePublicOutput(value:string){const action=leadingSocialAction(value);if(action==='pass')stop();else if(action){allowed=true;emit();}},
    toolStarted(name:string){if(closed)return;allowed=true;stage=name==='inspect_message'?'message':name==='inspect_capabilities'?'capabilities':'query';emit();},
    toolFinished(ok:boolean){if(closed||!ok)return;stage='received';emit();},
    stop,
  };
}

/** Keep complete paragraphs/list lines, cap chat messages, never truncate content. */
export function stagedReplySegments(text: string): string[] {
  const cleaned=String(text||'').trim();if(!cleaned)return [];
  if(cleaned.length<=240)return [cleaned];
  if(cleaned.length>1800||cleaned.includes('```'))return [cleaned];
  const parts=cleaned.split(/\n\s*\n|\n(?=[-•*\d])|(?<=[。！？!?])\s*/u).map(s=>s.trim()).filter(Boolean);
  const segments:string[]=[];
  for(const part of parts){
    const last=segments.at(-1);
    if(!last||segments.length<3&&last.length+part.length>420)segments.push(part);
    else segments[segments.length-1]+='\n'+part;
  }
  return segments;
}
