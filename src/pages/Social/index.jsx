import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Heart, MessageCircle, RefreshCw, Trophy, Undo2 } from 'lucide-react';
import { api } from '../../lib/api.js';
import { Button, Card, Input, Select, Switch, Textarea } from '../../components/ui/index.jsx';
import './social.css';
import { SelfPanel } from './SelfPanel.jsx';

const actions = { pass: '略过', wait: '等一句', react: '轻回应', reply: '回答' };
const stages = { assessment: '语义判断', wait: '等待后续', revalidation: '发送前复核', guard: '参与限制', failure: '调用失败', delivery: '发送结果' };
const engagements = { direct: '明确提及', continuation: '对话延续', ambient: '主动加入' };
const modes = { natural: '自然群友', light: '轻度参与', mention: '仅提及', silent: '静默', osu: '仅 osu! 指令', private: 'Owner 私聊' };
const date = (value) => value ? new Date(value).toLocaleString('zh-CN') : '尚无记录';
const score = (person) => person?.affinity.kind === 'owner' ? '特殊' : `${Number(person?.affinity.score ?? 50).toFixed(1)}`;

export function SocialPage({ db, saveSettings, refreshState }) {
  const scopes = (db.groups || []).map((g) => ({ value: `group:${g.groupId}`, label: g.name || g.groupId }));
  if (db.settings.ownerQq) scopes.push({ value: `private:${db.settings.ownerQq}`, label: 'Owner 私聊' });
  const [scope, setScope] = useState(scopes[0]?.value || '');
  const [selected, setSelected] = useState('');
  const [rankScope, setRankScope] = useState(scopes[0]?.value.startsWith('private:') ? 'global' : 'conversation');
  const [search, setSearch] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [names, setNames] = useState('');
  const [style, setStyle] = useState('');
  const [editing, setEditing] = useState(false);
  const [editRevision, setEditRevision] = useState(0);
  const [budget, setBudget] = useState(db.settings.socialMaxAssessmentsPerHour || 60);
  const requestRef = useRef(null);
  const load = useCallback(async () => {
    if (!scope) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const result = await api(`/api/social?scope=${encodeURIComponent(scope)}&userId=${encodeURIComponent(selected)}&rankScope=${rankScope}`, { signal: controller.signal, timeoutMs: 15000 });
      if (!controller.signal.aborted) { setData(result); setError(''); }
    } catch (cause) { if (!controller.signal.aborted) setError(cause.message); }
  }, [scope, selected, rankScope]);
  useEffect(() => { void load(); return () => requestRef.current?.abort(); }, [load, db.socialV2Summary?.revision]);
  useEffect(() => { setEditing(false); }, [scope, selected]);
  const mutate = async (work) => {
    setBusy(true); setError('');
    try { await work(); await load(); await refreshState(); }
    catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  const person = data?.people.find((p) => p.userId === selected);
  const people = (data?.people || []).filter((p) => `${p.nickname} ${p.userId}`.toLowerCase().includes(search.toLowerCase()));
  const ranked = (data?.ranking?.entries || []).filter((p) => `${p.nickname} ${p.userId}`.toLowerCase().includes(search.toLowerCase()));
  const feedback = Object.fromEntries((data?.feedback || []).map((f) => [f.decisionId, f.verdict]));

  return <div className="social-page">
    <div className="social-heading"><div><span className="social-eyebrow">PIPPI · V2.0</span><h1>接话与好感</h1><p>听懂对话，记住相处的感觉。</p></div>
      <Button icon={RefreshCw} onClick={load} disabled={busy}>刷新</Button></div>
    <Card className="social-settings">
      <Switch checked={db.settings.socialV2Enabled === true} disabled={busy} label="V2 自然接话与关系" description="在现有群聊模式内运行；关闭后仅回应明确提及，保留关系记录。"
        onChange={(e) => { const enabled = e.target.checked; void mutate(() => saveSettings({ socialV2Enabled: enabled })); }} />
      <div className="social-budget"><Input label="每会话每小时评估预算" type="number" min="1" max="300" value={budget} onChange={(e) => setBudget(e.target.value)} />
        <Button disabled={busy} onClick={() => mutate(() => saveSettings({ socialMaxAssessmentsPerHour: Number(budget) }))}>保存预算</Button></div>
      <p>最近一小时：{data?.usage.calls || 0} 次社交判断 · {data?.usage.tokens || 0} tokens。回复生成和工具调用另计。</p>
    </Card>
    {error && <div className="social-error" role="alert">{error}</div>}
    <div className="social-filters"><Select label="会话" value={scope} options={scopes} onChange={(e) => { setScope(e.target.value); setSelected(''); setData(null); }} />
      <Input label="查找成员" placeholder="昵称或 QQ" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
    <SelfPanel db={db} scope={scope} saveSettings={saveSettings} refreshState={refreshState} />
    <Card className="social-ranking">
      <div className="social-ranking-heading"><div><h2><Trophy size={18} /> 好感排名</h2><p className="social-note">{data?.ranking?.total ?? 0} 位普通成员 · 同分并列 · 好感为全局数值</p></div>
        <Select label="排名范围" value={rankScope} options={[{ value: 'conversation', label: '本会话' }, { value: 'global', label: '全局' }]}
          onChange={(e) => { setRankScope(e.target.value); setData(null); }} /></div>
      {data?.ranking?.owner && <div className="social-ranking-owner"><strong>Owner</strong><span>{data.ranking.owner.userId}</span><b className="social-special">特殊</b><small>不参与数值排名</small></div>}
      <div className="social-ranking-list" aria-label="好感排名列表">
        {ranked.map((p) => <button key={p.userId} className={`social-ranking-row ${selected === p.userId ? 'is-selected' : ''}`} onClick={() => setSelected(p.userId)}>
          <b className={p.rank <= 3 ? 'social-ranking-leading' : ''}>{p.rank}</b><span><strong>{p.nickname}</strong><small>{p.userId}</small></span><b>{p.score.toFixed(1)}</b>
        </button>)}
        {!ranked.length && <p className="social-empty">{search ? '没有匹配的排名成员。' : '这个范围还没有普通成员的关系记录。'}</p>}
      </div>
      <p className="social-note">本会话只列出在这里已有关系记录的人。{data?.ranking && data.ranking.total > data.ranking.entries.length ? `当前显示前 ${data.ranking.entries.length} 人。` : ''} QQ 查询：<code>/w 好感榜 [全局]</code>，仅 Owner 可用。</p>
    </Card>
    <div className="social-columns">
      <Card className="social-members"><h2><Heart size={18} /> 相处的感觉</h2>
        {!people.length && <p className="social-empty">还没有关系记录。启用后，模型会从真实互动开始判断。</p>}
        <button className={`social-member ${!selected ? 'is-selected' : ''}`} onClick={() => setSelected('')}>全部成员<span>查看本会话接话</span></button>
        {people.map((p) => <button key={p.userId} className={`social-member ${selected === p.userId ? 'is-selected' : ''}`} onClick={() => setSelected(p.userId)}>
          <span><strong>{p.nickname}</strong><small>{p.userId}</small></span><b className={p.affinity.kind === 'owner' ? 'social-special' : ''}>{score(p)}</b>
          {p.affinity.kind !== 'owner' && <span className="social-meter"><i style={{ width: `${p.affinity.score}%` }} /></span>}
        </button>)}
      </Card>
      <div className="social-detail">
        {person && <Card className="social-person"><div className="social-person-title"><h2>{person.nickname}</h2><strong>{score(person)}{person.affinity.kind !== 'owner' && <small> / 100</small>}</strong></div>
          <p>{person.affinity.kind === 'owner' ? '稳定亲近与重视。最近情绪可以变化，指令权限始终独立。' : '好感由互动中的感受变化；熟悉程度记录相处积累。'} 熟悉程度 {person.familiarity.toFixed(1)}。</p>
          <div className="social-mood"><span>最近情绪</span><strong>{person.view?.mood.label || '尚未判断'}</strong><p>{person.view?.mood.reason || '此会话暂无情绪依据。'}</p><small>{date(person.view?.mood.updatedAt)}</small></div>
          <p>{person.view?.summary || '此会话暂无关系摘要。'}</p>
          {person.view?.lastReason && <p className="social-note">最近判断：{person.view.lastReason} · {date(person.view.lastEvaluatedAt)}</p>}
          <dl><dt>已接受称呼</dt><dd>{person.view?.preferredNames.join('、') || '按正常昵称称呼'}</dd><dt>表达偏好</dt><dd>{person.view?.style || '随当前语境自然表达'}</dd></dl>
          {editing ? <div className="social-editor"><Input label="已接受称呼（逗号分隔，最多三个）" value={names} onChange={(e) => setNames(e.target.value)} />
            <Textarea label="表达偏好" value={style} maxLength={200} onChange={(e) => setStyle(e.target.value)} />
            <Button disabled={busy} onClick={() => mutate(async () => { await api('/api/social/preferences', { method: 'PATCH', body: { userId: selected, scope,
              revision: editRevision, preferredNames: names.split(/[,，]/).map((v) => v.trim()).filter(Boolean), style } }); setEditing(false); })}>保存校正</Button>
            <Button onClick={() => setEditing(false)}>取消</Button></div>
            : <Button disabled={busy || !person.view} onClick={() => { setNames(person.view.preferredNames.join('，')); setStyle(person.view.style); setEditRevision(person.view.revision); setEditing(true); }}>校正称呼与偏好</Button>}
        </Card>}
        <Card className="social-decisions"><h2><MessageCircle size={18} /> 接话记录</h2>
          <p className="social-note">当前生效：{modes[data?.participation?.mode] || '读取中'}{data?.participation?.reason ? ` · ${data.participation.reason}` : ''}</p>
          <p className="social-note">最近主动接话判断：{date(data?.activity?.lastAssessmentAt)} · 最近主动发言：{date(data?.activity?.lastReplyAt)}</p>
          <p className="social-note">近一小时：{(data?.activity?.reasons || []).map(({ reason, count }) => `${reason.includes(':') ? `${stages[reason.split(':')[0]] || reason}·${actions[reason.split(':')[1]] || ''}` : reason} ${count} 次`).join('；') || '尚无记录'}</p>
          {!(data?.decisions.length) && <p className="social-empty">本会话暂无 V2 判断。</p>}
          {(data?.decisions || []).slice(0, 30).map((d) => <article key={d.id} className="social-decision"><div><b className={`social-action social-action-${d.action}`}>{actions[d.action]}</b><small>{date(d.createdAt)} · {d.userId}</small></div>
            <p>{d.reason}</p><small>{stages[d.stage] || d.stage}{d.engagement ? ` · ${engagements[d.engagement]}` : ''} · {d.durationMs} ms · {d.totalTokens} tokens{d.evidenceIds.length ? ` · 依据 ${d.evidenceIds.join('、')}` : ''}</small>
            <div className="social-feedback">{[['should-reply', '应该接话'], ['should-pass', '不该接话']].map(([verdict, label]) => <Button key={verdict} size="sm" disabled={busy} variant={feedback[d.id] === verdict ? 'primary' : 'ghost'}
              onClick={() => mutate(() => api('/api/social/feedback', { method: 'POST', body: { decisionId: d.id, verdict } }))}>{label}</Button>)}</div>
          </article>)}<p className="social-note">反馈留作校准依据，不会立即改写人设或给成员加减分。</p>
        </Card>
        <Card className="social-history"><h2>关系变化</h2>
          {!(data?.transitions.length) && <p className="social-empty">还没有保存的变化。</p>}
          {(data?.transitions || []).slice(0, 25).map((t) => <article key={t.id}><div><b>{t.userId} · {score(t.before.person)} → {score(t.after.person)}</b><small>{date(t.createdAt)}</small></div><p>{t.reason}</p>
            <Button icon={Undo2} size="sm" disabled={busy} onClick={() => mutate(() => api('/api/social/revert', { method: 'POST', body: { transitionId: t.id } }))}>撤销这次变化</Button></article>)}
        </Card>
        <Card className="social-directives"><h2>Owner 长期指令</h2><p>使用 QQ 指令 <code>/w 指令 set 名称 内容</code> 保存；<code>/w 指令 revoke 名称</code> 撤销。只作用于当前会话。</p>
          {(data?.directives || []).map((d) => <p key={d.id}><strong>{d.key} · v{d.version}</strong> {d.text}</p>)}
          <p className="social-note">好感查询：<code>/w 好感度 [@成员或QQ]</code>，仅真实 Owner 可用。</p>
        </Card>
      </div>
    </div>
  </div>;
}
