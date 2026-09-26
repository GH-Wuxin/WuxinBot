# audit-only DB metrics collector (ASCII source, unicode escapes for CJK literals)
import json, os, collections, math
from pathlib import Path
ROOT = Path(r'G:\QQ-AI-ChatBot')
OUT = ROOT/'tmp'/'prompt_review_audit_v01'
DB = Path(os.environ['APPDATA'])/'Wuxin'/'db.json'
db = json.loads(DB.read_text(encoding='utf-8'))
def pct(values, q):
    if not values: return None
    s=sorted(values); pos=q*(len(s)-1); lo=int(math.floor(pos)); hi=int(math.ceil(pos))
    if lo==hi: return s[lo]
    w=pos-lo; return s[lo]*(1-w)+s[hi]*w
ev=db.get('usageEvents',[])
by_kind=collections.defaultdict(lambda: {'n':0,'prompt':0,'completion':0,'total':0,'prompt_values':[]})
by_model=collections.defaultdict(lambda: {'n':0,'prompt':0,'completion':0})
for e in ev:
    kind=e.get('kind') or 'CHAT_OR_LEGACY_NO_KIND'
    k=by_kind[kind]; k['n']+=1; k['prompt']+=e.get('promptTokens') or 0; k['completion']+=e.get('completionTokens') or 0; k['total']+=e.get('totalTokens') or 0; k['prompt_values'].append(e.get('promptTokens') or 0)
    m=by_model[e.get('model') or 'UNKNOWN']; m['n']+=1; m['prompt']+=e.get('promptTokens') or 0; m['completion']+=e.get('completionTokens') or 0
usage_summary={}
for kind,k in sorted(by_kind.items(), key=lambda kv:-kv[1]['n']):
    vals=k['prompt_values']
    usage_summary[kind]={'n':k['n'],'prompt_total':k['prompt'],'completion_total':k['completion'],'prompt_mean':round(k['prompt']/k['n'],1) if k['n'] else None,'prompt_p50':round(pct(vals,0.5),1) if vals else None,'prompt_p90':round(pct(vals,0.9),1) if vals else None,'prompt_p95':round(pct(vals,0.95),1) if vals else None,'prompt_max':max(vals) if vals else None}
model_summary={m:{'n':v['n'],'prompt_mean':round(v['prompt']/v['n'],1) if v['n'] else None,'completion_mean':round(v['completion']/v['n'],1) if v['n'] else None} for m,v in by_model.items()}
tools=db.get('toolCallLogs',[])
tool_by_cap=collections.defaultdict(lambda: {'n':0,'ok':0,'error':0,'latency':[]})
for t in tools:
    k=tool_by_cap[t.get('capability') or 'UNKNOWN']; k['n']+=1; k['ok']+=1 if t.get('ok') else 0; k['error']+=0 if t.get('ok') else 1
    if isinstance(t.get('latencyMs'),(int,float)): k['latency'].append(float(t['latencyMs']))
tool_summary={cap:{'n':v['n'],'ok':v['ok'],'error':v['error'],'latency_p50':round(pct(v['latency'],0.5),1) if v['latency'] else None,'latency_p90':round(pct(v['latency'],0.9),1) if v['latency'] else None,'latency_p95':round(pct(v['latency'],0.95),1) if v['latency'] else None,'latency_max':max(v['latency']) if v['latency'] else None} for cap,v in tool_by_cap.items()}
cmds=db.get('commandLogs',[])
cmd_by=collections.defaultdict(lambda: {'n':0,'ok':0,'error':0,'latency':[]})
for c in cmds:
    key=c.get('command') or 'UNKNOWN'; k=cmd_by[key]; k['n']+=1; k['ok']+=1 if c.get('status')=='ok' else 0; k['error']+=1 if c.get('status')!='ok' else 0
    if isinstance(c.get('latencyMs'),(int,float)): k['latency'].append(float(c['latencyMs']))
cmd_summary={key:{'n':v['n'],'ok':v['ok'],'error':v['error'],'latency_p50':round(pct(v['latency'],0.5),1) if v['latency'] else None,'latency_p90':round(pct(v['latency'],0.9),1) if v['latency'] else None,'latency_p95':round(pct(v['latency'],0.95),1) if v['latency'] else None,'latency_max':max(v['latency']) if v['latency'] else None} for key,v in sorted(cmd_by.items(), key=lambda kv:-kv[1]['n'])}
analyses=db.get('osuAnalyses',[])
review_rows=[]; invoked=0; pass_all=0; any_hard=0; any_quality_only=0; unavailable=0; no_review=0; effective_changed=0
for a in analyses:
    log=a.get('reviewLog') or []
    row={'createdAt':a.get('createdAt'),'rounds':len(log),'unavailable':False,'verdicts':[],'rejects':[],'hard_rejects':0,'quality_rejects':0,'effective_change':False,'conclusionSource':a.get('conclusionSource'),'sectionCommentsSource':a.get('sectionCommentsSource'),'formatVersion':a.get('formatVersion')}
    if not log:
        no_review+=1
    else:
        for r in log:
            if r.get('unavailable'): unavailable+=1; row['unavailable']=True; continue
            invoked+=1
            for v in r.get('verdicts') or []: row['verdicts'].append({'section':v.get('section'),'result':v.get('result'),'kind':v.get('kind'),'reason':(v.get('reason') or '')[:160]})
            for v in r.get('rejects') or []: row['rejects'].append({'section':v.get('section'),'kind':v.get('kind'),'reason':(v.get('reason') or '')[:160]})
        row['hard_rejects']=sum(1 for v in row['rejects'] if v.get('kind')!='quality'); row['quality_rejects']=sum(1 for v in row['rejects'] if v.get('kind')=='quality')
        if row['rejects']:
            if row['hard_rejects']>0: any_hard+=1
            else: any_quality_only+=1
        elif row['unavailable']: pass
        else: pass_all+=1
        if row['hard_rejects']>0: effective_changed+=1; row['effective_change']=True
    review_rows.append(row)
