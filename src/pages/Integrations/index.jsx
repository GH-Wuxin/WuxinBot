import React, { useEffect, useMemo, useState } from 'react';
import { Cable, PlugZap, RefreshCw, Save, Server, Wifi } from 'lucide-react';
import { api } from '../../lib/api.js';
import { Button, Card, ErrorState, InlineHelp, Input, SectionHeader, SettingGroup, SettingRow, StatusBadge } from '../../components/ui/index.jsx';

const botLabels = { yumu: 'Yumu', kanon: 'Kanon', hydrant: 'Hydrant', lazybot: 'LazyBot' };
const statusTone = (status) => status === 'available' || status === 'configured' ? 'success' : status === 'degraded' ? 'warning' : 'danger';
const statusLabel = (status) => ({ available: 'Available', configured: 'Configured', degraded: 'Degraded', unavailable: 'Unavailable' }[status] || status);

function ServiceCard({ icon: Icon, name, kind, status, endpoint, detail, error, actions }) {
  return <Card className={`integration-service integration-service--${status}`}>
    <div className="integration-service__heading"><span className="integration-service__icon"><Icon size={19} /></span><div><strong>{name}</strong><small>{kind}</small></div><StatusBadge tone={statusTone(status)}>{statusLabel(status)}</StatusBadge></div>
    <div className="integration-service__meta"><span>Endpoint</span><code title={endpoint}>{endpoint || '未配置'}</code></div>
    <p>{detail}</p>{error && <InlineHelp tone="danger">{error}</InlineHelp>}{actions && <div className="integration-service__actions">{actions}</div>}
  </Card>;
}

