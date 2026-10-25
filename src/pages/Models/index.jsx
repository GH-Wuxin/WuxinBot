import React, { useEffect, useState } from 'react';
import { BrainCircuit, Globe2, LogIn, LogOut, RefreshCw, Save } from 'lucide-react';
import {
  Button,
  InlineHelp,
  Input,
  NumberInput,
  SectionHeader,
  SegmentedControl,
  Select,
  SettingGroup,
  SettingRow,
  Slider,
  Switch,
} from '../../components/ui/index.jsx';
import { api } from '../../lib/api.js';
import { codexLoginView } from './codexStatus.js';
import { quotaWindows } from '../Dashboard/usageView.js';
import { RefreshButton } from '../../components/ui/RefreshButton.jsx';

const providerOptions = [
  { value: 'deepseek', label: 'DeepSeek（默认）' },
  { value: 'openai-compatible', label: 'OpenAI 兼容接口' },
  { value: 'codex-app-server', label: '个人 ChatGPT / Codex 额度' },
];

const defaultCodexModelOptions = [
  { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna（快、省额度）' },
  { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra（均衡）' },
  { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol（最强）' },
  { value: 'gpt-5.5', label: 'GPT-5.5' },
];

const baseModelOptions = [
  { value: 'deepseek-chat', label: 'DeepSeek Chat（日常聊天）' },
  { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner（更慢更会想）' },
  { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash（视觉）' },
  { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
];

export function ModelsPage({ db, saveSettings }) {
  const [draft, setDraft] = useState(db.settings);
  const [dirty, setDirty] = useState(false);
  const [codexStatus, setCodexStatus] = useState(null);
  const [codexModels, setCodexModels] = useState([]);
  const [codexLimits, setCodexLimits] = useState(null);
  const [apiModels, setApiModels] = useState([]);
  const [apiModelsNote, setApiModelsNote] = useState('');
  const [codexBusy, setCodexBusy] = useState(false);
  const [codexMessage, setCodexMessage] = useState('');
  const [section, setSection] = useState('account');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    if (!dirty) setDraft(db.settings);
  }, [db.settings, dirty]);

  // 模型清单来自上游：切供应商/改地址时重新拉一次，失败就退回内置清单。
  useEffect(() => {
    let cancelled = false;
    const query = new URLSearchParams({
      provider: String(draft.llmProvider || 'deepseek'),
      apiBaseUrl: String(draft.apiBaseUrl || ''),
    });
    api('/api/models?' + query.toString(), { timeoutMs: 15000 })
      .then((result) => {
        if (cancelled) return;
        setApiModels(Array.isArray(result?.models) ? result.models : []);
        setApiModelsNote(result?.error || '');
      })
      .catch((cause) => {
        if (cancelled) return;
        setApiModels([]);
        setApiModelsNote(cause?.message || String(cause));
      });
    return () => { cancelled = true; };
  }, [draft.llmProvider, draft.apiBaseUrl]);

  const updateDraft = (next) => {
    setDirty(true);
    setDraft((current) => typeof next === 'function' ? next(current) : { ...current, ...next });
  };

  const isDeepSeekModel = (value) => /^deepseek-/i.test(String(value || ''));
  const withProviderDefaults = (patch) => {
    const next = { ...draft, ...patch };
    if (patch.llmProvider === 'codex-app-server') {
      if (draft.llmProvider !== 'codex-app-server') {
        next.codexFallbackProvider = draft.llmProvider || 'deepseek';
        next.codexFallbackModel = draft.model || 'deepseek-v4-flash';
      }
      next.codexModel ||= 'gpt-5.6-luna';
      next.codexReasoningEffort ||= 'low';
    } else if (patch.model !== undefined && isDeepSeekModel(next.model)) {
      next.llmProvider = 'deepseek';
      next.apiBaseUrl = 'https://api.deepseek.com';
    } else if (patch.llmProvider === 'deepseek') {
      next.apiBaseUrl = 'https://api.deepseek.com';
    }
    return next;
  };

  const refreshCodex = async () => {
    setCodexBusy(true);
    setCodexMessage('');
    let accountStatusRead = false;
    try {
      const statusResult = await api('/api/codex/status', { timeoutMs: 20000 });
      setCodexStatus(statusResult.status);
      accountStatusRead = true;
      setCodexLimits(null);
      if (statusResult.status?.error || statusResult.status?.authStatus === 'unknown') {
        setCodexModels([]);
        return;
      }
      const modelResult = await api('/api/codex/models', { timeoutMs: 25000 });
      setCodexModels(modelResult.models || []);
      if (statusResult.status?.authenticated) {
        const limitResult = await api('/api/codex/rate-limits', { timeoutMs: 20000 });
        setCodexLimits(limitResult.limits || null);
      } else {
        setCodexLimits(null);
      }
    } catch (cause) {
      setCodexLimits(null);
      if (!accountStatusRead) {
        setCodexStatus({ authStatus: 'unknown', running: true, error: cause.message || '状态接口不可用' });
        setCodexModels([]);
      }
      setCodexMessage(cause.message || 'Codex 状态读取失败');
    } finally {
      setCodexBusy(false);
    }
  };

  useEffect(() => {
    if (draft.llmProvider === 'codex-app-server' && !codexStatus && !codexBusy) void refreshCodex();
  }, [draft.llmProvider]);

  const loginCodex = async () => {
    setCodexBusy(true);
    setCodexMessage('');
    const loginWindow = window.open('about:blank', '_blank');
    try {
      const result = await api('/api/codex/login', { method: 'POST', timeoutMs: 35000 });
      const authUrl = result.login?.authUrl || result.login?.verificationUrl;
      if (!authUrl) throw new Error('服务端没有返回登录地址');
      if (loginWindow) loginWindow.location.href = authUrl;
      else window.open(authUrl, '_blank', 'noopener,noreferrer');
      setCodexMessage('登录页已打开；完成授权后点击“刷新状态”。');
    } catch (cause) {
      loginWindow?.close();
      setCodexMessage(cause.message || '登录启动失败');
    } finally {
      setCodexBusy(false);
    }
  };

  const logoutCodex = async () => {
    setCodexBusy(true);
    try {
      const result = await api('/api/codex/logout', { method: 'POST', timeoutMs: 20000 });
      setCodexStatus(result.status);
      setCodexLimits(null);
      setCodexMessage('已退出 Codex 使用的 ChatGPT 账号。');
    } catch (cause) {
      setCodexMessage(cause.message || '退出失败');
    } finally {
      setCodexBusy(false);
    }
  };

  const currentModel = draft.model || 'deepseek-v4-flash';
  // 模型清单以上游为准；拉不到时才退回内置的几条（并保留当前值，别把选择弄丢）。
  const upstreamOptions = apiModels.map((model) => ({ value: model.id, label: model.label || model.id }));
  const sourceOptions = upstreamOptions.length ? upstreamOptions : baseModelOptions;
  const modelOptions = sourceOptions.some((option) => option.value === currentModel)
    ? sourceOptions
    : [...sourceOptions, { value: currentModel, label: `当前：${currentModel}` }];

  const codexModelOptions = (codexModels.length ? codexModels.map((model) => ({
    value: model.model || model.id,
    label: model.displayName || model.model || model.id,
  })) : [...defaultCodexModelOptions]);
  const selectedCodexModel = draft.codexModel || 'gpt-5.6-luna';
  if (!codexModelOptions.some((option) => option.value === selectedCodexModel)) {
    codexModelOptions.push({ value: selectedCodexModel, label: `当前：${selectedCodexModel}` });
  }

  const save = async () => {
    setSaving(true);
    setSaveError('');
    const patch = draft.llmProvider === 'codex-app-server'
      ? withProviderDefaults({ customModel: '' })
      : withProviderDefaults({ model: draft.customModel?.trim() || draft.model, customModel: '' });
    try {
      await saveSettings(patch);
      setDirty(false);
    } catch (error) { setSaveError(error.message || '保存失败，请重试'); }
    finally { setSaving(false); }
  };

  const runningModel = db.settings.effectiveModel || (db.settings.llmProvider === 'codex-app-server' ? db.settings.codexModel : db.settings.model) || '未设置';
  const usage = db.usage || {};
  const today = db.usageStats?.today || {};
  const loginView = codexLoginView(codexStatus);
  const windows = quotaWindows(codexLimits);
  const setNumber = (field) => (event) => updateDraft({ [field]: Number(event.target.value) });

  return <>
    <div className="page-head">
      <div><h1>模型</h1><p>换模型只影响之后的请求，已经在跑的不受影响。</p></div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn btn-ghost" disabled={codexBusy} onClick={refreshCodex}>{codexBusy ? '检测中…' : '测试连接'}</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{saving ? '保存中…' : '保存模型设置'}</button>
      </div>
    </div>

    {saveError && <div className="note" style={{ color: 'var(--red)', marginBottom: 12 }}>{saveError}</div>}

    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <span className="brand-puck" style={{ boxShadow: 'none' }}>AI</span>
        <div>
          <div className="muted" style={{ fontSize: 12 }}>当前运行模型</div>
          <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-.02em' }}>{runningModel}</div>
        </div>
        <span style={{ marginLeft: 'auto' }} className={dirty ? 'chip chip--amber' : 'chip chip--mint'}>{dirty ? '有未保存的更改' : '设置已同步'}</span>
      </div>
    </div>

    <div className="seg" style={{ marginBottom: 16 }}>
      {[['account', '账号与模型'], ['conversation', '对话与上下文'], ['capabilities', '视觉与搜索'], ['participation', '主动参与']].map(([id, label]) => <button key={id} type="button" className={section === id ? 'is-active' : ''} onClick={() => setSection(id)}>{label}</button>)}
    </div>

    <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1fr)', gap: 16, alignItems: 'start' }}>
      <div className="stack">
        {section === 'account' && <div className="card">
          <div className="card-head"><span className="card-title">供应商与模型</span><span className="muted" style={{ fontSize: 12 }}>切换系列会复用对应接口与密钥</span></div>
          <div className="field"><label>接口供应商</label>
            <select value={draft.llmProvider || 'deepseek'} onChange={(event) => updateDraft(withProviderDefaults({ llmProvider: event.target.value }))}>
              {providerOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>

          {draft.llmProvider === 'codex-app-server' ? <>
            <div className="kv"><span>ChatGPT 登录</span><b>{loginView.description}</b></div>
            {codexStatus?.error && <div className="note" style={{ color: 'var(--amber)' }}>{codexStatus.error}{codexStatus.diagnostic ? `；${codexStatus.diagnostic}` : ''}</div>}
            {codexMessage && <div className="note" style={{ color: 'var(--mint)' }}>{codexMessage}</div>}
            <div style={{ display: 'flex', gap: 8, margin: '10px 0' }}>
              {loginView.canLogin && <button type="button" className="btn btn-sm" disabled={codexBusy} onClick={loginCodex}>登录 ChatGPT</button>}
              <RefreshButton className="btn btn-sm" label="刷新状态" disabled={codexBusy} onClick={refreshCodex} />
              {codexStatus?.authenticated && <button type="button" className="btn btn-sm btn-ghost" onClick={logoutCodex}>退出</button>}
            </div>
            <div className="field"><label>Codex 模型</label>
              <select value={selectedCodexModel} onChange={(event) => updateDraft({ codexModel: event.target.value })}>
                {codexModelOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </div>
            <div className="field"><label>推理强度</label>
              <select value={draft.codexReasoningEffort || 'low'} onChange={(event) => updateDraft({ codexReasoningEffort: event.target.value })}>
                <option value="low">Low（推荐聊天）</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="xhigh">XHigh</option>
                <option value="max">Max</option>
              </select>
            </div>
            <div className="field"><label>Codex 可执行文件</label><input value={draft.codexExecutable || 'codex'} onChange={(event) => updateDraft({ codexExecutable: event.target.value })} /></div>
            {codexStatus?.command && <div className="note">当前解析路径：{codexStatus.command}</div>}
            <div className="row">
              <div className="row-main"><div className="row-title">自动降级</div><div className="row-sub">未登录、超时或额度不可用时回到 {draft.codexFallbackModel || draft.model || '旧模型'}</div></div>
              <button type="button" className={'switch' + (draft.codexFallbackEnabled !== false ? ' is-on' : '')} aria-label="自动降级" onClick={() => updateDraft({ codexFallbackEnabled: draft.codexFallbackEnabled === false })} />
            </div>
          </> : <>
            <div className="field"><label>API Key</label><input type="password" placeholder={draft.apiKey === '已填写' ? '已填写，留空不改' : ''} value={draft.apiKey === '已填写' ? '' : draft.apiKey || ''} onChange={(event) => updateDraft({ apiKey: event.target.value })} /></div>
            <div className="field"><label>API 地址</label><input value={draft.apiBaseUrl || ''} onChange={(event) => updateDraft(withProviderDefaults({ apiBaseUrl: event.target.value }))} /></div>
            <div className="field"><label>模型</label>
              <select value={currentModel} onChange={(event) => updateDraft(withProviderDefaults({ model: event.target.value }))}>
                {modelOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </div>
            <div className="field"><label>自定义模型名</label><input value={draft.customModel || ''} onChange={(event) => updateDraft({ customModel: event.target.value })} placeholder="留空则使用上面的选择" /></div>
            {apiModelsNote && <div className="note">上游模型清单不可用：{apiModelsNote}</div>}
          </>}
        </div>}

        {section === 'conversation' && <div className="card">
          <div className="card-head"><span className="card-title">生成参数与上下文</span></div>
          {draft.llmProvider === 'codex-app-server' && <div className="note">当前 Codex 适配器不提供创造性和最大输出 Token 的硬控制；这两项保留用于 API 模型通道。</div>}
          <div style={{ display: 'flex', gap: 10 }}>
            <div className="field" style={{ flex: 1 }}><label>创造性（0–1.5）</label><input type="number" min="0" max="1.5" step="0.05" value={draft.temperature ?? 0.8} onChange={setNumber('temperature')} /></div>
            <div className="field" style={{ flex: 1 }}><label>单次回复长度</label><input type="number" min="80" max="1200" step="20" value={draft.maxTokens ?? 600} onChange={setNumber('maxTokens')} /></div>
          </div>
          <div className="field"><label>基础最近消息数</label><input type="number" min="5" max="80" value={draft.contextLimit ?? 30} onChange={setNumber('contextLimit')} /></div>
          <div className="row">
            <div className="row-main"><div className="row-title">按需扩展群聊历史</div><div className="row-sub">发现引用旧话题时，从更早记录中检索相关片段</div></div>
            <button type="button" className={'switch' + (draft.groupContextSearchEnabled !== false ? ' is-on' : '')} aria-label="按需扩展群聊历史" onClick={() => updateDraft({ groupContextSearchEnabled: draft.groupContextSearchEnabled === false })} />
          </div>
          {draft.groupContextSearchEnabled !== false && <div style={{ display: 'flex', gap: 10 }}>
            <div className="field" style={{ flex: 1 }}><label>搜索范围（条）</label><input type="number" min="50" max="2000" step="50" value={draft.groupContextSearchPoolSize || 400} onChange={setNumber('groupContextSearchPoolSize')} /></div>
            <div className="field" style={{ flex: 1 }}><label>最多补入（条）</label><input type="number" min="3" max="80" value={draft.groupContextSearchMaxExtra || 24} onChange={setNumber('groupContextSearchMaxExtra')} /></div>
            <div className="field" style={{ flex: 1 }}><label>补入预算（字符）</label><input type="number" min="2000" max="40000" step="1000" value={draft.groupContextSearchCharBudget || 12000} onChange={setNumber('groupContextSearchCharBudget')} /></div>
          </div>}
          <div className="field"><label>Owner 私聊上下文软上限（字符）</label><input type="number" min="4000" max="60000" step="1000" value={draft.ownerPrivateContextCharBudget || 24000} onChange={setNumber('ownerPrivateContextCharBudget')} /></div>
          {[['reasoningEnabled', '启用模型思考', 'V2 判断与发送前复核使用 low，回复按任务选择档位；会增加延迟与 Token'], ['ignoreSystemFacts', '纯人设模式', '忽略系统事实注入'], ['profileAntiRecencyV2', '画像 V2 防近因', '长期画像与近期动态分层（实验性）'], ['levelUpNotifyEnabled', '升级恭喜通知', '群内自动祝贺']].map(([field, title, sub]) => <div className="row" key={field}>
            <div className="row-main"><div className="row-title">{title}</div><div className="row-sub">{sub}</div></div>
            <button type="button" className={'switch' + ((field === 'levelUpNotifyEnabled' ? draft[field] !== false : draft[field] === true) ? ' is-on' : '')} aria-label={title} onClick={() => updateDraft({ [field]: field === 'levelUpNotifyEnabled' ? draft[field] === false : draft[field] !== true })} />
          </div>)}
        </div>}

        {section === 'capabilities' && <>
          <div className="card">
            <div className="card-head"><span className="card-title">视觉输入</span><span className="muted" style={{ fontSize: 12 }}>需要多模态模型</span></div>
            <div className="field"><label>视觉能力</label>
              <select value={draft.visionMode || 'auto'} onChange={(event) => updateDraft({ visionMode: event.target.value })}>
                <option value="auto">自动识别（推荐）</option>
                <option value="on">按多模态模型处理</option>
                <option value="off">按纯文字模型处理</option>
              </select>
            </div>
            <div className="field"><label>图片传输方式</label>
              <select value={draft.visionImageTransport || 'auto'} onChange={(event) => updateDraft({ visionImageTransport: event.target.value })}>
                <option value="auto">自动</option>
                <option value="url">只传 URL</option>
                <option value="data">转成 data URL</option>
              </select>
            </div>
            <div className="field"><label>单次最多传入图片数</label><input type="number" min="1" max="6" value={draft.visionMaxImages || 3} onChange={setNumber('visionMaxImages')} /></div>
          </div>

          <div className="card">
            <div className="card-head"><span className="card-title">联网搜索</span><span className="muted" style={{ fontSize: 12 }}>只发送检索词，不发送整段群聊</span></div>
            <div className="row">
              <div className="row-main"><div className="row-title">osu! 官方搜索</div><div className="row-sub">Wiki、新闻、更新、谱面与公开论坛；论坛内容属于玩家观点</div></div>
              <button type="button" className={'switch' + (draft.osuSearchEnabled === true ? ' is-on' : '')} aria-label="启用 osu! 官方搜索" onClick={() => updateDraft({ osuSearchEnabled: draft.osuSearchEnabled !== true })} />
            </div>
            {draft.osuSearchEnabled === true && <p className="note">复用「osu!」页面的 API 凭据。Pippi 自行选择检索词、阅读原文并附来源；每轮最多检索或阅读 4 次。新闻按年度标题和近期摘要检索，更新日志覆盖所选频道最近 21 个构建。</p>}
          </div>
        </>}

        {section === 'participation' && <div className="card">
          <div className="card-head"><span className="card-title">主动参与</span><span className="muted" style={{ fontSize: 12 }}>按群模式和当前对话判断</span></div>
          <p className="note">轻度参与主要接住明确的交流机会；自然群友也会接梗、回应分享。参与意愿由模型结合上下文、关系和情绪判断，频率与冷却在群聊页面设置，评估预算在社交页面设置。</p>
          <div className="field"><label>思考状态提示</label>
            <select value={draft.thinkingNoticeMode || 'slow'} onChange={(event) => updateDraft({ thinkingNoticeMode: event.target.value })}>
              <option value="off">关闭</option>
              <option value="simple">简短</option>
              <option value="detail">详细</option>
              <option value="slow">仅慢请求显示</option>
            </select>
          </div>
          {draft.thinkingNoticeMode === 'slow' && <div className="field"><label>慢请求延迟（ms，至少 500）</label><input type="number" min="500" value={draft.thinkingNoticeDelayMs || 3000} onChange={setNumber('thinkingNoticeDelayMs')} /></div>}
        </div>}
      </div>

      <div className="stack">
        <div className="card">
          <div className="card-head"><span className="card-title">用量与限额</span></div>
          <div className="kv"><span>累计请求</span><b>{Number(usage.requests || 0).toLocaleString()}</b></div>
          <div className="kv"><span>累计 Token</span><b>{Number(usage.totalTokens || 0).toLocaleString()}</b></div>
          <div className="kv"><span>今日请求</span><b>{Number(today.requests || 0).toLocaleString()}</b></div>
          <div className="kv"><span>今日 Token</span><b>{Number(today.totalTokens || 0).toLocaleString()}</b></div>
          <div className="meter" style={{ marginTop: 12 }}><i style={{ width: (today.cacheMeasuredPromptTokens ? Math.round((today.cachedTokens / today.cacheMeasuredPromptTokens) * 100) : 0) + '%' }} /></div>
          <div className="note" style={{ marginTop: 8 }}>今日缓存命中率 {today.cacheMeasuredPromptTokens ? ((today.cachedTokens / today.cacheMeasuredPromptTokens) * 100).toFixed(1) + '%' : '—'}（本地统计，非账单）</div>
        </div>

        <div className="card">
          <div className="card-head"><span className="card-title">Codex 通道</span><span className={'chip' + (codexStatus?.authenticated ? ' chip--mint' : '')}>{codexStatus?.authenticated ? '已登录' : draft.llmProvider === 'codex-app-server' ? '未登录' : '未启用'}</span></div>
          <div className="kv"><span>登录状态</span><b>{loginView.description}</b></div>
          {windows.length ? windows.map((window) => <div className="kv" key={window.key}>
            <span>{window.bucket} · {window.label}</span>
            <b>{window.used == null ? '未知' : Math.round(100 - window.used) + '% 剩余'}</b>
          </div>) : <div className="kv"><span>配额窗口</span><b>{codexLimits ? '无数据' : '未读取'}</b></div>}
          <div className="kv"><span>推理强度</span><b>{draft.codexReasoningEffort || 'low'}</b></div>
          <div className="kv"><span>自动降级</span><b>{draft.codexFallbackEnabled !== false ? '开启' : '关闭'}</b></div>
          <div className="note" style={{ marginTop: 8 }}>账号额度与本地 Token 用量是两个口径，这里不做换算。</div>
        </div>

        <div className="card">
          <div className="card-head"><span className="card-title">当前生效</span></div>
          <div className="kv"><span>供应商</span><b>{draft.llmProvider === 'codex-app-server' ? 'Codex 配额' : draft.llmProvider === 'openai-compatible' ? 'OpenAI 兼容' : 'DeepSeek'}</b></div>
          <div className="kv"><span>模型</span><b>{draft.llmProvider === 'codex-app-server' ? selectedCodexModel : (draft.customModel?.trim() || currentModel)}</b></div>
          <div className="kv"><span>osu! 官方搜索</span><b>{draft.osuSearchEnabled === true ? '开启' : '关闭'}</b></div>
          <div className="kv"><span>视觉</span><b>{draft.visionMode || 'auto'}</b></div>
        </div>
      </div>
    </div>
  </>;
}
