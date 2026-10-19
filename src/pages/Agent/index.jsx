import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';

// 版式对齐原型 PAGES.agent：左侧沙盒、右侧运行配置 + 本轮工具面。
const policyOptions = [
  ['', '按真实配置'], ['normal', '正常'], ['whitelist', '优先回应'], ['priority', '重点关注'],
  ['muted', '少回应'], ['blocked', '不回应'], ['admin', '管理员'], ['owner', '所有者'],
];
const modeOptions = [
  ['', '按真实配置'], ['silent', '静默'], ['mention', '只在 @ 时回复'], ['light', '轻度参与'], ['natural', '自然群友'], ['osu', '仅 osu! 指令'],
];
const TOOL_SURFACE = ['best_score', 'best_scores', 'player', 'pp_plus', 'bp_type', 'recommend', 'beatmap', 'pp_calc', 'leaderboard', 'search_web', 'memory', 'group_profile'];

export function AgentPage({ db }) {
  const groups = db.groups || [];
  const users = db.users || [];
  const [groupId, setGroupId] = useState(groups[0]?.groupId || '');
  const [userId, setUserId] = useState('');
  const [nickname, setNickname] = useState('');
  const [nicknameDirty, setNicknameDirty] = useState(false);
  const [text, setText] = useState('小深，你觉得今天适合聊点什么？');
  const [atBot, setAtBot] = useState(false);
  const [memberPolicy, setMemberPolicy] = useState('');
  const [groupMode, setGroupMode] = useState('');
  const [useMemory, setUseMemory] = useState(true);
  const [useGroupProfile, setUseGroupProfile] = useState(true);
  const [useRelationship, setUseRelationship] = useState(true);
  const [callLlm, setCallLlm] = useState(false);
  const [result, setResult] = useState(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (nicknameDirty) return;
    const user = users.find((entry) => String(entry.userId) === String(userId));
    if (user?.nickname && user.nickname !== user.userId) setNickname(user.nickname);
  }, [userId, users, nicknameDirty]);

  const groupUserMap = {};
  for (const user of users) {
    if (String(user.groupId) === String(groupId)) groupUserMap[user.userId] = user;
  }
  for (const message of db.messages || []) {
    if (String(message.groupId) === String(groupId) && message.role === 'user' && !groupUserMap[message.userId]) {
      groupUserMap[message.userId] = { userId: message.userId, groupId, nickname: message.nickname || '', policy: 'normal' };
    }
  }
  const groupUsers = Object.values(groupUserMap);

  const run = async () => {
    setRunning(true);
    setResult(null);
    setError('');
    try {
      const data = await api('/api/sandbox', {
        method: 'POST',
        timeoutMs: callLlm ? 90000 : 20000,
        body: {
          groupId,
          userId: userId || 'sandbox-user',
          nickname: nickname || 'SandboxUser',
          text,
          atTargets: atBot ? [db.settings.selfQq || ''] : [],
          memberPolicy: memberPolicy || undefined,
          groupMode: groupMode || undefined,
          useMemory,
          useGroupProfile,
          useRelationship,
          callLlm,
        },
      });
      setResult(data);
    } catch (cause) {
      setError(cause.message || String(cause));
    } finally {
      setRunning(false);
    }
  };

  const clearAll = () => {
    setResult(null);
    setError('');
    setText('');
    setShowPrompt(false);
  };

  return <>
    <div className="page-head">
      <div><h1>Agent</h1><p>在沙盒里看它怎么想、怎么调工具，再决定要不要上线。</p></div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn btn-ghost" onClick={clearAll}>清空</button>
        <button type="button" className="btn btn-primary" disabled={running || !text.trim()} onClick={run}>{running ? '分析中…' : '运行沙盒分析'}</button>
      </div>
    </div>

    {error && <div className="note" style={{ color: 'var(--red)', marginBottom: 12 }}>运行失败：{error}</div>}

    <div className="grid grid-main" style={{ alignItems: 'start' }}>
      <div className="stack">
        <div className="card">
          <div className="card-head"><span className="card-title">模拟消息</span><span className="muted" style={{ fontSize: 12 }}>不会真的发到群里</span></div>
          <div className="field"><label>群聊</label>
            <select value={groupId} onChange={(event) => setGroupId(event.target.value)}>
              {groups.length ? groups.map((group) => <option key={group.groupId} value={String(group.groupId)}>{group.name || String(group.groupId)}</option>) : <option value="">无群</option>}
            </select>
          </div>
          <div className="field"><label>发言人</label>
            <select value={userId} onChange={(event) => { setNicknameDirty(false); setUserId(event.target.value); }}>
              <option value="">自定义…</option>
              {groupUsers.map((user) => <option key={user.userId} value={String(user.userId)}>{user.nickname && user.nickname !== String(user.userId) ? `${user.nickname} (${user.userId})` : `QQ ${user.userId}`}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div className="field" style={{ flex: 1 }}><label>昵称</label><input value={nickname} onChange={(event) => { setNicknameDirty(true); setNickname(event.target.value); }} placeholder="可手动填写" /></div>
            <div className="field" style={{ flex: 1 }}><label>QQ 号</label><input value={userId} onChange={(event) => setUserId(event.target.value)} placeholder="可手动填写" /></div>
          </div>
          <div className="field"><label>消息内容</label><textarea rows="4" value={text} onChange={(event) => setText(event.target.value)} /></div>

          <div className="rows" style={{ marginTop: 4 }}>
            {[[atBot, '@ 机器人', false], [useMemory, '个人画像', false], [useGroupProfile, '群画像', false], [useRelationship, '关系画像', false], [callLlm, '生成回复', true]].map(([value, label, isLlm]) => <div className="row" key={label}>
              <div className="row-main"><div className="row-title">{label}</div>{isLlm && <div className="row-sub">会调用当前模型</div>}</div>
              <button
                type="button"
                className={'switch' + (value ? ' is-on' : '')}
                aria-label={label}
                onClick={() => {
                  if (label === '@ 机器人') setAtBot(!atBot);
                  else if (label === '个人画像') setUseMemory(!useMemory);
                  else if (label === '群画像') setUseGroupProfile(!useGroupProfile);
                  else if (label === '关系画像') setUseRelationship(!useRelationship);
                  else setCallLlm(!callLlm);
                }}
              />
            </div>)}
          </div>

          <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
            <div className="field" style={{ flex: 1 }}><label>临时成员策略</label>
              <select value={memberPolicy} onChange={(event) => setMemberPolicy(event.target.value)}>
                {policyOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: 1 }}><label>临时群模式</label>
              <select value={groupMode} onChange={(event) => setGroupMode(event.target.value)}>
                {modeOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><span className="card-title">运行结果</span>{result?.decision && <span className={'chip ' + (result.decision.shouldReply ? 'chip--mint' : 'chip--amber')}>{result.decision.shouldReply ? '会回复' : '不回复'}</span>}</div>
          {!result ? <div className="note">还没有运行结果。填好消息后点右上角「运行沙盒分析」。</div> : <>
            <div className="kv"><span>决策原因</span><b style={{ fontWeight: 500 }}>{result.decision?.reason || '未返回原因'}</b></div>
            {result.context && <>
              <div className="kv"><span>群 / 策略</span><b>{result.context.group} · {result.context.userPolicy}</b></div>
              {result.context.memoryProfile && <div className="kv"><span>个人画像</span><b style={{ fontWeight: 500 }}>{result.context.memoryProfile.summary || '已注入'}</b></div>}
              {result.context.groupProfile && <div className="kv"><span>群画像</span><b style={{ fontWeight: 500 }}>{result.context.groupProfile.atmosphere || '已注入'} · {Math.round((result.context.groupProfile.confidence || 0) * 100)}%</b></div>}
              {result.context.relationshipProfiles?.length > 0 && <div className="kv"><span>关系画像</span><b style={{ fontWeight: 500 }}>{result.context.relationshipProfiles.map((entry) => `${entry.pair} ${entry.style}`).join(' · ')}</b></div>}
            </>}
            {result.replyPreview && <div className="log-text" style={{ marginTop: 12 }}>
              <div className="muted" style={{ fontSize: 11 }}>回复预览</div>
              {result.replyPreview}
            </div>}
            {result.usage && <div className="note" style={{ marginTop: 8 }}>Token {result.usage.total_tokens || 0}（输入 {result.usage.prompt_tokens || 0} / 输出 {result.usage.completion_tokens || 0}）</div>}
            {result.promptPreview && <div style={{ marginTop: 10 }}>
              <button type="button" className="btn btn-sm" onClick={() => setShowPrompt((value) => !value)}>{showPrompt ? '收起 Prompt' : '查看 Prompt'}</button>
              {showPrompt && <pre style={{ marginTop: 8, maxHeight: 320, overflow: 'auto', fontSize: 11, whiteSpace: 'pre-wrap', color: 'var(--muted)' }}>{result.promptPreview}</pre>}
            </div>}
          </>}
        </div>
      </div>

      <div className="stack">
        <div className="card">
          <div className="card-head"><span className="card-title">运行配置</span></div>
          <div className="kv"><span>群聊</span><b>{groups.find((group) => String(group.groupId) === String(groupId))?.name || groupId || '—'}</b></div>
          <div className="kv"><span>发言人</span><b>{nickname || userId || '自定义'}</b></div>
          <div className="kv"><span>成员策略</span><b>{memberPolicy || '按真实配置'}</b></div>
          <div className="kv"><span>群模式</span><b>{groupMode || '按真实配置'}</b></div>
          <div className="kv"><span>上下文</span><b>{[useMemory && '个人', useGroupProfile && '群', useRelationship && '关系'].filter(Boolean).join(' + ') || '不注入'}</b></div>
          <div className="kv"><span>生成回复</span><b>{callLlm ? '开启（调用模型）' : '关闭（只看决策）'}</b></div>
        </div>

        <div className="card">
          <div className="card-head"><span className="card-title">本轮工具面</span><span className="muted" style={{ fontSize: 12 }}>沙盒可见</span></div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {TOOL_SURFACE.map((name) => <span className="chip" key={name}>{name}</span>)}
          </div>
          <div className="note" style={{ marginTop: 10 }}>发图工具在第一层数据回来后才会出现。</div>
        </div>

        <div className="card">
          <div className="card-head"><span className="card-title">说明</span></div>
          <div className="note">沙盒只做决策与注入检查，不写库、不发消息。开启「生成回复」才会真正调用当前模型，耗时更长。</div>
        </div>
      </div>
    </div>
  </>;
}
