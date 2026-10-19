import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api.js';

// 版式对齐原型 PAGES.persona：左「人格层」列表 + 右编辑区 + 实际调用记录。
const cloneMap = (value) => value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
const navRowStyle = (active) => ({
  cursor: 'pointer',
  borderRadius: 10,
  background: active ? 'var(--pink-soft)' : undefined,
  padding: '9px 10px',
});

export function PersonaPage({ db, saveSettings }) {
  const settings = db?.settings || {};
  const [draft, setDraft] = useState(() => ({
    botNames: settings.botNames || '',
    personalityPrompt: settings.personalityPrompt || '',
    personaPromptSections: cloneMap(settings.personaPromptSections),
    personaModulePrompts: cloneMap(settings.personaModulePrompts),
  }));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [catalog, setCatalog] = useState({ modules: [], sections: [] });
  const [calls, setCalls] = useState([]);
  const [traces, setTraces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState({ type: 'section', id: 'coreIdentity' });
  const [selectedCallId, setSelectedCallId] = useState('');

  useEffect(() => {
    if (dirty) return;
    setDraft({
      botNames: settings.botNames || '',
      personalityPrompt: settings.personalityPrompt || '',
      personaPromptSections: cloneMap(settings.personaPromptSections),
      personaModulePrompts: cloneMap(settings.personaModulePrompts),
    });
  }, [settings, dirty]);

  const refreshStudio = useCallback(async () => {
    setLoading(true);
    setError('');
    let studioData;
    try {
      // Authenticate once before parallel reads; concurrent 401s race the
      // shared admin-password prompt in the API helper.
      studioData = await api('/api/persona/studio', { timeoutMs: 10000 });
      setCatalog({ modules: studioData.modules || [], sections: studioData.sections || [] });
    } catch (studioError) {
      setError(studioError?.message || '人格目录加载失败');
      setLoading(false);
      return;
    }
    const [callsResult, tracesResult] = await Promise.allSettled([
      api('/api/persona/prompt-calls?limit=32', { timeoutMs: 10000 }),
      api('/api/request-traces?limit=80', { timeoutMs: 10000 }),
    ]);
    if (callsResult.status === 'fulfilled') setCalls(callsResult.value.promptCalls || []);
    else setError(callsResult.reason?.message || '模型调用记录加载失败');
    if (tracesResult.status === 'fulfilled') setTraces(tracesResult.value.traces || []);
    else if (callsResult.status === 'fulfilled') setError(tracesResult.reason?.message || '工具执行追踪加载失败');
    setLoading(false);
  }, []);

  useEffect(() => { void refreshStudio(); }, [refreshStudio]);

  const updateDraft = (patch) => {
    setDirty(true);
    setDraft((current) => ({ ...current, ...patch }));
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await saveSettings({
        botNames: draft.botNames,
        personalityPrompt: draft.personalityPrompt,
        personaPromptSections: draft.personaPromptSections,
        personaModulePrompts: draft.personaModulePrompts,
      });
      setDirty(false);
    } catch (saveError) {
      setError(saveError?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const sectionItems = catalog.sections || [];
  const moduleItems = catalog.modules || [];
  const activeSection = selected.type === 'section' ? sectionItems.find((item) => item.id === selected.id) : null;
  const activeModule = selected.type === 'module' ? moduleItems.find((item) => item.id === selected.id) : null;
  const visibleCalls = useMemo(() => activeModule ? calls.filter((call) => call.moduleId === activeModule.id) : calls, [activeModule, calls]);
  const selectedCall = visibleCalls.find((call) => call.id === selectedCallId) || visibleCalls[0] || null;
  const relatedTrace = selectedCall?.requestId ? traces.find((trace) => trace.id === selectedCall.requestId) : null;
  const toolEvents = (relatedTrace?.events || []).filter((event) => event.phase === 'TOOL');

  const editSection = (id, content) => updateDraft({
    personaPromptSections: { ...draft.personaPromptSections, [id]: content },
  });
  const resetSection = (id) => {
    const next = { ...draft.personaPromptSections };
    delete next[id];
    updateDraft({ personaPromptSections: next });
  };
  const editModule = (id, content) => updateDraft({
    personaModulePrompts: { ...draft.personaModulePrompts, [id]: content },
  });
  const resetModule = (id) => {
    const next = { ...draft.personaModulePrompts };
    delete next[id];
    updateDraft({ personaModulePrompts: next });
  };

  const activeTitle = activeSection?.title || activeModule?.name || (selected.type === 'global' ? '全局设置' : '人格注入');
  const eyebrow = activeSection ? 'PERSONA LAYER' : activeModule ? 'LLM MODULE' : 'GLOBAL CONFIGURATION';
  const sectionOverridden = activeSection && Object.prototype.hasOwnProperty.call(draft.personaPromptSections, activeSection.id);

  return <>
    <div className="page-head">
      <div><h1>人设</h1><p>按实际调用模块查看人格是如何注入的。</p></div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn btn-ghost" disabled={loading} onClick={() => void refreshStudio()}>{loading ? '刷新中…' : '刷新调用记录'}</button>
        <button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={save}>{saving ? '保存中…' : '保存更改'}</button>
      </div>
    </div>

    {error && <div className="note" style={{ color: 'var(--red)', marginBottom: 12 }}>{error}</div>}

    <div className="grid" style={{ gridTemplateColumns: '260px minmax(0,1fr)', gap: 16, alignItems: 'start' }}>
      <div className="card" style={{ maxHeight: 'calc(100vh - 150px)', overflowY: 'auto' }}>
        <div className="card-head"><span className="card-title">人格层</span><span className="muted" style={{ fontSize: 12 }}>{sectionItems.length} 层 · {moduleItems.length} 模块</span></div>
        <div className="rows">
          {sectionItems.map((item) => {
            const active = selected.type === 'section' && selected.id === item.id;
            return <div key={item.id} role="button" tabIndex={0} style={navRowStyle(active)} onClick={() => setSelected({ type: 'section', id: item.id })} onKeyDown={(event) => { if (event.key === 'Enter') setSelected({ type: 'section', id: item.id }); }}>
              <div className="row-title" style={{ fontSize: 13 }}>{item.title}</div>
              {Object.prototype.hasOwnProperty.call(draft.personaPromptSections, item.id) && <div className="row-sub">已自定义</div>}
            </div>;
          })}
          <div style={{ margin: '12px 0 6px', color: 'var(--muted)', fontSize: 11, letterSpacing: '.08em' }}>全局设置</div>
          <div role="button" tabIndex={0} style={navRowStyle(selected.type === 'global')} onClick={() => setSelected({ type: 'global', id: 'global' })}>
            <div className="row-title" style={{ fontSize: 13 }}>全局补充与名称</div>
          </div>
          <div style={{ margin: '12px 0 6px', color: 'var(--muted)', fontSize: 11, letterSpacing: '.08em' }}>LLM 模块</div>
          {moduleItems.map((item) => {
            const active = selected.type === 'module' && selected.id === item.id;
            return <div key={item.id} role="button" tabIndex={0} style={navRowStyle(active)} onClick={() => setSelected({ type: 'module', id: item.id })}>
              <div className="row-title" style={{ fontSize: 13 }}>{item.name}</div>
              {String(draft.personaModulePrompts[item.id] || '').trim() && <div className="row-sub">已自定义</div>}
            </div>;
          })}
        </div>
      </div>

      <div className="stack">
        <div className="card">
          <div className="card-head"><span className="card-title">{activeTitle}</span><span className="chip">{eyebrow}</span></div>
          <div className="note">{activeSection?.description || activeModule?.description || '机器人名称与跨模块人格补充。'}</div>
          {activeModule && <div className="kv"><span>注入方式</span><b style={{ fontWeight: 500, textAlign: 'right' }}>{activeModule.injectionMethod}</b></div>}
          {activeModule && <div className="kv"><span>人格注入</span><b>{activeModule.usesPippi ? '注入 Pippi 人格' : '独立任务提示'}</b></div>}
          {activeModule?.toolsPossible && <div className="kv"><span>工具</span><b>可能使用工具</b></div>}
          {activeSection && <div className="kv"><span>生效范围</span><b style={{ fontWeight: 500, textAlign: 'right' }}>{activeSection.id === 'communityBanter' ? '仅在日常聊天场景中注入' : activeSection.id.startsWith('scene') ? '仅在对应场景被选择时注入' : 'Pippi 人格链路的共享层；未自定义时使用代码内置版本'}</b></div>}
        </div>

        {activeSection && <div className="card">
          <div className="card-head"><span className="card-title">人格层内容</span>{sectionOverridden && <button type="button" className="btn btn-sm btn-ghost" onClick={() => resetSection(activeSection.id)}>恢复内置版本</button>}</div>
          <div className="field">
            <label>Prompt 内容</label>
            <textarea
              rows="16"
              spellCheck={false}
              value={sectionOverridden ? draft.personaPromptSections[activeSection.id] : activeSection.defaultContent}
              onChange={(event) => editSection(activeSection.id, event.target.value)}
            />
          </div>
          <div className="note">没有覆盖的层会直接使用代码内置文本。保存后新发起的模型请求生效，已开始的请求不变。</div>
        </div>}

        {activeModule && <div className="card">
          <div className="card-head"><span className="card-title">{activeModule.editableLabel}</span>{String(draft.personaModulePrompts[activeModule.id] || '').trim() && <button type="button" className="btn btn-sm btn-ghost" onClick={() => resetModule(activeModule.id)}>清除补充</button>}</div>
          <div className="field">
            <label>模块人格补充</label>
            <textarea
              rows="7"
              spellCheck={false}
              placeholder="留空表示不增加模块专属人格补充。"
              value={draft.personaModulePrompts[activeModule.id] || ''}
              onChange={(event) => editModule(activeModule.id, event.target.value)}
            />
          </div>
          <div className="note">只追加到此模块。严格 JSON、事实边界和输出结构仍有代码侧校验；但自定义文本仍可能影响模型行为，请谨慎修改。</div>
        </div>}

        {selected.type === 'global' && <div className="card">
          <div className="card-head"><span className="card-title">全局人格补充</span></div>
          <div className="note">保留旧设置语义：它是用户自定义补充，不会覆盖 Pippi 的内置身份核心。</div>
          <div className="field"><label>机器人名称</label><input value={draft.botNames} onChange={(event) => updateDraft({ botNames: event.target.value })} placeholder="多个名称用英文逗号分隔" /></div>
          <div className="field"><label>跨场景人格补充</label><textarea rows="10" spellCheck={false} value={draft.personalityPrompt} onChange={(event) => updateDraft({ personalityPrompt: event.target.value })} /></div>
          <div className="note">此补充目前随主要对话与 osu! 分析人格链路注入。独立画像、审核等模块使用各自的模块补充设置。</div>
        </div>}

        <div className="card">
          <div className="card-head"><span className="card-title">实际整理调用</span><span className="muted" style={{ fontSize: 12 }}>{visibleCalls.length} 条 · 重启后清空</span></div>
          {visibleCalls.length === 0 ? <div className="note">
            {loading ? '正在读取调用记录…' : activeModule ? '这个模块还没有捕获到调用。触发一次对应功能后刷新即可查看。' : '暂无模型调用快照。'}
          </div> : <>
            <div className="rows" style={{ maxHeight: 220, overflowY: 'auto' }}>
              {visibleCalls.map((call) => <div
                key={call.id}
                role="button"
                tabIndex={0}
                style={navRowStyle(selectedCall?.id === call.id)}
                onClick={() => setSelectedCallId(call.id)}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                  <div className="row-title" style={{ fontSize: 13 }}>{call.purpose || call.moduleName}</div>
                  <span className={'chip' + (call.status === 'ok' ? ' chip--mint' : call.status === 'running' ? ' chip--amber' : '')}>{call.status === 'ok' ? '完成' : call.status === 'running' ? '运行中' : '失败'}</span>
                </div>
                <div className="row-sub">{new Date(call.at).toLocaleString('zh-CN')}</div>
              </div>)}
            </div>

            {selectedCall && <div style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                <span className="chip">{selectedCall.provider || 'provider 未知'} / {selectedCall.model || 'model 未知'}</span>
                <span className="chip">{selectedCall.durationMs ? `${selectedCall.durationMs} ms` : selectedCall.status}</span>
                {selectedCall.truncated && <span className="chip chip--amber">快照已截断</span>}
              </div>
              {(selectedCall.messages || []).map((message, index) => <details key={`${selectedCall.id}-${index}`} open={message.role === 'system' && index === 0} style={{ marginBottom: 8 }}>
                <summary style={{ cursor: 'pointer', color: 'var(--muted)', fontSize: 12 }}>{message.role} · {message.truncated ? '内容已截断' : `${String(message.content || '').length.toLocaleString()} 字符`}</summary>
                <pre style={{ maxHeight: 240, overflow: 'auto', fontSize: 11, whiteSpace: 'pre-wrap', color: 'var(--soft)' }}>{message.content || '（空内容）'}</pre>
              </details>)}
              {selectedCall.tools && selectedCall.tools !== '[]' && <details style={{ marginBottom: 8 }}>
                <summary style={{ cursor: 'pointer', color: 'var(--muted)', fontSize: 12 }}>可用工具 schema</summary>
                <pre style={{ maxHeight: 240, overflow: 'auto', fontSize: 11, whiteSpace: 'pre-wrap' }}>{selectedCall.tools}</pre>
              </details>}
              {selectedCall.response?.toolCalls && selectedCall.response.toolCalls !== '[]' && <details open style={{ marginBottom: 8 }}>
                <summary style={{ cursor: 'pointer', color: 'var(--muted)', fontSize: 12 }}>模型返回的工具调用</summary>
                <pre style={{ maxHeight: 240, overflow: 'auto', fontSize: 11, whiteSpace: 'pre-wrap' }}>{selectedCall.response.toolCalls}</pre>
              </details>}
              {selectedCall.response?.content && <details style={{ marginBottom: 8 }}>
                <summary style={{ cursor: 'pointer', color: 'var(--muted)', fontSize: 12 }}>模型输出 · {String(selectedCall.response.content).length.toLocaleString()} 字符</summary>
                <pre style={{ maxHeight: 240, overflow: 'auto', fontSize: 11, whiteSpace: 'pre-wrap' }}>{selectedCall.response.content}</pre>
              </details>}
              <details style={{ marginBottom: 8 }}>
                <summary style={{ cursor: 'pointer', color: 'var(--muted)', fontSize: 12 }}>请求参数与用量</summary>
                <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap' }}>{JSON.stringify({
                  toolChoice: selectedCall.toolChoice,
                  responseFormat: selectedCall.responseFormat,
                  finishReason: selectedCall.response?.finishReason,
                  usage: selectedCall.response?.usage,
                }, null, 2)}</pre>
              </details>
              {selectedCall.error && <pre style={{ color: 'var(--red)', fontSize: 11, whiteSpace: 'pre-wrap' }}>{selectedCall.error}</pre>}
              {relatedTrace && <details style={{ marginBottom: 8 }}>
                <summary style={{ cursor: 'pointer', color: 'var(--muted)', fontSize: 12 }}>工具执行时间线 · {toolEvents.length} 个事件</summary>
                {toolEvents.length ? toolEvents.map((event) => <div key={event.id} style={{ marginTop: 8 }}>
                  <b style={{ fontSize: 12 }}>{event.name}</b>
                  <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', color: 'var(--muted)' }}>{JSON.stringify(event.data || {}, null, 2)}</pre>
                </div>) : <div className="note">该请求追踪中没有工具执行事件。</div>}
              </details>}
              {!selectedCall.requestId && <div className="note">该调用不属于 QQ 请求追踪；可查看模型返回的工具调用，但没有独立工具执行时间线。</div>}
            </div>}
          </>}
          <div className="note" style={{ marginTop: 12 }}>请求快照最多保留最近 32 次、只在当前进程内存中；图片/音频载荷与推理过程不记录，提示词文本会做密钥脱敏。</div>
        </div>
      </div>
    </div>
  </>;
}
