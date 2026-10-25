import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api.js';

// 版式对齐原型 PAGES.integrations：OneBot / 外部 bot / 联网搜索 / 回调，断了直接标红。
const botLabels = { yumu: 'Yumu / 雨沐', kanon: 'Kanon / 猫猫', hydrant: 'Hydrant / 消防栓', lazybot: 'LazyBot' };

export function IntegrationsPage({ db, oneBot, saveSettings, refreshState }) {
  const [draft, setDraft] = useState(() => ({ ...db.settings, oneBotAccessToken: '' }));
  const [dirty, setDirty] = useState(false);
  const [editing, setEditing] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [detectResult, setDetectResult] = useState(null);
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState('');
  const statusInFlight = useRef(false);

  useEffect(() => {
    if (!dirty) setDraft({ ...db.settings, oneBotAccessToken: '' });
  }, [db.settings, dirty]);

  const loadStatus = async () => {
    if (statusInFlight.current) return;
    statusInFlight.current = true;
    try { setStatus(await api('/api/osu/status', { timeoutMs: 10000 })); setStatusError(''); }
    catch (error) { setStatusError(error?.message || String(error)); }
    finally { statusInFlight.current = false; }
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
      const data = await api('/api/onebot/autodetect', { timeoutMs: 15000 });
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
      await api('/api/onebot/connect', { method: 'POST', timeoutMs: 15000 });
      await refreshState();
    } finally { setConnecting(false); }
  };

  const online = oneBot.accountOnline === false ? false : Boolean(oneBot.transportConnected && oneBot.apiReachable !== false);
  const friendlyError = oneBot.lastError?.includes('ECONNREFUSED') ? 'OneBot WebSocket 拒绝连接，请检查 NapCat 是否运行以及端口是否一致。' : oneBot.lastError || '';
  const externalBots = useMemo(() => status?.bots || [], [status]);
  const renderer = status?.renderer;

  return <>
    <div className="page-head">
      <div><h1>集成</h1><p>OneBot 和外部服务都在这一页，断了会直接标红。</p></div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn btn-ghost" disabled={detecting} onClick={autoDetect}>{detecting ? '检测中…' : '自动检测'}</button>
        <button type="button" className="btn btn-primary" disabled={connecting} onClick={connect}>{connecting ? '连接中…' : '保存并连接'}</button>
      </div>
    </div>

    {statusError && <div className="note" style={{ color: 'var(--red)', marginBottom: 12 }}>集成状态读取失败：{statusError}</div>}
    {friendlyError && <div className="note" style={{ color: 'var(--red)', marginBottom: 12 }}>{friendlyError}</div>}
    {detectResult?.detected && <div className="note" style={{ color: 'var(--mint)', marginBottom: 12 }}>检测到端口 {detectResult.detected.bestPort}，地址已写入草稿，保存后才会生效。</div>}
    {detectResult && !detectResult.detected && <div className="note" style={{ color: 'var(--red)', marginBottom: 12 }}>{detectResult.error || '没有检测到可用的本地 OneBot HTTP 服务。'}</div>}

    <div className="grid grid-2" style={{ alignItems: 'start' }}>
      <div className="stack">
        <div className="card">
          <div className="card-head">
            <span className="card-title">OneBot v11</span>
            <span className={'chip ' + (online ? 'chip--mint' : '')}>{online ? '已连接' : '未连接'}</span>
          </div>
          {editing ? <>
            <div className="field"><label>HTTP endpoint</label><input value={draft.oneBotHttpUrl || ''} onChange={(event) => update('oneBotHttpUrl', event.target.value)} placeholder="http://127.0.0.1:3000" /></div>
            <div className="field"><label>WebSocket endpoint</label><input value={draft.oneBotWsUrl || ''} onChange={(event) => update('oneBotWsUrl', event.target.value)} placeholder="ws://127.0.0.1:3001" /></div>
            <div className="field"><label>Access token</label><input type="password" value={draft.oneBotAccessToken || ''} onChange={(event) => update('oneBotAccessToken', event.target.value)} placeholder={db.settings.oneBotAccessToken === '已填写' ? '已填写，留空不改' : ''} /></div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn" style={{ flex: 1 }} onClick={() => { setEditing(false); setDraft({ ...db.settings, oneBotAccessToken: '' }); setDirty(false); }}>取消</button>
              <button type="button" className="btn btn-primary" style={{ flex: 1 }} disabled={connecting} onClick={connect}>保存并连接</button>
            </div>
          </> : <>
            <div className="kv"><span>传输</span><b>{draft.oneBotWsUrl || draft.oneBotHttpUrl || '未配置'}</b></div>
            <div className="kv"><span>上报</span><b>{draft.oneBotHttpUrl || '未配置'}</b></div>
            <div className="kv"><span>状态</span><b className={online ? 'mint' : undefined}>{online ? '已连接' : '未连接'}</b></div>
            <div className="kv"><span>账号</span><b>{draft.selfQq || '未设置'}</b></div>
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button type="button" className="btn" style={{ flex: 1 }} onClick={() => setEditing(true)}>编辑连接</button>
            </div>
          </>}
        </div>

        <div className="card">
          <div className="card-head"><span className="card-title">外部 osu! bot</span><span className="muted" style={{ fontSize: 12 }}>{externalBots.filter((bot) => bot.up).length} 在线</span></div>
          <div className="rows">
            {externalBots.map((bot) => <div className="row" key={bot.id}>
              <span className="status-dot" style={{ background: bot.up ? 'var(--mint)' : 'var(--red)' }} />
              <div className="row-main">
                <div className="row-title">{botLabels[bot.id] || bot.id}</div>
                <div className="row-sub">ws://127.0.0.1:{bot.port}</div>
              </div>
              <span className={'chip' + (bot.up ? ' chip--mint' : '')}>{bot.up ? '已连接' : '离线'}</span>
            </div>)}
            {!externalBots.length && <div className="note">运行时没有返回外部服务记录。</div>}
          </div>
        </div>

        <div className="card">
          <div className="card-head"><span className="card-title">yumu-image 渲染器</span><span className="muted" style={{ fontSize: 12 }}>可选</span></div>
          <div className="kv"><span>监听端口</span><b>{renderer?.listeningPort || '未报告'}</b></div>
          <div className="kv"><span>客户端</span><b>{renderer?.hasClients ? '已连接' : '无'}</b></div>
          <div className="note" style={{ marginTop: 8 }}>{renderer?.hasClients ? '已有经过认证的渲染客户端连接。' : renderer?.listeningPort ? '渲染服务正在监听，但当前没有渲染客户端。' : '运行时尚未报告监听端口。'}</div>
        </div>
      </div>

      <div className="stack">
        <div className="card">
          <div className="card-head"><span className="card-title">身份</span><span className="muted" style={{ fontSize: 12 }}>改完点右上角保存</span></div>
          <div className="field"><label>Bot QQ</label><input value={draft.selfQq || ''} onChange={(event) => update('selfQq', event.target.value)} /></div>
          <div className="field"><label>Owner QQ</label><input value={draft.ownerQq || ''} onChange={(event) => update('ownerQq', event.target.value)} /></div>
          <div className="field"><label>外部 Bot QQ（逗号分隔）</label><input value={draft.externalBotQqs || ''} onChange={(event) => update('externalBotQqs', event.target.value)} /></div>
        </div>

        <div className="card">
          <div className="card-head"><span className="card-title">OneBot 状态明细</span><span className="muted" style={{ fontSize: 12 }}>{dirty ? '有未保存改动' : '已同步'}</span></div>
          <div className="kv"><span>Transport</span><b>{oneBot.transportConnected ? 'Connected' : 'Disconnected'}</b></div>
          <div className="kv"><span>API</span><b>{oneBot.apiReachable === true ? 'Reachable' : oneBot.apiReachable === false ? 'Unavailable' : 'Probing'}</b></div>
          <div className="kv"><span>QQ Session</span><b>{oneBot.accountOnline === true ? 'Online' : oneBot.accountOnline === false ? 'Offline' : 'Unknown'}</b></div>
          <div className="kv"><span>Heartbeat</span><b>{oneBot.heartbeatFresh ? 'Fresh' : oneBot.lastHeartbeatAt ? 'Stale' : 'No data'}</b></div>
          <div className="kv"><span>重连次数</span><b>{oneBot.reconnectCount ?? 0}</b></div>
          <div className="kv"><span>最近事件</span><b>{oneBot.lastEventAt || '暂无'}</b></div>
        </div>
      </div>
    </div>

    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head"><span className="card-title">Webhook / 回调</span></div>
      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <div>
          <div className="kv"><span>控制台地址</span><b>http://127.0.0.1:8787</b></div>
          <div className="kv"><span>回调鉴权</span><b>{db.settings.oneBotAccessToken === '已填写' ? '已开启' : '未设置 token'}</b></div>
        </div>
        <div className="note">回调只接受来自 OneBot 的签名请求；控制台与 API 同源，避免跨域。</div>
      </div>
    </div>
  </>;
}
