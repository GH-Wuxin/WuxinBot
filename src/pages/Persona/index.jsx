import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, Bot, Braces, ChevronRight, Clock3, Eye, Layers3,
  MessageSquareText, RefreshCw, RotateCcw, Save, ShieldCheck, Sparkles, Wrench,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import { Button, Card, Input, InlineHelp, Pill, SectionHeader, Textarea } from '../../components/ui/index.jsx';
import './persona.css';

const cloneMap = (value) => value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};

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

  return <div className="console-page persona-studio">
    <SectionHeader
      title="人格注入工作台"
      description="按实际调用模块查看注入方式、编辑人格层，并核对模型收到的提示词与工具。"
      actions={<div className="persona-studio__header-actions">
        <Button icon={RefreshCw} onClick={() => void refreshStudio()} loading={loading}>刷新调用记录</Button>
        <Button variant="primary" icon={Save} onClick={save} loading={saving} disabled={!dirty}>保存更改</Button>
      </div>}
    />

    {error && <div className="persona-studio__error" role="alert">{error}</div>}

    <div className="persona-studio__layout">
      <Card as="nav" className="persona-studio__nav" aria-label="人格注入模块">
        <div className="persona-studio__nav-label"><Layers3 size={14} />PIPPI 人格层</div>
        {sectionItems.map((item) => <button
          type="button"
          key={item.id}
          className={`persona-studio__nav-item ${selected.type === 'section' && selected.id === item.id ? 'is-active' : ''}`}
          onClick={() => setSelected({ type: 'section', id: item.id })}
        >
          <span>{item.title}</span>
          {Object.prototype.hasOwnProperty.call(draft.personaPromptSections, item.id) && <i aria-label="有自定义修改" />}
        </button>)}

        <div className="persona-studio__nav-label persona-studio__nav-label--spaced"><Sparkles size={14} />全局设置</div>
        <button type="button" className={`persona-studio__nav-item ${selected.type === 'global' ? 'is-active' : ''}`} onClick={() => setSelected({ type: 'global', id: 'global' })}>
          <span>全局补充与名称</span><ChevronRight size={14} />
        </button>

        <div className="persona-studio__nav-label persona-studio__nav-label--spaced"><Bot size={14} />LLM 模块</div>
        {moduleItems.map((item) => <button
          type="button"
          key={item.id}
          className={`persona-studio__nav-item ${selected.type === 'module' && selected.id === item.id ? 'is-active' : ''}`}
          onClick={() => setSelected({ type: 'module', id: item.id })}
        >
          <span>{item.name}</span>
          {String(draft.personaModulePrompts[item.id] || '').trim() && <i aria-label="有自定义补充" />}
        </button>)}
      </Card>

      <main className="persona-studio__main">
        <Card className="persona-studio__detail-head">
          <div className="persona-studio__title-row">
            <div>
              <span className="persona-studio__eyebrow">{activeSection ? 'PERSONA LAYER' : activeModule ? 'LLM MODULE' : 'GLOBAL CONFIGURATION'}</span>
              <h3>{activeTitle}</h3>
            </div>
            {activeModule && <div className="persona-studio__badges">
              <Pill tone={activeModule.usesPippi ? 'success' : 'neutral'}>{activeModule.usesPippi ? '注入 Pippi 人格' : '独立任务提示'}</Pill>
              {activeModule.toolsPossible && <Pill tone="warning">可能使用工具</Pill>}
              {String(draft.personaModulePrompts[activeModule.id] || '').trim() && <Pill tone="accent">已自定义</Pill>}
            </div>}
            {activeSection && Object.prototype.hasOwnProperty.call(draft.personaPromptSections, activeSection.id) && <Pill tone="accent">已覆盖内置文本</Pill>}
          </div>
          <p>{activeSection?.description || activeModule?.description || '机器人名称与跨模块人格补充。'}</p>
          {activeModule && <div className="persona-studio__injection"><span>注入方式</span><p>{activeModule.injectionMethod}</p></div>}
          {activeSection && <div className="persona-studio__injection"><span>生效范围</span><p>{activeSection.id === 'communityBanter' ? '仅在日常聊天场景中注入。' : activeSection.id.startsWith('scene') ? '仅在对应场景被选择时注入。' : '作为 Pippi 人格链路的共享层；未自定义时使用代码内置版本。'}</p></div>}
        </Card>

        {activeSection && <Card className="persona-studio__editor">
          <div className="persona-studio__panel-heading">
            <div><h4>人格层内容</h4><p>这里编辑的是实际人格注入层；任务格式、数据契约和程序校验仍由对应模块负责。</p></div>
            {Object.prototype.hasOwnProperty.call(draft.personaPromptSections, activeSection.id) && <Button icon={RotateCcw} onClick={() => resetSection(activeSection.id)}>恢复内置版本</Button>}
          </div>
          <Textarea
            label="Prompt 内容"
            rows={19}
            spellCheck={false}
            value={Object.prototype.hasOwnProperty.call(draft.personaPromptSections, activeSection.id)
              ? draft.personaPromptSections[activeSection.id]
              : activeSection.defaultContent}
            onChange={(event) => editSection(activeSection.id, event.target.value)}
          />
          <InlineHelp>没有覆盖的层会直接使用代码内置文本。保存后新发起的模型请求生效，已开始的请求不变。</InlineHelp>
        </Card>}

        {activeModule && <Card className="persona-studio__editor">
          <div className="persona-studio__panel-heading">
            <div><h4>{activeModule.editableLabel}</h4><p>作为一段独立 system 补充追加到该模块，不会替换下方显示的完整任务提示词。</p></div>
            {String(draft.personaModulePrompts[activeModule.id] || '').trim() && <Button icon={RotateCcw} onClick={() => resetModule(activeModule.id)}>清除补充</Button>}
          </div>
          <Textarea
            label="模块人格补充"
            rows={7}
            spellCheck={false}
            placeholder="留空表示不增加模块专属人格补充。"
            value={draft.personaModulePrompts[activeModule.id] || ''}
            onChange={(event) => editModule(activeModule.id, event.target.value)}
          />
          <InlineHelp>只追加到此模块。严格 JSON、事实边界和输出结构仍有代码侧校验；但自定义文本仍可能影响模型行为，请谨慎修改。</InlineHelp>
        </Card>}

        {selected.type === 'global' && <Card className="persona-studio__editor">
          <div className="persona-studio__panel-heading"><div><h4>全局人格补充</h4><p>保留旧设置语义：它是用户自定义补充，不会覆盖 Pippi 的内置身份核心。</p></div></div>
          <Input label="机器人名称" hint="多个名称用英文逗号分隔。" value={draft.botNames} onChange={(event) => updateDraft({ botNames: event.target.value })} />
          <Textarea label="跨场景人格补充" rows={12} spellCheck={false} value={draft.personalityPrompt} onChange={(event) => updateDraft({ personalityPrompt: event.target.value })} />
          <InlineHelp>此补充目前随主要对话与 osu! 分析人格链路注入。独立画像、审核等模块使用各自的模块补充设置。</InlineHelp>
        </Card>}

        <Card className="persona-studio__calls">
          <div className="persona-studio__panel-heading">
            <div><h4><Eye size={16} />实际模型调用</h4><p>短期内存留存，重启后清空；文本可能包含用户消息上下文，限管理控制台查看。</p></div>
            <span className="persona-studio__count"><Activity size={13} />{visibleCalls.length} 条</span>
          </div>
          {visibleCalls.length === 0 ? <div className="persona-studio__empty">
            <MessageSquareText size={18} />
            <span>{loading ? '正在读取调用记录…' : activeModule ? '这个模块还没有捕获到调用。触发一次对应功能后刷新即可查看。' : '暂无模型调用快照。'}</span>
          </div> : <>
            <div className="persona-studio__run-list" role="list" aria-label="近期模型调用">
              {visibleCalls.map((call) => <button type="button" key={call.id} className={`persona-studio__run ${selectedCall?.id === call.id ? 'is-active' : ''}`} onClick={() => setSelectedCallId(call.id)}>
                <span><strong>{call.purpose || call.moduleName}</strong><small><Clock3 size={11} />{new Date(call.at).toLocaleString()}</small></span>
                <Pill tone={call.status === 'ok' ? 'success' : call.status === 'running' ? 'warning' : 'danger'}>{call.status === 'ok' ? '完成' : call.status === 'running' ? '运行中' : '失败'}</Pill>
              </button>)}
            </div>
            {selectedCall && <div className="persona-studio__snapshot">
              <div className="persona-studio__snapshot-meta">
                <Pill>{selectedCall.provider || 'provider 未知'} / {selectedCall.model || 'model 未知'}</Pill>
                <Pill>{selectedCall.durationMs ? `${selectedCall.durationMs} ms` : selectedCall.status}</Pill>
                {selectedCall.truncated && <Pill tone="warning">快照已截断</Pill>}
              </div>
              {(selectedCall.messages || []).map((message, index) => <details key={`${selectedCall.id}-${index}`} className="persona-studio__message" open={message.role === 'system' && index === 0}>
                <summary><span>{message.role}</span><small>{message.truncated ? '内容已截断' : `${String(message.content || '').length.toLocaleString()} 字符`}</small></summary>
                <pre>{message.content || '（空内容）'}</pre>
              </details>)}
              {selectedCall.tools && selectedCall.tools !== '[]' && <details className="persona-studio__message">
                <summary><span><Wrench size={13} />可用工具 schema</span><small>本次请求</small></summary>
                <pre>{selectedCall.tools}</pre>
              </details>}
              {selectedCall.response?.toolCalls && selectedCall.response.toolCalls !== '[]' && <details className="persona-studio__message" open>
                <summary><span><Braces size={13} />模型返回的工具调用</span><small>调用参数</small></summary>
                <pre>{selectedCall.response.toolCalls}</pre>
              </details>}
              {selectedCall.response?.content && <details className="persona-studio__message">
                <summary><span>模型输出</span><small>{String(selectedCall.response.content).length.toLocaleString()} 字符</small></summary>
                <pre>{selectedCall.response.content}</pre>
              </details>}
              <details className="persona-studio__message">
                <summary><span>请求参数与用量</span><small>格式 / 工具策略 / Token</small></summary>
                <pre>{JSON.stringify({
                  toolChoice: selectedCall.toolChoice,
                  responseFormat: selectedCall.responseFormat,
                  finishReason: selectedCall.response?.finishReason,
                  usage: selectedCall.response?.usage,
                }, null, 2)}</pre>
              </details>
              {selectedCall.error && <pre className="persona-studio__call-error">{selectedCall.error}</pre>}
              {relatedTrace && <details className="persona-studio__tool-events">
                <summary><span><ShieldCheck size={14} />工具执行时间线</span><small>{toolEvents.length} 个事件 · request trace 已关联</small></summary>
                {toolEvents.length ? toolEvents.map((event) => <div key={event.id} className="persona-studio__tool-event"><strong>{event.name}</strong><pre>{JSON.stringify(event.data || {}, null, 2)}</pre></div>) : <p>该请求追踪中没有工具执行事件。</p>}
              </details>}
              {!selectedCall.requestId && <p className="persona-studio__trace-note">该调用不属于 QQ 请求追踪；可查看模型返回的工具调用，但没有独立工具执行时间线。</p>}
            </div>}
          </>}
          <div className="persona-studio__privacy"><ShieldCheck size={13} />请求快照最多保留最近 32 次、只在当前进程内存中；图片/音频载荷与推理过程不记录，提示词文本会做密钥脱敏。</div>
        </Card>
      </main>
    </div>
  </div>;
}
