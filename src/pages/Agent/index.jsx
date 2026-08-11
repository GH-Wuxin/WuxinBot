import React, { useEffect, useState } from 'react';
import { Bot, Braces, MessageSquareText, Play, UserRound } from 'lucide-react';
import {
  Button,
  Card,
  EmptyState,
  InlineHelp,
  Input,
  Pill,
  SectionHeader,
  Select,
  Switch,
  Textarea,
} from '../../components/ui/index.jsx';
import { api } from '../../lib/api.js';

const policyOptions = [
  { value: '', label: '按真实配置' },
  { value: 'normal', label: '正常' },
  { value: 'whitelist', label: '优先回应' },
  { value: 'priority', label: '重点关注' },
  { value: 'muted', label: '少回应' },
  { value: 'blocked', label: '不回应' },
  { value: 'admin', label: '管理员' },
  { value: 'owner', label: '所有者' },
];

const modeOptions = [
  { value: '', label: '按真实配置' },
  { value: 'silent', label: '静默' },
  { value: 'mention', label: '只在 @ 时回复' },
  { value: 'light', label: '轻度参与' },
  { value: 'natural', label: '自然群友' },
];

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
  const displayUserLabel = (user) => {
    if (user.nickname && user.nickname !== String(user.userId)) return `${user.nickname} (${user.userId})`;
    const messages = (db.messages || []).filter((message) => String(message.userId) === String(user.userId) && message.nickname && message.nickname !== String(user.userId));
    if (messages.length) return `${messages[messages.length - 1].nickname} (${user.userId})`;
    const memory = (db.memories || []).find((entry) => String(entry.userId) === String(user.userId) && entry.nickname && entry.nickname !== String(user.userId));
    return memory ? `${memory.nickname} (${user.userId})` : `QQ ${user.userId}`;
  };

  const run = async () => {
    setRunning(true);
    setResult(null);
    setError('');
    try {
      const data = await api('/api/sandbox', {
        method: 'POST',
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

  return <div className="console-page agent-page">
    <SectionHeader eyebrow="Runtime / Agent" title="决策沙盒" description="用真实群配置和上下文检查一次消息会如何进入回复决策；只有开启模型生成时才会调用 LLM。" />
    <div className="console-split console-split--agent">
      <Card className="console-section">
        <div className="console-section__title"><MessageSquareText size={18} /><div><h3>模拟消息</h3><p>输入发言人、消息和临时覆盖条件。</p></div></div>
        <div className="console-form-grid">
          <Select label="群聊" value={groupId} onChange={(event) => setGroupId(event.target.value)} options={groups.length ? groups.map((group) => ({ value: String(group.groupId), label: group.name || String(group.groupId) })) : [{ value: '', label: '无群' }]} />
          <Select label="发言人" value={userId} onChange={(event) => { setNicknameDirty(false); setUserId(event.target.value); }} options={[{ value: '', label: '自定义…' }, ...groupUsers.map((user) => ({ value: String(user.userId), label: displayUserLabel(user) }))]} />
          <Input label="昵称" placeholder="可手动填写" value={nickname} onChange={(event) => { setNicknameDirty(true); setNickname(event.target.value); }} />
          <Input label="QQ 号" placeholder="可手动填写" value={userId} onChange={(event) => setUserId(event.target.value)} />
        </div>
        <Textarea label="消息内容" rows={4} value={text} onChange={(event) => setText(event.target.value)} />
        <div className="agent-context-grid">
          <Switch label="@ 机器人" checked={atBot} onChange={(event) => setAtBot(event.target.checked)} />
          <Switch label="个人画像" checked={useMemory} onChange={(event) => setUseMemory(event.target.checked)} />
          <Switch label="群画像" checked={useGroupProfile} onChange={(event) => setUseGroupProfile(event.target.checked)} />
          <Switch label="关系画像" checked={useRelationship} onChange={(event) => setUseRelationship(event.target.checked)} />
          <Switch label="生成回复" description="会调用当前模型" checked={callLlm} onChange={(event) => setCallLlm(event.target.checked)} />
        </div>
        <div className="console-form-grid">
          <Select label="临时成员策略" value={memberPolicy} onChange={(event) => setMemberPolicy(event.target.value)} options={policyOptions} />
          <Select label="临时群模式" value={groupMode} onChange={(event) => setGroupMode(event.target.value)} options={modeOptions} />
        </div>
        {error && <InlineHelp tone="danger">运行失败：{error}</InlineHelp>}
        <div className="console-actions console-actions--end"><Button variant="primary" icon={Play} loading={running} onClick={run}>{running ? '分析中…' : '运行沙盒分析'}</Button></div>
      </Card>

      <Card className="console-section agent-result">
        <div className="console-section__title"><Bot size={18} /><div><h3>运行结果</h3><p>决策、注入上下文与可选回复预览。</p></div></div>
        {!result ? <EmptyState title="等待一次沙盒运行" description="这里不会使用伪造示例。运行后展示真实 /api/sandbox 返回。" /> : <div className="agent-result__body">
          <div className="agent-result__decision">
            <Pill tone={result.decision?.shouldReply ? 'success' : 'warning'}>{result.decision?.shouldReply ? '会回复' : '不回复'}</Pill>
            <strong>{result.decision?.reason || '未返回原因'}</strong>
          </div>
          {result.context && <div className="console-kv-list">
            <div><span>群 / 策略</span><strong>{result.context.group} · {result.context.userPolicy}</strong></div>
            {result.context.memoryProfile && <div><span>个人画像</span><strong>{result.context.memoryProfile.summary || '已注入'}</strong></div>}
            {result.context.groupProfile && <div><span>群画像</span><strong>{result.context.groupProfile.atmosphere || '已注入'} · {Math.round((result.context.groupProfile.confidence || 0) * 100)}%</strong></div>}
            {result.context.relationshipProfiles?.length > 0 && <div><span>关系画像</span><strong>{result.context.relationshipProfiles.map((entry) => `${entry.pair} ${entry.style}`).join(' · ')}</strong></div>}
          </div>}
          {result.replyPreview && <section className="agent-result__reply"><span>回复预览</span><p>{result.replyPreview}</p></section>}
          {result.usage && <InlineHelp>Token {result.usage.total_tokens || 0}（输入 {result.usage.prompt_tokens || 0} / 输出 {result.usage.completion_tokens || 0}）</InlineHelp>}
          {result.promptPreview && <div className="agent-result__prompt"><Button size="sm" icon={Braces} onClick={() => setShowPrompt((value) => !value)}>{showPrompt ? '收起 Prompt' : '查看 Prompt'}</Button>{showPrompt && <pre>{result.promptPreview}</pre>}</div>}
        </div>}
      </Card>
    </div>
  </div>;
}
