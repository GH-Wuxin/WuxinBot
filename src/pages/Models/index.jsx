import React, { useEffect, useState } from 'react';
import { BrainCircuit, Eye, Globe2, Save, Settings2, Sparkles } from 'lucide-react';
import {
  Button,
  Card,
  InlineHelp,
  Input,
  NumberInput,
  SectionHeader,
  Select,
  SettingGroup,
  SettingRow,
  Slider,
  Switch,
} from '../../components/ui/index.jsx';
import { api } from '../../lib/api.js';

const providerOptions = [
  { value: 'deepseek', label: 'DeepSeek（默认）' },
  { value: 'openai-compatible', label: 'OpenAI 兼容接口' },
];

const baseModelOptions = [
  { value: 'deepseek-chat', label: 'DeepSeek Chat（日常聊天）' },
  { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner（更慢更会想）' },
  { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash（视觉）' },
  { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  { value: 'mimo-v2.5-pro', label: 'MiMo-V2.5-Pro（多模态）' },
  { value: 'mimo-v2.5', label: 'MiMo-V2.5' },
  { value: 'mimo-v2-omni', label: 'MiMo-V2-Omni（视觉理解）' },
  { value: 'mimo-v2-pro', label: 'MiMo-V2-Pro' },
];

export function ModelsPage({ db, saveSettings }) {
  const [draft, setDraft] = useState(db.settings);
  const [dirty, setDirty] = useState(false);
  const [testingLocal, setTestingLocal] = useState(false);
  const [localSearchStatus, setLocalSearchStatus] = useState(null);

  useEffect(() => {
    if (!dirty) setDraft(db.settings);
  }, [db.settings, dirty]);

  const updateDraft = (next) => {
    setDirty(true);
    setDraft((current) => typeof next === 'function' ? next(current) : { ...current, ...next });
  };

  const looksLikeMimoEndpoint = (value) => /(mimo|xiaomimimo|token-plan-cn)/i.test(String(value || ''));
  const isDeepSeekModel = (value) => /^deepseek-/i.test(String(value || ''));
  const isMimoModel = (value) => /^mimo-/i.test(String(value || ''));
  const withProviderDefaults = (patch) => {
    const next = { ...draft, ...patch };
    if (patch.model !== undefined && isMimoModel(next.model)) {
      next.llmProvider = 'openai-compatible';
      if (!looksLikeMimoEndpoint(next.apiBaseUrl)) next.apiBaseUrl = 'https://token-plan-cn.xiaomimimo.com/v1';
    } else if (patch.model !== undefined && isDeepSeekModel(next.model)) {
      next.llmProvider = 'deepseek';
      next.apiBaseUrl = 'https://api.deepseek.com';
    } else if (patch.llmProvider === 'deepseek') {
      next.apiBaseUrl = 'https://api.deepseek.com';
      if (isMimoModel(next.model)) next.model = 'deepseek-v4-flash';
    } else if (patch.llmProvider === 'openai-compatible') {
      if (!looksLikeMimoEndpoint(next.apiBaseUrl)) next.apiBaseUrl = 'https://token-plan-cn.xiaomimimo.com/v1';
      if (isDeepSeekModel(next.model)) next.model = 'mimo-v2.5';
    } else if (patch.apiBaseUrl !== undefined && looksLikeMimoEndpoint(next.apiBaseUrl)) {
      next.llmProvider = 'openai-compatible';
      if (isDeepSeekModel(next.model)) next.model = 'mimo-v2.5';
    }
    return next;
  };

  const testLocalSearch = async () => {
    setTestingLocal(true);
    setLocalSearchStatus(null);
    try {
      const data = await api('/api/search/test-local', { method: 'POST' });
      if (data.baseUrl) {
        const patch = { enableWebSearch: true, searchProvider: 'searxng', searchBaseUrl: data.baseUrl };
        updateDraft(patch);
        await saveSettings(patch);
        setLocalSearchStatus({ ok: true, message: '已检测到本地 SearXNG，并已保存配置。' });
      } else {
        setLocalSearchStatus({ ok: false, message: data.message || '未检测到本地搜索服务' });
      }
    } catch (cause) {
      setLocalSearchStatus({ ok: false, message: `检测失败：${cause.message || '网络错误'}` });
    } finally {
      setTestingLocal(false);
    }
  };

  const currentModel = draft.model || 'deepseek-v4-flash';
  const modelOptions = baseModelOptions.some((option) => option.value === currentModel)
    ? baseModelOptions
    : [...baseModelOptions, { value: currentModel, label: `当前自定义：${currentModel}` }];

  const save = async () => {
    await saveSettings(withProviderDefaults({ model: draft.customModel?.trim() || draft.model, customModel: '' }));
    setDirty(false);
  };

  return <div className="console-page models-page">
    <SectionHeader eyebrow="System / Models" title="模型与推理设置" description="管理当前 LLM、生成参数、视觉输入和搜索能力；所有保存继续写入现有 settings。" actions={<Button variant="primary" icon={Save} onClick={save}>保存模型设置</Button>} />
    <div className="models-layout">
      <div className="console-setting-stack">
        <SettingGroup title="供应商与模型" description="切换已配置过的模型系列时会复用对应接口与密钥。">
          <SettingRow title="接口供应商" description="DeepSeek 或 OpenAI-compatible endpoint" control={<Select value={draft.llmProvider || 'deepseek'} onChange={(event) => updateDraft(withProviderDefaults({ llmProvider: event.target.value }))} options={providerOptions} />} />
          <SettingRow title="API Key" description={draft.apiKey === '已填写' ? '已配置；留空不会覆盖' : '当前供应商的访问密钥'} control={<Input type="password" placeholder={draft.apiKey === '已填写' ? '已填写，留空不改' : ''} value={draft.apiKey === '已填写' ? '' : draft.apiKey || ''} onChange={(event) => updateDraft({ apiKey: event.target.value })} />} />
          <SettingRow title="API 地址" description="OpenAI-compatible base URL" control={<Input value={draft.apiBaseUrl || ''} onChange={(event) => updateDraft(withProviderDefaults({ apiBaseUrl: event.target.value }))} />} />
          <SettingRow title="模型" control={<Select value={currentModel} onChange={(event) => updateDraft(withProviderDefaults({ model: event.target.value }))} options={modelOptions} />} />
          <SettingRow title="自定义模型名" description="留空则使用上面的选择" control={<Input value={draft.customModel || ''} onChange={(event) => updateDraft({ customModel: event.target.value })} />} />
        </SettingGroup>

        <SettingGroup title="生成参数" description="控制回复风格、长度和上下文预算。">
          <Slider label="创造性" min={0} max={1.5} step={0.05} value={draft.temperature} onChange={(temperature) => updateDraft({ temperature })} />
          <Slider label="单次回复长度" min={80} max={1200} step={20} value={draft.maxTokens} onChange={(maxTokens) => updateDraft({ maxTokens })} />
          <Slider label="基础最近消息数" min={5} max={80} value={draft.contextLimit} onChange={(contextLimit) => updateDraft({ contextLimit })} />
          <SettingRow title="按需扩展群聊历史" description="发现引用旧话题时，从更早记录中检索相关片段" control={<Switch checked={draft.groupContextSearchEnabled !== false} onChange={(event) => updateDraft({ groupContextSearchEnabled: event.target.checked })} />} />
          {draft.groupContextSearchEnabled !== false && <>
            <Slider label="旧历史搜索范围" min={50} max={2000} step={50} value={draft.groupContextSearchPoolSize || 400} onChange={(groupContextSearchPoolSize) => updateDraft({ groupContextSearchPoolSize })} hint="条" />
            <Slider label="最多补入旧消息" min={3} max={80} value={draft.groupContextSearchMaxExtra || 24} onChange={(groupContextSearchMaxExtra) => updateDraft({ groupContextSearchMaxExtra })} hint="条" />
            <Slider label="旧历史补入预算" min={2000} max={40000} step={1000} value={draft.groupContextSearchCharBudget || 12000} onChange={(groupContextSearchCharBudget) => updateDraft({ groupContextSearchCharBudget })} hint="字符" />
          </>}
          <Slider label="Owner 私聊上下文软上限" min={4000} max={60000} step={1000} value={draft.ownerPrivateContextCharBudget || 24000} onChange={(ownerPrivateContextCharBudget) => updateDraft({ ownerPrivateContextCharBudget })} hint="字符" />
          <SettingRow title="自动选择模型" description="复杂任务允许升级到更强模型" control={<Switch checked={draft.enableAutoModel !== false} onChange={(event) => updateDraft({ enableAutoModel: event.target.checked })} />} />
          <SettingRow title="纯人设模式" description="忽略系统事实注入" control={<Switch checked={draft.ignoreSystemFacts === true} onChange={(event) => updateDraft({ ignoreSystemFacts: event.target.checked })} />} />
          <SettingRow title="画像 V2 防近因" description="长期画像与近期动态分层（实验性）" control={<Switch checked={draft.profileAntiRecencyV2 === true} onChange={(event) => updateDraft({ profileAntiRecencyV2: event.target.checked })} />} />
          <SettingRow title="升级恭喜通知" description="群内自动祝贺" control={<Switch checked={draft.levelUpNotifyEnabled !== false} onChange={(event) => updateDraft({ levelUpNotifyEnabled: event.target.checked })} />} />
        </SettingGroup>
      </div>

      <div className="console-setting-stack">
        <SettingGroup title="视觉输入" description="DeepSeek V4 Flash 使用 Vision 实验端点；其他纯文字模型不会传入图片。">
          <SettingRow title="视觉能力" control={<Select value={draft.visionMode || 'auto'} onChange={(event) => updateDraft({ visionMode: event.target.value })} options={[{ value: 'auto', label: '自动识别（推荐）' }, { value: 'on', label: '按多模态模型处理' }, { value: 'off', label: '按纯文字模型处理' }]} />} />
          <SettingRow title="图片传输方式" description="本地/内网图片可转换为 data URL" control={<Select value={draft.visionImageTransport || 'auto'} onChange={(event) => updateDraft({ visionImageTransport: event.target.value })} options={[{ value: 'auto', label: '自动' }, { value: 'url', label: '只传 URL' }, { value: 'data', label: '转成 data URL' }]} />} />
          <Slider label="单次最多传入图片数" min={1} max={6} value={draft.visionMaxImages || 3} onChange={(visionMaxImages) => updateDraft({ visionMaxImages })} />
        </SettingGroup>

        <SettingGroup title="联网搜索" description="Pippi 会根据问题的时效性和不确定性自行决定是否搜索；用户明确要求时则保证执行。">
          <SettingRow title="启用联网搜索" description="只把模型改写后的检索词发送给搜索服务，不发送整段群聊历史" control={<Switch checked={draft.enableWebSearch === true} onChange={(event) => updateDraft({ enableWebSearch: event.target.checked })} />} />
          {draft.enableWebSearch === true && <>
            <SettingRow title="搜索模式" description="限制单轮最多搜索次数：快速 1 次、平衡 2 次、深度 3 次；模型可少搜或不搜" control={<Select value={draft.webSearchMode || 'balanced'} onChange={(event) => updateDraft({ webSearchMode: event.target.value })} options={[{ value: 'fast', label: '快速' }, { value: 'balanced', label: '平衡（推荐）' }, { value: 'deep', label: '深度' }]} />} />
            <SettingRow title="真实搜索源" control={<Select value={draft.searchProvider || 'disabled'} onChange={(event) => updateDraft({ searchProvider: event.target.value })} options={[{ value: 'disabled', label: '未接入（关闭）' }, { value: 'searxng', label: 'SearXNG' }]} />} />
            {draft.searchProvider === 'disabled' && <InlineHelp tone="warning">联网开关已打开，但真实搜索源仍未接入；显式搜索会被拒绝。</InlineHelp>}
            {draft.searchProvider === 'searxng' && <SettingRow title="SearXNG 地址" control={<Input value={draft.searchBaseUrl || ''} onChange={(event) => updateDraft({ searchBaseUrl: event.target.value })} />} />}
            <div className="console-actions"><Button icon={Globe2} loading={testingLocal} onClick={testLocalSearch}>{testingLocal ? '检测中…' : '检测本地搜索服务'}</Button>{localSearchStatus && <InlineHelp tone={localSearchStatus.ok ? 'normal' : 'warning'}>{localSearchStatus.message}</InlineHelp>}</div>
          </>}
        </SettingGroup>

        <SettingGroup title="主动参与" description="这些参数只影响自然/轻度模式的接话判断。">
          <SettingRow title="每群每小时 AI 判断次数" description="0 表示无限制" control={<NumberInput min={0} max={1000} value={draft.llmReplyGateMaxPerHour ?? 0} onChange={(llmReplyGateMaxPerHour) => updateDraft({ llmReplyGateMaxPerHour })} />} />
          <SettingRow title="自然群友阈值" control={<NumberInput min={0} max={100} value={draft.llmReplyGateNaturalThreshold ?? 45} onChange={(llmReplyGateNaturalThreshold) => updateDraft({ llmReplyGateNaturalThreshold })} />} />
          <SettingRow title="轻度参与阈值" control={<NumberInput min={0} max={100} value={draft.llmReplyGateLightThreshold ?? 70} onChange={(llmReplyGateLightThreshold) => updateDraft({ llmReplyGateLightThreshold })} />} />
          <SettingRow title="思考状态提示" control={<Select value={draft.thinkingNoticeMode || 'slow'} onChange={(event) => updateDraft({ thinkingNoticeMode: event.target.value })} options={[{ value: 'off', label: '关闭' }, { value: 'simple', label: '简短' }, { value: 'detail', label: '详细' }, { value: 'slow', label: '仅慢请求显示' }]} />} />
          {draft.thinkingNoticeMode === 'slow' && <SettingRow title="慢请求延迟" description="至少 500ms" control={<NumberInput min={500} value={draft.thinkingNoticeDelayMs || 3000} onChange={(thinkingNoticeDelayMs) => updateDraft({ thinkingNoticeDelayMs })} suffix="ms" />} />}
        </SettingGroup>

        <Card className="model-guide">
          <div className="console-section__title"><BrainCircuit size={18} /><div><h3>配置提示</h3><p>按当前运行时能力说明，不推断供应商状态。</p></div></div>
          <p><Sparkles size={14} />创造性越高越活泼，越低越稳定；小群聊天可从 0.85 开始。</p>
          <p><Eye size={14} />视觉能力需要实际多模态模型支持，传输方式不会让纯文本模型获得视觉。</p>
          <p><Settings2 size={14} />DeepSeek 官方 Chat API 没有内置搜索；没有真实搜索源时，请求会被拒绝而不是假装联网。</p>
        </Card>
      </div>
    </div>
  </div>;
}
