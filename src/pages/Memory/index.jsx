import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { ConfirmDialog } from '../../components/ui/index.jsx';
import { Avatar, userAvatarUrl } from '../../components/Avatar.jsx';

// 版式对齐原型 PAGES.memory：左「记忆条目」+ 右「记忆策略」；画像编辑放在下方整宽。
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
  const [memoryDetail, setMemoryDetail] = useState(null);
  const [draft, setDraft] = useState(selected || {});
  const [settingsDraft, setSettingsDraft] = useState(db.settings);
  const [profileDirty, setProfileDirty] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [recalcUserId, setRecalcUserId] = useState('');
  const selectedStamp = selected?.updatedAt || '';

  useEffect(() => {
    if (!selectedId) {
      setMemoryDetail(null);
      return undefined;
    }
    const controller = new AbortController();
    let cancelled = false;
    setMemoryDetail(null);
    api(`/api/memories/${selectedId}`, { signal: controller.signal, timeoutMs: 10000 })
      .then((result) => { if (!cancelled) setMemoryDetail(result.memory || null); })
      .catch((cause) => { if (!cancelled && cause?.message !== '请求已取消') setMemoryDetail(null); });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [selectedId, selectedStamp]);

  useEffect(() => {
    if (profileDirty) return;
    const next = memoryDetail && String(memoryDetail.userId) === String(selectedId) ? memoryDetail : selected || {};
    setDraft(next);
  }, [memoryDetail, selectedId, selectedStamp, profileDirty]);

  useEffect(() => {
    if (!settingsDirty) setSettingsDraft(db.settings);
  }, [db.settings, settingsDirty]);

  const updateDraft = (patch) => { setProfileDirty(true); setDraft((current) => ({ ...current, ...patch })); };
  const updateSettingsDraft = (patch) => { setSettingsDirty(true); setSettingsDraft((current) => ({ ...current, ...patch })); };

  const saveMemory = async () => {
    if (!draft.userId) return;
    await api(`/api/memories/${draft.userId}`, { method: 'POST', body: draft, timeoutMs: 15000 });
    setProfileDirty(false);
    await refreshState();
  };
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [recalcConfirm, setRecalcConfirm] = useState(false);
  const deleteMemory = async () => {
    if (!draft.userId) return;
    await api(`/api/memories/${draft.userId}`, { method: 'DELETE', timeoutMs: 15000 });
    setSelectedId('');
    setMemoryDetail(null);
    setProfileDirty(false);
    await refreshState();
  };
  const recalcMemory = async () => {
    if (!draft.userId || recalcUserId) return;
    if (profileDirty) { setRecalcConfirm(true); return; }
    const targetUserId = String(draft.userId);
    setRecalcUserId(targetUserId);
    try {
      const result = await api(`/api/memories/${targetUserId}/recalculate`, { method: 'POST', timeoutMs: 130000 });
      setProfileDirty(false);
      await refreshState();
      const detailResult = await api(`/api/memories/${targetUserId}`, { timeoutMs: 10000 });
      if (detailResult.memory) {
        setMemoryDetail(detailResult.memory);
        setDraft(detailResult.memory);
      }
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

  return <>
    <div className="page-head">
      <div><h1>记忆</h1><p>长期画像和近期动态分开放，别把一次闲聊当成永久印象。</p></div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn btn-ghost" disabled={!draft.userId || recalcUserId === String(draft.userId)} onClick={recalcMemory}>{recalcUserId ? '重算中…' : '重算画像'}</button>
        <button type="button" className="btn btn-primary" disabled={!draft.userId || !profileDirty} onClick={saveMemory}>保存画像</button>
      </div>
    </div>

    <div className="searchbar" style={{ marginBottom: 16 }}>
      <span className="muted">搜索</span>
      <input value={memSearch} onChange={(event) => setMemSearch(event.target.value)} placeholder="昵称、QQ 或画像关键词" aria-label="搜索长期记忆" />
      <span className="chip">{memories.length} 个对象</span>
    </div>

    <div className="grid grid-main" style={{ alignItems: 'start' }}>
      <div className="card">
        <div className="card-head"><span className="card-title">记忆条目</span><span className="muted" style={{ fontSize: 12 }}>按重要度与消息数排序</span></div>
        <div className="rows" style={{ maxHeight: 480, overflowY: 'auto' }}>
          {memories.map((memory) => {
            const selectedRow = String(draft.userId) === String(memory.userId);
            const exp = (db.experience || {})[String(memory.userId)];
            return <div
              key={memory.userId}
              role="button"
              tabIndex={0}
              onClick={() => { setProfileDirty(false); setMemoryDetail(null); setSelectedId(memory.userId); }}
              style={{ cursor: 'pointer', borderRadius: 10, padding: '10px', background: selectedRow ? 'var(--pink-soft)' : undefined, display: 'flex', gap: 10, alignItems: 'flex-start' }}
            >
              <Avatar name={memory.nickname || memory.userId} src={userAvatarUrl(memory.userId)} size={28} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                  <div className="row-title" style={{ fontSize: 13 }}>{memory.nickname || memory.userId}</div>
                  <span className="chip chip--pink">Lv.{memory.importanceLevel || 0}</span>
                </div>
                <div className="row-sub">{memory.summary ? String(memory.summary).slice(0, 46) : memory.userId}</div>
                <div className="row-sub" style={{ marginTop: 4 }}>{memory.messageCount || 0} 条消息{exp ? ' · ' + levelPpLabel(exp) : ''}</div>
              </div>
            </div>;
          })}
          {!memories.length && <div className="note">{db.memories?.length ? '没有匹配的记忆。' : '还没有长期记忆，有人积累足够消息后会自动出现。'}</div>}
        </div>
      </div>

      <div className="stack">
        <div className="card">
          <div className="card-head"><span className="card-title">记忆策略</span><span className={'chip ' + (settingsDraft.memoryEnabled !== false ? 'chip--mint' : '')}>{settingsDraft.memoryEnabled !== false ? '开启' : '关闭'}</span></div>
          <div className="kv"><span>长期画像</span><b>{settingsDraft.memoryEnabled !== false ? '开启' : '关闭'}</b></div>
          <div className="kv"><span>开始画像所需消息</span><b>{settingsDraft.memoryMinMessages || 8} 条</b></div>
          <div className="kv"><span>更新频率</span><b>每 {settingsDraft.memoryUpdateEvery || 8} 条</b></div>
          <div className="kv"><span>注入上限</span><b>{settingsDraft.memoryMaxChars || 900} 字</b></div>
          <div className="kv"><span>样本保留</span><b>{settingsDraft.memorySampleRetain || 120} 条</b></div>
          <div className="kv"><span>本周变化</span><b>{settingsDirty ? '有未保存设置' : '已同步'}</b></div>
        </div>

        <div className="card">
          <div className="card-head"><span className="card-title">记忆生成设置</span><button type="button" className="btn btn-sm" disabled={!settingsDirty} onClick={saveMemorySettings}>保存设置</button></div>
          <div className="row">
            <div className="row-main"><div className="row-title">启用长期记忆</div><div className="row-sub">Owner 不做自动画像</div></div>
            <button type="button" className={'switch' + (settingsDraft.memoryEnabled !== false ? ' is-on' : '')} aria-label="启用长期记忆" onClick={() => updateSettingsDraft({ memoryEnabled: settingsDraft.memoryEnabled === false })} />
          </div>
          <div className="row">
            <div className="row-main"><div className="row-title">图片摘要进入长期记忆</div><div className="row-sub">仅多模态模型</div></div>
            <button type="button" className={'switch' + (settingsDraft.visionMemoryEnabled !== false ? ' is-on' : '')} aria-label="图片摘要进入长期记忆" onClick={() => updateSettingsDraft({ visionMemoryEnabled: settingsDraft.visionMemoryEnabled === false })} />
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
            <div className="field" style={{ flex: 1 }}><label>开始画像消息数</label><input type="number" min="3" max="40" value={settingsDraft.memoryMinMessages || 8} onChange={(event) => updateSettingsDraft({ memoryMinMessages: Number(event.target.value) })} /></div>
            <div className="field" style={{ flex: 1 }}><label>每隔多少条更新</label><input type="number" min="3" max="40" value={settingsDraft.memoryUpdateEvery || 8} onChange={(event) => updateSettingsDraft({ memoryUpdateEvery: Number(event.target.value) })} /></div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div className="field" style={{ flex: 1 }}><label>样本保留</label><input type="number" min="30" max="300" step="10" value={settingsDraft.memorySampleRetain || 120} onChange={(event) => updateSettingsDraft({ memorySampleRetain: Number(event.target.value) })} /></div>
            <div className="field" style={{ flex: 1 }}><label>注入字数上限</label><input type="number" min="200" max="1600" step="100" value={settingsDraft.memoryMaxChars || 900} onChange={(event) => updateSettingsDraft({ memoryMaxChars: Number(event.target.value) })} /></div>
          </div>
          <div className="field"><label>无配文图片摘要</label>
            <select value={settingsDraft.visionMemoryPureImagePolicy || 'important'} onChange={(event) => updateSettingsDraft({ visionMemoryPureImagePolicy: event.target.value })}>
              <option value="important">只处理重点成员</option>
              <option value="all">所有人都处理</option>
              <option value="off">不处理</option>
            </select>
          </div>
        </div>
      </div>
    </div>

    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head">
        <span className="card-title">画像编辑</span>
        <span className="muted" style={{ fontSize: 12 }}>{draft.userId ? `${draft.nickname || draft.userId} · QQ ${draft.userId}` : '选择一个对象开始'}</span>
      </div>
      {!draft.userId ? <div className="note">从左侧列表选择一个已记录对象。</div> : <>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 12 }}>
          <div className="kv" style={{ display: 'block' }}><span>出现过的群</span><br /><b style={{ fontWeight: 500 }}>{(draft.groupsSeen || []).join(', ') || '暂无'}</b></div>
          <div className="kv" style={{ display: 'block' }}><span>画像样本数</span><br /><b>{draft.profileMessageCount || 0}</b></div>
          <div className="kv" style={{ display: 'block' }}><span>最近尝试</span><br /><b style={{ fontWeight: 500 }}>{draft.lastProfileAttemptAt ? `${new Date(draft.lastProfileAttemptAt).toLocaleString('zh-CN')} · ${draft.lastProfileStatus || 'unknown'}` : '尚未尝试'}</b></div>
          <div className="kv" style={{ display: 'block' }}><span>最近画像</span><br /><b style={{ fontWeight: 500 }}>{draft.lastProfiledAt ? new Date(draft.lastProfiledAt).toLocaleString('zh-CN') : '尚未自动画像'}</b></div>
        </div>
        {draft.lastProfileError && <div className="note" style={{ color: 'var(--red)' }}>{draft.lastProfileError}</div>}

        <div style={{ display: 'flex', gap: 10, marginTop: 10, alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: 1, marginBottom: 0 }}><label>昵称</label><input value={draft.nickname || ''} onChange={(event) => updateDraft({ nickname: event.target.value })} /></div>
          <div className="row" style={{ marginBottom: 0, paddingBottom: 0 }}>
            <div className="row-main"><div className="row-title">启用这个人的长期记忆</div></div>
            <button type="button" className={'switch' + (draft.enabled !== false ? ' is-on' : '')} aria-label="启用这个人的长期记忆" onClick={() => updateDraft({ enabled: draft.enabled === false })} />
          </div>
        </div>

        {[['summary', '整体印象', 3], ['traits', '性格 / 倾向', 3], ['speechStyle', '说话风格', 3], ['behavior', '互动习惯', 3], ['preferences', '偏好 / 雷点', 3], ['manualNotes', '人工备注', 4]].map(([field, label, rows]) => <div className="field" key={field}>
          <label>{label}</label>
          <textarea rows={rows} style={{ minHeight: 96 }} value={draft[field] || ''} onChange={(event) => updateDraft({ [field]: event.target.value })} />
        </div>)}

        {draft.profileMeta && Object.keys(draft.profileMeta).length > 0 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '4px 0 12px' }}>
          {Object.entries(draft.profileMeta).filter(([, meta]) => meta.confidence > 0 || meta.evidenceCount > 0).map(([field, meta]) => {
            const labels = { traits: '性格', speechStyle: '说话', behavior: '互动', preferences: '偏好' };
            const confidence = Math.round((meta.confidence || 0) * 100);
            return <span key={field} className={'chip' + (confidence >= 70 ? ' chip--mint' : confidence >= 40 ? ' chip--amber' : '')}>{labels[field] || field} {confidence}% · {meta.evidenceCount || 0} 条</span>;
          })}
        </div>}

        {draft.recentDynamics?.length > 0 && <div style={{ marginTop: 12 }}>
          <div className="card-title" style={{ marginBottom: 8 }}>近期动态 · 最近 5 条</div>
          <div className="rows">
            {draft.recentDynamics.slice(-5).reverse().map((dynamic, index) => <div className="row" key={`${dynamic.topic}-${index}`}>
              <div className="row-main">
                <div className="row-title">{dynamic.topic}</div>
                <div className="row-sub">{dynamic.summary}</div>
                <div className="row-sub">置信 {Math.round((dynamic.confidence || 0) * 100)}% · {dynamic.evidenceCount} 条</div>
              </div>
            </div>)}
          </div>
        </div>}

        <div style={{ marginTop: 14 }}>
          <div className="card-title" style={{ marginBottom: 8 }}>最近样本 · 最近 10 条</div>
          <div className="rows" style={{ maxHeight: 360, overflowY: 'auto' }}>
            {(draft.samples || []).slice(-10).reverse().map((sample, index) => <div className="row" key={`${sample.createdAt || index}-${index}`} style={{ alignItems: 'flex-start' }}>
              <div className="row-main">
                <div className="row-sub" style={{ marginTop: 0 }}>
                  <span className="chip">{sampleTypeLabels[sample.type || 'text'] || sample.type || 'text'}</span>
                  {sample.riskLevel === 'high-risk' && <span className="chip chip--amber">高风险已降级</span>}
                  {sample.usedForProfile === false && <span className="chip">{sample.reason || '未进入画像'}</span>}
                </div>
                <div className="row-title" style={{ fontWeight: 500, whiteSpace: 'normal', marginTop: 4 }}>{sample.content || '(empty)'}</div>
                <div className="row-sub">{sample.createdAt ? new Date(sample.createdAt).toLocaleString('zh-CN') : ''}</div>
              </div>
            </div>)}
            {!(draft.samples || []).length && <div className="note">还没有样本。</div>}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button type="button" className="btn" disabled={recalcUserId === String(draft.userId)} onClick={recalcMemory}>{recalcUserId ? '重算中…' : '重算画像'}</button>
          <button type="button" className="btn btn-primary" disabled={!profileDirty} onClick={saveMemory}>保存画像</button>
          <button type="button" className="btn btn-ghost" onClick={() => setDeleteConfirm(true)}>删除记忆</button>
        </div>
      </>}
    </div>
    <ConfirmDialog
      open={deleteConfirm}
      title="删除长期记忆？"
      description={`将删除 ${draft.nickname || draft.userId || "该成员"} 的长期画像与样本，无法恢复；群聊记录不受影响。`}
      confirmLabel="删除记忆"
      onCancel={() => setDeleteConfirm(false)}
      onConfirm={() => { setDeleteConfirm(false); return deleteMemory(); }}
    />
    <ConfirmDialog
      open={recalcConfirm}
      title="画像有未保存修改"
      description="继续重算不会包含编辑区里尚未保存的修改。要丢弃这些修改并继续吗？"
      confirmLabel="继续重算"
      onCancel={() => setRecalcConfirm(false)}
      onConfirm={() => { setRecalcConfirm(false); setProfileDirty(false); return recalcMemory(); }}
    />
  </>;
}