export function IntegrationsPage({ db, oneBot, saveSettings, refreshState }) {
  const [draft, setDraft] = useState(() => ({ ...db.settings, oneBotAccessToken: '' }));
  const [dirty, setDirty] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [detectResult, setDetectResult] = useState(null);
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState('');

  useEffect(() => {
    if (!dirty) setDraft({ ...db.settings, oneBotAccessToken: '' });
  }, [db.settings, dirty]);

  const loadStatus = async () => {
    try { setStatus(await api('/api/osu/status')); setStatusError(''); }
    catch (error) { setStatusError(error?.message || String(error)); }
  };

  useEffect(() => {
    loadStatus();
    const timer = setInterval(loadStatus, 10000);
    return () => clearInterval(timer);
  }, []);

  const update = (field, value) => { setDirty(true); setDraft((current) => ({ ...current, [field]: value })); };

  const autoDetect = async () => {
    setDetecting(true); setDetectResult(null);
    try {
      const data = await api('/api/onebot/autodetect');
      setDetectResult(data);
      if (data.detected) {
        setDirty(true);
        setDraft((current) => ({ ...current, oneBotHttpUrl: data.detected.httpUrl, oneBotWsUrl: data.detected.wsUrl }));
      }
    } catch (error) { setDetectResult({ detected: null, error: error?.message || String(error) }); }
    finally { setDetecting(false); }
  };

  const connect = async () => {
    setConnecting(true);
    try {
      await saveSettings(draft);
      setDirty(false);
      await api('/api/onebot/connect', { method: 'POST' });
      await refreshState();
    } finally { setConnecting(false); }
  };

  const oneBotStatus = oneBot.accountOnline === false ? 'unavailable' : oneBot.transportConnected && oneBot.apiReachable !== false ? 'available' : (draft.oneBotHttpUrl || draft.oneBotWsUrl) ? 'degraded' : 'unavailable';
  const friendlyError = oneBot.lastError?.includes('ECONNREFUSED') ? 'OneBot WebSocket 拒绝连接，请检查 NapCat 是否运行以及端口是否一致。' : oneBot.lastError || '';
  const rendererStatus = status?.renderer?.hasClients ? 'available' : status?.renderer?.listeningPort ? 'degraded' : 'unavailable';
  const externalBots = useMemo(() => status?.bots || [], [status]);

  return <div className="integrations-page">
    <SectionHeader eyebrow="System / Integrations" title="服务拓扑" description="核心连接与可选 osu! 服务分开呈现；所有状态都来自当前运行时探针。" actions={<Button icon={RefreshCw} onClick={async () => { await Promise.all([loadStatus(), refreshState()]); }}>刷新状态</Button>} />
    {statusError && <ErrorState title="集成状态读取失败" message={statusError} onRetry={loadStatus} />}
    <div className="integrations-core-grid">
      <ServiceCard icon={Wifi} name="OneBot / NapCat" kind="Core dependency" status={oneBotStatus} endpoint={draft.oneBotWsUrl || draft.oneBotHttpUrl} detail={oneBot.transportConnected ? '消息传输通道已连接。' : 'Console 可以保存配置，但 QQ 消息收发依赖该连接。'} error={friendlyError} actions={<><Button size="sm" icon={RefreshCw} loading={detecting} onClick={autoDetect}>自动检测</Button><Button size="sm" variant="primary" icon={PlugZap} loading={connecting} onClick={connect}>保存并连接</Button></>} />
      <ServiceCard icon={Server} name="yumu-image renderer" kind="Optional renderer" status={rendererStatus} endpoint={status?.renderer?.listeningPort ? `ws://127.0.0.1:${status.renderer.listeningPort}` : ''} detail={status?.renderer?.hasClients ? '已有经过认证的渲染客户端连接。' : status?.renderer?.listeningPort ? '渲染服务正在监听，但当前没有渲染客户端。' : '运行时尚未报告监听端口。'} />
    </div>
    <Card className="integrations-config"><SectionHeader eyebrow="Core Configuration" title="OneBot 连接" description="编辑期间共享状态轮询不会覆盖未保存草稿。" />
      <SettingGroup title="Transport" description="HTTP 用于动作调用，WebSocket 用于事件流。">
        <SettingRow title="HTTP endpoint" description="OneBot HTTP API 地址" control={<Input aria-label="OneBot HTTP 地址" value={draft.oneBotHttpUrl || ''} onChange={(event) => update('oneBotHttpUrl', event.target.value)} />} />
        <SettingRow title="WebSocket endpoint" description="OneBot 正向 WebSocket 地址" control={<Input aria-label="OneBot WebSocket 地址" value={draft.oneBotWsUrl || ''} onChange={(event) => update('oneBotWsUrl', event.target.value)} />} />
        <SettingRow title="Access token" description={db.settings.oneBotAccessToken === '已填写' ? '已配置；留空会保留当前 token。' : '服务未设置 token 时可以留空。'} control={<Input aria-label="OneBot Access Token" type="password" placeholder={db.settings.oneBotAccessToken === '已填写' ? '已填写，留空不改' : ''} value={draft.oneBotAccessToken || ''} onChange={(event) => update('oneBotAccessToken', event.target.value)} />} />
      </SettingGroup>
      <SettingGroup title="Identity" description="用于运行时识别机器人、Owner 与其他 Bot 消息。">
        <SettingRow title="Bot QQ" description="机器人自己的 QQ 号" control={<Input aria-label="机器人 QQ" value={draft.selfQq || ''} onChange={(event) => update('selfQq', event.target.value)} />} />
        <SettingRow title="Owner QQ" description="拥有控制台与管理指令权限的 QQ 号" control={<Input aria-label="Owner QQ" value={draft.ownerQq || ''} onChange={(event) => update('ownerQq', event.target.value)} />} />
        <SettingRow title="External Bot QQ" description="逗号分隔；用于避免 Bot 之间互相触发。" control={<Input aria-label="其他 Bot QQ" value={draft.externalBotQqs || ''} onChange={(event) => update('externalBotQqs', event.target.value)} />} />
      </SettingGroup>
      {detectResult?.detected && <InlineHelp tone="success">检测到端口 {detectResult.detected.bestPort}，地址已写入草稿，保存后才会生效。</InlineHelp>}
      {detectResult && !detectResult.detected && <InlineHelp tone="danger">{detectResult.error || '没有检测到可用的本地 OneBot HTTP 服务。'}</InlineHelp>}
      <div className="integrations-config__actions"><span>{dirty ? '有未保存改动' : '配置已与最近一次状态同步'}</span><Button variant="primary" icon={Save} loading={connecting} disabled={!dirty && oneBot.transportConnected} onClick={connect}>保存并连接</Button></div>
    </Card>
    <Card><SectionHeader eyebrow="Optional Services" title="osu! 外部服务" description="端口与可用性直接来自后端 TCP 探针；这里不推断版本或配置来源。" /><div className="integrations-service-grid">{externalBots.map((bot) => <ServiceCard key={bot.id} icon={Cable} name={botLabels[bot.id] || bot.id} kind="Optional integration" status={bot.up ? 'available' : 'unavailable'} endpoint={`127.0.0.1:${bot.port}`} detail={bot.up ? '本地桥接端口可达。' : '当前探针无法连接该端口。'} />)}{status && externalBots.length === 0 && <p className="integrations-empty">运行时没有返回外部服务记录。</p>}</div></Card>
    <Card className="integrations-runtime"><SectionHeader eyebrow="Runtime Evidence" title="OneBot 状态明细" /><div className="integrations-runtime__grid"><div><span>Transport</span><strong>{oneBot.transportConnected ? 'Connected' : 'Disconnected'}</strong></div><div><span>API</span><strong>{oneBot.apiReachable === true ? 'Reachable' : oneBot.apiReachable === false ? 'Unavailable' : 'Probing'}</strong></div><div><span>QQ Session</span><strong>{oneBot.accountOnline === true ? 'Online' : oneBot.accountOnline === false ? 'Offline' : 'Unknown'}</strong></div><div><span>Heartbeat</span><strong>{oneBot.heartbeatFresh ? 'Fresh' : oneBot.lastHeartbeatAt ? 'Stale' : 'No data'}</strong></div><div><span>Reconnects</span><strong>{oneBot.reconnectCount ?? 0}</strong></div><div><span>Last event</span><strong title={oneBot.lastEventAt || ''}>{oneBot.lastEventAt || '暂无'}</strong></div></div></Card>
  </div>;
}