eligible=len(analyses)-no_review
review_summary={'osuAnalyses_total':len(analyses),'no_review_log':no_review,'eligible':eligible,'review_invoked_rounds':invoked,'review_unavailable':unavailable,'analyses_review_all_pass':pass_all,'analyses_with_quality_reject_only':any_quality_only,'analyses_with_hard_reject':any_hard,'effective_change_analyses':effective_changed,'effective_change_rate': round(effective_changed/eligible,4) if eligible else None,'pass_through_rate': round(pass_all/eligible,4) if eligible else None}
verdict_counts=collections.Counter()
for a in review_rows:
    for v in a['verdicts']: verdict_counts[(v['result'], v.get('kind') or 'none')]+=1
review_summary['verdict_counts']={str(k[0])+':'+str(k[1]):v for k,v in verdict_counts.items()}
def classify_reason(reason):
    s=str(reason)
    if any(w in s for w in ['\u6570\u5b57','\u4e0d\u7b26','\u9519\u8bef','\u77db\u76fe','\u7f16','\u865a\u6784','\u4e8b\u5b9e','\u8303\u56f4','\u6570\u91cf','\u6bd4\u4f8b','\u91cd\u590d']): return 'CORRECT_INTERVENTION'
    if any(w in s for w in ['\u6587\u98ce','\u8bed\u6c14','\u5b57\u6570','\u6bd4\u55bb','\u98ce\u683c','\u5356\u840c','\u592a\u77ed','\u592a\u957f']): return 'STYLE_ONLY_CHANGE'
    if any(w in s for w in ['\u683c\u5f0f','\u8282\u70b9','JSON','\u5b57\u6bb5','\u65ad\u88c2']): return 'FORMAT_REPAIR'
    if any(w in s for w in ['\u4ed6/\u5979','\u6027\u522b','\u7b2c\u4e8c\u4eba\u79f0','\u4ee3\u8bcd','\u4eba\u79f0']): return 'PERSONA_REPAIR'
    if any(w in s for w in ['Mod','HD','HR','DT','NM','alt','\u8c31\u9762','\u672f\u8bed']): return 'MEANINGFUL_SAFETY_CHANGE'
    return 'UNKNOWN'
review_quality_rows=[]
for a in review_rows:
    for v in a['rejects']: review_quality_rows.append({'createdAt':a['createdAt'],'section':v.get('section'),'kind':v.get('kind'),'reason':v.get('reason'),'classification':classify_reason(v.get('reason'))})
quality_classification=collections.Counter(r['classification'] for r in review_quality_rows)
dec=db.get('decisions',[]); recent_dec=[d for d in dec if d.get('createdAt','')>='2026-08-01T00:00:00.000Z']
dec_counts=collections.Counter(('reply' if d.get('shouldReply') else 'no_reply') for d in recent_dec)
msgs=db.get('messages',[]); msg_counts=collections.Counter(m.get('role') for m in msgs)
out={'schema_version':'prompt_review_audit_db_metrics_v1','db_path':'%APPDATA%/Wuxin/db.json (read-only; secrets excluded)','usageEvents':{'total_stored':len(ev),'by_kind':usage_summary,'by_model':model_summary},'toolCallLogs':{'total':len(tools),'by_capability':tool_summary},'commandLogs':{'total':len(cmds),'by_command':cmd_summary},'review':review_summary,'review_reject_classification':dict(quality_classification),'review_samples':{'pass':[{'createdAt':a['createdAt'],'verdicts':a['verdicts'][:8]} for a in review_rows if not a['rejects'] and not a['unavailable']][:50],'rewrite_or_hard_reject':[{'createdAt':a['createdAt'],'rejects':a['rejects'],'verdicts':a['verdicts']} for a in review_rows if a['hard_rejects']>0][:50],'quality_only':[{'createdAt':a['createdAt'],'rejects':a['rejects']} for a in review_rows if a['quality_rejects']>0 and a['hard_rejects']==0][:50],'unavailable':[{'createdAt':a['createdAt']} for a in review_rows if a['unavailable']][:50]},'decisions':{'total_stored':len(dec),'since_2026_08_01':len(recent_dec),'counts':dict(dec_counts)},'messages':{'total_stored':len(msgs),'by_role':dict(msg_counts)},'latency':{'llm_latency':'LATENCY_DATA_UNAVAILABLE','tool_latency':'available in toolCallLogs','command_latency':'available in commandLogs'}}
(OUT/'db_metrics.json').write_text(json.dumps(out,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
print('WROTE', OUT/'db_metrics.json'); print('review_summary', json.dumps(review_summary,ensure_ascii=False)); print('verdict_counts', review_summary['verdict_counts']); print('quality_classification', quality_classification); print('tool_logs', len(tools), tool_summary); print('usage by kind', json.dumps(usage_summary,ensure_ascii=False))

