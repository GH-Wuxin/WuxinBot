import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { Button, Card, Input, Switch, Textarea } from '../../components/ui/index.jsx';

const date = value => value ? new Date(value).toLocaleString('zh-CN') : '尚未发生';
export function SelfPanel({ db, scope, saveSettings, refreshState }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0), [editing, setEditing] = useState(null);
  const [budget, setBudget] = useState(db.settings.pippiActivityDailyTokens || 30000);
  const [wakes, setWakes] = useState(db.settings.pippiActivityMaxWakes || 3);
  const [forums, setForums] = useState((db.settings.pippiActivityForumIds || []).join(', '));
  const pending = useRef(null);
  const load = useCallback(async () => {
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
    try {
      const result = await api(`/api/social/self?scope=${encodeURIComponent(scope || 'public')}&offset=${offset}`, { signal: controller.signal });
      if (!controller.signal.aborted) { setData(result); setError(''); }
    } catch (cause) { if (!controller.signal.aborted) setError(cause.message); }
  }, [scope, offset]);
  useEffect(() => { void load(); return () => pending.current?.abort(); }, [load, db.socialV2Summary?.revision]);
  useEffect(() => { setOffset(0); setEditing(null); }, [scope]);
  const mutate = async work => {
    setBusy(true); setError('');
    try { await work(); await load(); await refreshState(); }
    catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  const activity = data?.activity;
  return <Card className="pippi-self">
    <div className="pippi-self-heading"><div><h2>Pippi 的近况与经历</h2><p>她最近在意的事，来自实际阅读和交流。</p></div><Button disabled={busy} onClick={load}>刷新</Button></div>
    {error && <p className="social-error" role="alert">{error}</p>}
    <div className="pippi-self-columns">
      <section><h3>此时心情</h3><strong>{data?.self.mood?.label || '还没有形成记录'}</strong>
        {data?.self.mood && <><p>{data.self.mood.reason}</p><small>{date(data.self.mood.updatedAt)} · {data.self.mood.scope}</small>
          <p className="social-note">其他会话仅使用抽象感受：{data.self.mood.publicTone}</p></>}
        <h3>最近关注</h3>
        {!(data?.self.focus.length) && <p className="social-note">没有未完的关注，也可以安静一阵。</p>}
        {(data?.self.focus || []).map(f => <div className="pippi-focus" key={f.id}><span>{f.text}<small>{f.scope}</small></span>
          <Button size="sm" disabled={busy} onClick={() => mutate(() => api(`/api/social/self/focus/${f.id}/end`, { method: 'POST', body: { revision: data.self.revision } }))}>结束关注</Button></div>)}
      </section>
      <section><h3>自主阅读</h3>
        <Switch checked={db.settings.pippiActivityEnabled === true} label="允许自主阅读" description="先取新资料，再由 Pippi 选择；关闭后保留已有经历。"
          disabled={busy} onChange={e => { const enabled = e.target.checked; void mutate(() => saveSettings({ pippiActivityEnabled: enabled })); }} />
        <div className="pippi-activity-settings"><Input label="后台每日 Token 额度" type="number" min="1000" max="100000" value={budget} onChange={e => setBudget(e.target.value)} />
          <Input label="每日最多唤醒" type="number" min="1" max="6" value={wakes} onChange={e => setWakes(e.target.value)} /></div>
        <Input label="公开论坛板块 ID（最多三个）" value={forums} onChange={e => setForums(e.target.value)} />
        <Button disabled={busy} onClick={() => mutate(() => saveSettings({ pippiActivityDailyTokens: Number(budget), pippiActivityMaxWakes: Number(wakes),
          pippiActivityForumIds: forums.trim() ? forums.split(/[,，\s]+/).map(Number) : [] }))}>保存活动设置</Button>
        <p>{activity?.blockedReason || (activity?.busy ? '正在阅读或整理' : '等待合适的活动机会')}</p>
        <p className="social-note">今日额度已用 {Number(activity?.tokens || 0).toLocaleString()} / {Number(activity?.dailyTokens || 30000).toLocaleString()} Token；
          其中未知用量保守计入 {Number(activity?.unknownTokens || 0).toLocaleString()}，在途预留 {Number(activity?.reservedTokens || 0).toLocaleString()}。</p>
        <p className="social-note">唤醒 {activity?.wakes || 0} / {activity?.maxWakes || 3} 次 · 待看 {activity?.pending || 0} 条 · 最早再看：{date(activity?.nextWakeAt)}</p>
        <p className="social-note">{activity?.lastOutcome || '尚无自主活动'}。输入、输出、思考和重试均计入；前台聊天用量另计。</p>
        <details><summary>近期活动</summary>{(activity?.logs || []).map((log, i) => <p key={`${log.at}-${i}`} className="social-note">{date(log.at)} · {log.detail}{log.tokens !== undefined ? ` · ${log.tokens} Token${log.unknown ? '（含未知预留）' : ''}` : ''}</p>)}</details>
      </section>
    </div>
    <h3>公开见闻与当前会话经历 <small>共 {data?.total || 0} 条</small></h3>
    {!(data?.experiences.length) && <p className="social-note">还没有值得留下的经历。阅读失败、未发送的草稿不会成为已完成的交流。</p>}
    <div className="pippi-experiences">{(data?.experiences || []).map(e => <article key={e.id}>
      <small>{date(e.createdAt)} · {e.scope}{e.corrected ? ' · 已校正' : ''}</small>
      {editing?.id === e.id ? <><Textarea label="实际经历" value={editing.fact} maxLength={200} onChange={event => setEditing({ ...editing, fact: event.target.value })} />
        <Textarea label="Pippi 的看法（可空，合计不超过200字）" value={editing.impression} maxLength={200} onChange={event => setEditing({ ...editing, impression: event.target.value })} />
        <Button disabled={busy} onClick={() => mutate(async () => { await api(`/api/social/self/experiences/${e.id}`, { method: 'PATCH', body: { revision: editing.revision, fact: editing.fact, impression: editing.impression } }); setEditing(null); })}>保存校正</Button>
        <Button onClick={() => setEditing(null)}>取消</Button></> : <><p>{e.fact}</p>{e.impression && <p className="social-note">她的看法：{e.impression}</p>}
        <Button size="sm" disabled={busy} onClick={() => setEditing({ id: e.id, revision: e.revision, fact: e.fact, impression: e.impression })}>校正</Button>
        <Button size="sm" disabled={busy} onClick={() => mutate(() => api(`/api/social/self/experiences/${e.id}`, { method: 'DELETE', body: { revision: e.revision } }))}>忘记</Button></>}
      <details><summary>来源与分享记录</summary>{e.sources.map(s => <p className="social-note" key={s.id}>{s.kind === 'reading'
        ? <a href={s.url} target="_blank" rel="noreferrer">{s.title || s.url}</a> : `实际消息 ${s.id}`} · {date(s.at)}</p>)}
        {e.shared.length ? e.shared.map(s => <p className="social-note" key={s.scope}>已分享：{s.scope} · {date(s.at)}</p>) : <p className="social-note">尚未记录实际分享。</p>}</details>
    </article>)}</div>
    {Boolean(data?.total > 30) && <div className="pippi-pages"><Button disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - 30))}>上一页</Button>
      <span>{Math.floor(offset / 30) + 1} / {Math.ceil(data.total / 30)}</span><Button disabled={busy || offset + 30 >= data.total} onClick={() => setOffset(offset + 30)}>下一页</Button></div>}
  </Card>;
}
