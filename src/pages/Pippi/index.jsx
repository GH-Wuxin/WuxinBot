import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, BookOpen, Eye, Heart, MessageCircle, RefreshCw, Users } from 'lucide-react';
import { api } from '../../lib/api.js';
import { Button, Card, Select } from '../../components/ui/index.jsx';
import './pippi.css';

const actions = { pass: '略过', wait: '等一句', react: '轻回应', reply: '回答' };
const stages = { assessment: '语义判断', wait: '等待后续', revalidation: '发送前复核', guard: '参与限制', failure: '调用失败', delivery: '发送结果' };
const modes = { natural: '自然群友', light: '轻度参与', mention: '仅提及', silent: '静默', osu: '仅 osu! 指令', private: 'Owner 私聊' };
const date = (value) => value ? new Date(value).toLocaleString('zh-CN') : '尚无记录';
const number = (value) => Number(value || 0).toLocaleString('zh-CN');
const score = (person) => person?.affinity?.kind === 'owner' ? '特殊' : Number(person?.affinity?.score ?? 50).toFixed(1);

function Empty({ children }) { return <p className="pippi-empty">{children}</p>; }
function Chip({ children }) { return <span className="pippi-chip">{children}</span>; }
function Stat({ label, value }) { return <div className="pippi-stat"><span>{label}</span><strong>{value}</strong></div>; }

