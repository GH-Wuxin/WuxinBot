import React, { useEffect, useState } from 'react';
import { Brain, RefreshCw, Save, Search, Trash2, UserRoundSearch } from 'lucide-react';
import {
  Button,
  Card,
  EmptyState,
  InlineHelp,
  Input,
  Pill,
  SectionHeader,
  Select,
  SettingGroup,
  SettingRow,
  Slider,
  Switch,
  Textarea,
} from '../../components/ui/index.jsx';
import { api } from '../../lib/api.js';

const sampleTypeLabels = { text: '真实文本', card: '分享卡片', media: '媒体', 'image-summary': '图片摘要', command: '指令', 'bot-output': '机器长文' };
const levelPpLabel = (experience) => `${Math.floor(Number(experience?.xp || 0) / 100) * 100}pp`;

export function MemoryPage({ db, saveSettings, refreshState }) {
  const [memSearch, setMemSearch] = useState('');
  const memories = [...(db.memories || [])].filter((memory) => {
    if (!memSearch.trim()) return true;
    const query = memSearch.trim().toLowerCase();
    return [memory.nickname, memory.userId, memory.summary, memory.traits, memory.manualNotes].some((value) => String(value || '').toLowerCase().includes(query));
  }).sort((left, right) => Number(right.importanceLevel || 0) - Number(left.importanceLevel || 0) || Number(right.messageCount || 0) - Number(left.messageCount || 0));
  const [selectedId, setSelectedId] = useState(memories[0]?.userId || '');
  const selected = memories.find((memory) => String(memory.userId) === String(selectedId)) || memories[0];
  const [draft, setDraft] = useState(selected || {});
  const [settingsDraft, setSettingsDraft] = useState(db.settings);
  const [profileDirty, setProfileDirty] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [recalcUserId, setRecalcUserId] = useState('');

  useEffect(() => {
    if (profileDirty) return;
    setDraft(memories.find((memory) => String(memory.userId) === String(selectedId)) || memories[0] || {});
  }, [db.memories, selectedId, profileDirty]);

  useEffect(() => {
    if (!settingsDirty) setSettingsDraft(db.settings);
  }, [db.settings, settingsDirty]);

  const updateDraft = (patch) => { setProfileDirty(true); setDraft((current) => ({ ...current, ...patch })); };
  const updateSettingsDraft = (patch) => { setSettingsDirty(true); setSettingsDraft((current) => ({ ...current, ...patch })); };

  const saveMemory = async () => {
    if (!draft.userId) return;
    await api(`/api/memories/${draft.userId}`, { method: 'POST', body: draft });
    setProfileDirty(false);
    await refreshState();
  };
  const deleteMemory = async () => {
    if (!draft.userId || !window.confirm(`删除 ${draft.nickname || draft.userId} 的长期记忆？`)) return;
    await api(`/api/memories/${draft.userId}`, { method: 'DELETE' });
    setSelectedId('');
    setProfileDirty(false);
    await refreshState();
  };
  const recalcMemory = async () => {
    if (!draft.userId || recalcUserId) return;
    if (profileDirty && !window.confirm('当前画像编辑区有未保存修改。继续重算不会包含这些修改，是否继续？')) return;
    setRecalcUserId(String(draft.userId));
    try {
      const result = await api(`/api/memories/${draft.userId}/recalculate`, { method: 'POST' });
      if (result.db) {
        setProfileDirty(false);
        await refreshState();
        const next = (result.db.memories || []).find((memory) => String(memory.userId) === String(draft.userId));
        if (next) setDraft(next);
      } else await refreshState();
      alert(`${draft.nickname || draft.userId} 画像重算完成：${result.outcome?.reason || '已完成'}`);
    } catch (cause) {
      await refreshState();
      alert(`画像重算失败：${cause.message}`);
    } finally {
      setRecalcUserId('');
    }
  };
  const saveMemorySettings = async () => {
    await saveSettings({
      memoryEnabled: settingsDraft.memoryEnabled !== false,
      memoryMinMessages: settingsDraft.memoryMinMessages,
      memoryUpdateEvery: settingsDraft.memoryUpdateEvery,
      memoryMaxChars: settingsDraft.memoryMaxChars,
      memorySampleRetain: settingsDraft.memorySampleRetain,
      visionMemoryEnabled: settingsDraft.visionMemoryEnabled !== false,
      visionMemoryPureImagePolicy: settingsDraft.visionMemoryPureImagePolicy || 'important',
    });
    setSettingsDirty(false);
    await refreshState();
  };

  return <div className="console-page memory-page">
    <SectionHeader eyebrow="Context / Memory" title="长期记忆" description="管理画像生成参数、已记录对象、人工编辑与最近样本。未保存草稿不会被全局轮询覆盖。" />
    <SettingGroup title="记忆生成设置" description="Owner 不做自动画像；重点成员会更快沉淀记忆。" actions={<Button size="sm" variant="primary" icon={Save} onClick={saveMemorySettings}>保存设置</Button>}>
      <SettingRow title="启用长期记忆" control={<Switch checked={settingsDraft.memoryEnabled !== false} onChange={(event) => updateSettingsDraft({ memoryEnabled: event.target.checked })} />} />
      <SettingRow title="图片摘要进入长期记忆" description="仅多模态模型" control={<Switch checked={settingsDraft.visionMemoryEnabled !== false} onChange={(event) => updateSettingsDraft({ visionMemoryEnabled: event.target.checked })} />} />
      <div className="memory-setting-sliders">
        <Slider label="开始画像所需消息数" min={3} max={40} value={settingsDraft.memoryMinMessages || 8} onChange={(memoryMinMessages) => updateSettingsDraft({ memoryMinMessages })} />
        <Slider label="每隔多少条更新画像" min={3} max={40} value={settingsDraft.memoryUpdateEvery || 8} onChange={(memoryUpdateEvery) => updateSettingsDraft({ memoryUpdateEvery })} />
        <Slider label="每人保留样本数" min={30} max={300} step={10} value={settingsDraft.memorySampleRetain || 120} onChange={(memorySampleRetain) => updateSettingsDraft({ memorySampleRetain })} />
        <Slider label="注入提示词最大字数" min={200} max={1600} step={100} value={settingsDraft.memoryMaxChars || 900} onChange={(memoryMaxChars) => updateSettingsDraft({ memoryMaxChars })} />
      </div>
      <SettingRow title="无配文图片摘要" control={<Select value={settingsDraft.visionMemoryPureImagePolicy || 'important'} onChange={(event) => updateSettingsDraft({ visionMemoryPureImagePolicy: event.target.value })} options={[{ value: 'important', label: '只处理重点成员' }, { value: 'all', label: '所有人都处理' }, { value: 'off', label: '不处理' }]} />} />
    </SettingGroup>

    <div className="memory-workspace">
      <Card className="console-section memory-directory">
        <div className="console-section__title"><UserRoundSearch size={18} /><div><h3>已记录对象 · {memories.length}</h3><p>按重要度与消息数排序。</p></div></div>
        <span className="console-search"><Search size={15} /><input aria-label="搜索长期记忆" placeholder="搜索昵称、QQ 或画像关键词" value={memSearch} onChange={(event) => setMemSearch(event.target.value)} /></span>
        <div className="memory-directory__list">{memories.map((memory) => {
          const exp = (db.experience || {})[String(memory.userId)];
          return <button type="button" className={String(draft.userId) === String(memory.userId) ? 'is-selected' : ''} key={memory.userId} onClick={() => { setProfileDirty(false); setSelectedId(memory.userId); }}><strong>{memory.nickname || memory.userId}</strong><span>{memory.userId}</span><div><Pill tone="accent">记忆 Lv.{memory.importanceLevel || 0}</Pill><Pill>{memory.messageCount || 0} 条</Pill>{exp && <Pill tone="success">{levelPpLabel(exp)}</Pill>}</div></button>;
        })}{!memories.length && <EmptyState title="还没有长期记忆" description="有人积累足够消息后会自动出现。" />}</div>
      </Card>

      <Card className="console-section memory-editor">
        <div className="console-section__title"><Brain size={18} /><div><h3>画像编辑</h3><p>{draft.userId ? `${draft.nickname || draft.userId} · QQ ${draft.userId}` : '选择一个对象开始'}</p></div></div>
        {!draft.userId ? <EmptyState title="尚未选择画像" description="从左侧列表选择一个已记录对象。" /> : <>
          <div className="memory-meta-grid">
            <div><span>出现过的群</span><strong>{(draft.groupsSeen || []).join(', ') || '暂无'}</strong></div>
            <div><span>画像文本样本</span><strong>{draft.profileMessageCount || 0}</strong></div>
            <div><span>最近尝试</span><strong>{draft.lastProfileAttemptAt ? `${new Date(draft.lastProfileAttemptAt).toLocaleString()} · ${draft.lastProfileStatus || 'unknown'}` : '尚未尝试'}</strong></div>
            <div><span>最近画像</span><strong>{draft.lastProfiledAt ? new Date(draft.lastProfiledAt).toLocaleString() : '尚未自动画像'}</strong></div>
          </div>
          {draft.lastProfileError && <InlineHelp tone="danger">{draft.lastProfileError}</InlineHelp>}
          <div className="console-form-grid"><Input label="昵称" value={draft.nickname || ''} onChange={(event) => updateDraft({ nickname: event.target.value })} /><Switch label="启用这个人的长期记忆" checked={draft.enabled !== false} onChange={(event) => updateDraft({ enabled: event.target.checked })} /></div>
          <div className="memory-profile-fields">
            <Textarea label="整体印象" rows={3} value={draft.summary || ''} onChange={(event) => updateDraft({ summary: event.target.value })} />
            <Textarea label="性格 / 倾向" rows={3} value={draft.traits || ''} onChange={(event) => updateDraft({ traits: event.target.value })} />
            <Textarea label="说话风格" rows={3} value={draft.speechStyle || ''} onChange={(event) => updateDraft({ speechStyle: event.target.value })} />
            <Textarea label="互动习惯" rows={3} value={draft.behavior || ''} onChange={(event) => updateDraft({ behavior: event.target.value })} />
            <Textarea label="偏好 / 雷点" rows={3} value={draft.preferences || ''} onChange={(event) => updateDraft({ preferences: event.target.value })} />
            <Textarea label="人工备注" rows={4} value={draft.manualNotes || ''} onChange={(event) => updateDraft({ manualNotes: event.target.value })} />
          </div>
          {draft.profileMeta && Object.keys(draft.profileMeta).length > 0 && <div className="memory-confidence">{Object.entries(draft.profileMeta).filter(([, meta]) => meta.confidence > 0 || meta.evidenceCount > 0).map(([field, meta]) => {
            const labels = { traits: '性格', speechStyle: '说话', behavior: '互动', preferences: '偏好' };
            const confidence = Math.round((meta.confidence || 0) * 100);
            return <Pill key={field} tone={confidence >= 70 ? 'success' : confidence >= 40 ? 'warning' : 'danger'}>{labels[field] || field} {confidence}% · {meta.evidenceCount || 0} 条</Pill>;
          })}</div>}
          {draft.recentDynamics?.length > 0 && <section className="memory-subsection"><header><h4>近期动态</h4><span>最近 5 条</span></header><div className="console-list">{draft.recentDynamics.slice(-5).reverse().map((dynamic, index) => <article className="console-list-item memory-dynamic" key={`${dynamic.topic}-${index}`}><strong>{dynamic.topic}</strong><p>{dynamic.summary}</p><span>置信 {Math.round((dynamic.confidence || 0) * 100)}% · {dynamic.evidenceCount} 条 · {dynamic.firstSeenAt ? new Date(dynamic.firstSeenAt).toLocaleDateString('zh-CN') : '?'} ～ {dynamic.lastSeenAt ? new Date(dynamic.lastSeenAt).toLocaleDateString('zh-CN') : '?'}</span></article>)}</div></section>}
          <section className="memory-subsection"><header><h4>最近样本</h4><span>最近 10 条</span></header><div className="console-list memory-samples">{(draft.samples || []).slice(-10).reverse().map((sample, index) => <article className="console-list-item memory-sample" key={`${sample.createdAt || index}-${index}`}><div className="console-pills"><Pill tone="accent">{sampleTypeLabels[sample.type || 'text'] || sample.type || 'text'}</Pill>{sample.riskLevel === 'high-risk' && <Pill tone="danger">高风险已降级</Pill>}{sample.riskLevel === 'low-confidence' && <Pill tone="warning">低置信</Pill>}<Pill>{sample.usedForProfile === false ? sample.reason || '未进入画像' : '用于画像'}</Pill></div><p>{sample.content || '(empty)'}</p><span>{sample.createdAt ? new Date(sample.createdAt).toLocaleString() : ''}</span>{sample.context?.nearby?.length > 0 ? <small>语境：{sample.context.nearby.slice(-2).map((message) => `${message.nickname || message.userId}：${message.content.slice(0, 40)}`).join(' → ')}</small> : <small>旧版样本，无上下文记录</small>}</article>)}{!(draft.samples || []).length && <EmptyState title="还没有样本" />}</div></section>
          <div className="console-actions console-actions--end"><Button icon={RefreshCw} loading={recalcUserId === String(draft.userId)} onClick={recalcMemory}>重算画像</Button><Button variant="primary" icon={Save} onClick={saveMemory}>保存画像</Button><Button variant="danger-ghost" icon={Trash2} onClick={deleteMemory}>删除记忆</Button></div>
        </>}
      </Card>
    </div>
  </div>;
}