export function PippiPage({ db, onNavigate }) {
  const groups = db?.groups || [];
  const [groupId, setGroupId] = useState(String(groups[0]?.groupId || ''));
  const [userId, setUserId] = useState('');
  const [tab, setTab] = useState('overview');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const requestRef = useRef(null);

  const load = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy(true);
    try {
      const query = new URLSearchParams();
      if (groupId) query.set('groupId', groupId);
      if (userId) query.set('userId', userId);
      const result = await api(`/api/pippi/overview?${query.toString()}`, { signal: controller.signal, timeoutMs: 15000 });
      if (!controller.signal.aborted) {
        setData(result);
        setError('');
        if (!groupId && result.selected?.groupId) setGroupId(result.selected.groupId);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause.message);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }, [groupId, userId]);

  useEffect(() => { void load(); return () => requestRef.current?.abort(); }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void load();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [load]);

  const options = (data?.groups || groups).map((group) => ({
    value: String(group.groupId),
    label: group.name || group.groupId,
  }));
  const self = data?.self;
  const selected = data?.selected;
  const presence = selected?.presence;
  const ranking = selected?.ranking?.entries || [];
  const experiences = selected?.experiences || [];
  const decisions = selected?.decisions || [];
  const overviewDecisions = decisions.filter((decision) => decision.stage !== 'guard').slice(0, 5);
  const transitions = selected?.transitions || [];
  const directives = selected?.directives || [];
  const person = selected?.person;
  const peopleNames = { ...(selected?.names || {}), ...Object.fromEntries((selected?.people || []).map((entry) => [entry.userId, entry.nickname])) };

  const chooseGroup = (value) => {
    setGroupId(value);
    setUserId('');
    setData(null);
  };
  const choosePerson = (value) => {
    setUserId(value);
    setTab('relationships');
  };

  return <div className="pippi-page">
    <header className="pippi-heading">
      <div>
        <span className="pippi-eyebrow">PIPPI · PERSONA</span>
        <h1>Pippi</h1>
        <p>她是谁、看到了什么、和谁怎么样。</p>
      </div>
      <div className="pippi-heading-actions">
        <Select label="群聊" value={groupId} options={options} onChange={(event) => chooseGroup(event.target.value)} />
        <Button icon={RefreshCw} onClick={load} disabled={busy}>刷新</Button>
      </div>
    </header>

    {error && <div className="pippi-error" role="alert">{error}</div>}

    {!data && <Card className="pippi-card"><p className="pippi-note">正在读取 Pippi 的状态…</p></Card>}

    {data && <>
    <Card className="pippi-now">
      <div className="pippi-now-main">
        <div className="pippi-mood">
          <span>全局心情</span>
          <strong>{self?.mood?.label || '平静'}</strong>
          <p>{self?.mood?.reason || '还没有新的心情记录。'}</p>
          <small>{date(self?.mood?.updatedAt)}</small>
        </div>
        <div className="pippi-stats">
          <Stat label="精力" value={`${self?.energy ?? 0}/100`} />
          <Stat label="兴趣" value={`${self?.interest ?? 0}/100`} />
          <Stat label="在意" value={self?.focus?.length || 0} />
        </div>
      </div>
      <div className="pippi-identity-row">
        {data?.identity?.model ? <Chip>{data.identity.model}</Chip> : null}
        <Chip>{data?.identity?.presenceEnabled ? '常驻感知开启' : '常驻感知关闭'}</Chip>
        {data?.identity?.selfQq ? <Chip>QQ {data.identity.selfQq}</Chip> : null}
      </div>
      <div className="pippi-focus-row">
        {(self?.focus || []).slice(-4).map((item, index) => <Chip key={index}>{item}</Chip>)}
        {!self?.focus?.length && <span className="pippi-note">暂时没有特别在意的事。</span>}
      </div>
    </Card>

    <nav className="pippi-tabs" aria-label="Pippi 页面">
      {[['overview', '总览'], ['relationships', '关系'], ['experiences', '经历'], ['perception', '感知'], ['decisions', '接话']].map(([key, label]) =>
        <button type="button" key={key} className={'pippi-tab' + (tab === key ? ' is-active' : '')} onClick={() => setTab(key)}>{label}</button>)}
    </nav>

    {tab === 'overview' && <div className="pippi-grid">
      <Card className="pippi-card pippi-span-2">
        <h2><Eye size={18} /> 她看到了什么</h2>
        {(selected?.context?.topics || []).length > 0 && <div className="pippi-topic-row">
          {selected.context.topics.slice(0, 4).map((topic, index) => <Chip key={index}>{topic}</Chip>)}
        </div>}
        {(presence?.recent || []).slice(-4).reverse().map((item, index) => <div className="pippi-event" key={index}>
          <p>{item.noticed}</p>
          <small>{date(item.createdAt)} · 显著度 {Math.round(Number(item.salience || 0) * 100)}%</small>
        </div>)}
        {!presence?.recent?.length && <Empty>还没有足够的群消息观察。</Empty>}
        {presence?.openThreads?.length > 0 && <div className="pippi-subblock">
          <h3>未完成话题</h3>
          {presence.openThreads.slice(-3).map((thread) => <p key={thread.id}>· {thread.topic}{thread.note ? `（${thread.note}）` : ''}</p>)}
        </div>}
      </Card>

      <Card className="pippi-card">
        <h2><Heart size={18} /> 关系速览</h2>
        {ranking.slice(0, 5).map((entry, index) => <button type="button" className="pippi-list-row" key={entry.userId} onClick={() => choosePerson(entry.userId)}>
          <b>{index + 1}</b><span>{entry.nickname}<small>{entry.userId}</small></span><strong>{Number(entry.score).toFixed(1)}</strong>
        </button>)}
        {!ranking.length && <Empty>还没有关系记录。</Empty>}
      </Card>

      <Card className="pippi-card">
        <h2><BookOpen size={18} /> 最近经历</h2>
        {experiences.slice(0, 3).map((experience) => <div className="pippi-event" key={experience.id}>
          <p>{experience.fact}</p>
          {experience.impression && <small>她的看法：{experience.impression}</small>}
          <small>{date(experience.createdAt)} · {experience.scope}</small>
        </div>)}
        {!experiences.length && <Empty>还没有值得留下的经历。</Empty>}
      </Card>

      <Card className="pippi-card pippi-span-2">
        <h2><MessageCircle size={18} /> 最近接话</h2>
        {(overviewDecisions.length ? overviewDecisions : decisions.slice(0, 3)).map((decision) => <div className="pippi-event" key={decision.id}>
          <div className="pippi-event-head">
            <span className={`pippi-action pippi-action-${decision.action}`}>{actions[decision.action] || decision.action}</span>
            <small>{date(decision.createdAt)}</small>
          </div>
          <p>{decision.reason}</p>
          <small>{stages[decision.stage] || decision.stage}{decision.engagement ? ` · ${decision.engagement}` : ''}</small>
        </div>)}
        {!decisions.length && <Empty>还没有接话判断。</Empty>}
      </Card>
    </div>}

    {tab === 'relationships' && <div className="pippi-columns">
      <Card className="pippi-card pippi-list-card">
        <h2><Users size={18} /> 好感排名</h2>
        <p className="pippi-note">{selected?.ranking?.total ?? 0} 位普通成员 · 同分并列 · 好感为全局数值</p>
        <div className="pippi-list-scroll">
          {ranking.map((entry) => <button type="button" className={'pippi-list-row' + (person?.userId === entry.userId ? ' is-selected' : '')}
            key={entry.userId} onClick={() => setUserId(entry.userId)}>
            <b>{entry.rank}</b><span>{entry.nickname}<small>{entry.userId}</small></span><strong>{Number(entry.score).toFixed(1)}</strong>
          </button>)}
          {!ranking.length && <Empty>这个群还没有关系记录。</Empty>}
        </div>
      </Card>

      <Card className="pippi-card">
        {person ? <>
          <div className="pippi-detail-head">
            <div><h2>{person.nickname}</h2><small>{person.userId}</small></div>
            <strong>{score(person)}</strong>
          </div>
          <p className="pippi-note">熟悉程度 {Number(person.familiarity || 0).toFixed(1)} · 好感 {score(person)} · 本群已有 {selected?.ranking?.total || 0} 位成员记录</p>
          <div className="pippi-mood-box">
            <span>最近情绪</span>
            <strong>{person.view?.mood?.label || '尚未判断'}</strong>
            <p>{person.view?.mood?.reason || '此会话暂无情绪依据。'}</p>
            <small>{date(person.view?.mood?.updatedAt)}</small>
          </div>
          <p>{person.view?.summary || '此会话暂无关系摘要。'}</p>
          {person.view?.lastReason && <p className="pippi-note">最近判断：{person.view.lastReason} · {date(person.view.lastEvaluatedAt)}</p>}
          <dl className="pippi-dl">
            <dt>已接受称呼</dt><dd>{person.view?.preferredNames?.join('、') || '按正常昵称称呼'}</dd>
            <dt>表达偏好</dt><dd>{person.view?.style || '随当前语境自然表达'}</dd>
          </dl>
        </> : <Empty>从左侧选择一位成员，查看 Pippi 对这个人的关系状态。</Empty>}
      </Card>
    </div>}

    {tab === 'experiences' && <div className="pippi-grid">
      <Card className="pippi-card">
        <h2><Activity size={18} /> 最近的内心</h2>
        <div className="pippi-mood-box">
          <span>交流后的心情</span>
          <strong>{self?.socialMood?.label || '还没有记录'}</strong>
          <p>{self?.socialMood?.reason || '还没有新的交流心情。'}</p>
        </div>
        <h3>最近关注</h3>
        {(self?.socialFocus || []).map((focus) => <p className="pippi-note" key={focus.id}>· {focus.text}<small> · {focus.scope}</small></p>)}
        {!self?.socialFocus?.length && <Empty>没有未完的关注。</Empty>}
      </Card>

      <Card className="pippi-card">
        <h2><BookOpen size={18} /> 自主活动</h2>
        <p>{self?.activity?.blockedReason || (self?.activity?.busy ? '正在阅读或整理' : '等待合适的活动机会')}</p>
        <p className="pippi-note">今日已用 {number(self?.activity?.tokens)} / {number(self?.activity?.dailyTokens)} Token · 唤醒 {self?.activity?.wakes || 0}/{self?.activity?.maxWakes || 0}</p>
        <p className="pippi-note">{self?.activity?.lastOutcome || '尚无自主活动'}</p>
      </Card>

      <Card className="pippi-card pippi-span-2">
        <h2><BookOpen size={18} /> 最近的经历 <small>共 {selected?.experienceTotal || 0} 条</small></h2>
        {experiences.map((experience) => <article className="pippi-experience" key={experience.id}>
          <p>{experience.fact}</p>
          {experience.impression && <p className="pippi-note">她的看法：{experience.impression}</p>}
          <small>{date(experience.createdAt)} · {experience.scope}{experience.corrected ? ' · 已校正' : ''}</small>
        </article>)}
        {!experiences.length && <Empty>还没有值得留下的经历。</Empty>}
      </Card>
    </div>}

    {tab === 'perception' && <div className="pippi-grid">
      <Card className="pippi-card pippi-span-2">
        <h2><Eye size={18} /> 群聊感知</h2>
        <div className="pippi-stats">
          <Stat label="观察" value={presence?.observations || 0} />
          <Stat label="人物" value={presence?.people || 0} />
          <Stat label="未完成话题" value={presence?.threads || 0} />
          <Stat label="群梗" value={presence?.culture || 0} />
        </div>
      </Card>

      <Card className="pippi-card">
        <h2>最近观察</h2>
        {(presence?.recent || []).slice(-5).reverse().map((item, index) => <div className="pippi-event" key={index}>
          <p>{item.noticed}</p>
          <small>{date(item.createdAt)} · {item.topic || '未分类'}</small>
        </div>)}
        {!presence?.recent?.length && <Empty>还没有观察记录。</Empty>}
      </Card>

      <Card className="pippi-card">
        <h2>未完成话题</h2>
        {(presence?.openThreads || []).map((thread) => <div className="pippi-event" key={thread.id}>
          <p>{thread.topic}</p>
          {thread.note && <small>{thread.note}</small>}
        </div>)}
        {!presence?.openThreads?.length && <Empty>没有未完成话题。</Empty>}
      </Card>

      <Card className="pippi-card">
        <h2>群里的梗 / 习惯</h2>
        {(presence?.cultureDetails || []).map((item) => <div className="pippi-event" key={item.phrase}>
          <p>{item.phrase}</p>
          {item.meaning && <small>{item.meaning}</small>}
        </div>)}
        {!presence?.cultureDetails?.length && <Empty>还没有形成群文化记录。</Empty>}
      </Card>

      <Card className="pippi-card">
        <h2>人物印象</h2>
        {(presence?.peopleDetails || []).map((entry) => <div className="pippi-event" key={entry.userId}>
          <div className="pippi-event-head"><strong>{peopleNames[entry.userId] || entry.userId}</strong><small>温暖 {entry.warmth} · 熟悉 {entry.familiarity}</small></div>
          <p>{entry.impression || '还没有形成印象。'}</p>
        </div>)}
        {!presence?.peopleDetails?.length && <Empty>还没有人物印象。</Empty>}
      </Card>
    </div>}

    {tab === 'decisions' && <div className="pippi-grid">
      <Card className="pippi-card pippi-span-2">
        <h2><MessageCircle size={18} /> 接话记录</h2>
        <p className="pippi-note">当前模式：{modes[selected?.participation?.mode] || selected?.participation?.mode || '读取中'}
          {selected?.participation?.reason ? ` · ${selected.participation.reason}` : ''}</p>
        {decisions.map((decision) => <div className="pippi-event" key={decision.id}>
          <div className="pippi-event-head">
            <span className={`pippi-action pippi-action-${decision.action}`}>{actions[decision.action] || decision.action}</span>
            <small>{date(decision.createdAt)} · {peopleNames[decision.userId] || decision.userId}</small>
          </div>
          <p>{decision.reason}</p>
          <small>{stages[decision.stage] || decision.stage} · {decision.durationMs} ms · {decision.totalTokens} tokens</small>
        </div>)}
        {!decisions.length && <Empty>本群暂无接话判断。</Empty>}
        {onNavigate && <Button onClick={() => onNavigate('social')}>打开完整接话与好感页</Button>}
      </Card>

      <Card className="pippi-card">
        <h2>关系变化</h2>
        {transitions.slice(0, 8).map((transition) => <div className="pippi-event" key={transition.id}>
          <div className="pippi-event-head">
            <strong>{peopleNames[transition.userId] || transition.userId}</strong>
            <small>{date(transition.createdAt)}</small>
          </div>
          <p>{transition.reason}</p>
        </div>)}
        {!transitions.length && <Empty>还没有保存的关系变化。</Empty>}
      </Card>

      <Card className="pippi-card">
        <h2>Owner 长期指令</h2>
        {directives.map((directive) => <div className="pippi-event" key={directive.id}>
          <p><strong>{directive.key} · v{directive.version}</strong></p>
          <small>{directive.text}</small>
        </div>)}
        {!directives.length && <Empty>本群没有长期指令。</Empty>}
      </Card>
    </div>}
    </>}
  </div>;
}
