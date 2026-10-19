import React, { useState } from 'react';
import { usePollingResource } from '../../app/polling.js';
import { api, apiUrl } from '../../lib/api.js';
import { RefreshButton } from '../../components/ui/RefreshButton.jsx';

// 版式对齐原型 PAGES.randomImages：数字卡 + 图池 + 发送设置 + 最近发送。
const modeLabels = { silent: '静默', mention: '@ 回复', light: '轻度参与', natural: '自然群友', osu: '仅 osu! 指令' };

const expectedInterval = (base, step) => {
  let survival = 1;
  let mean = 0;
  for (let n = 1; n <= 20000; n += 1) {
    mean += survival;
    survival *= 1 - Math.min(1, base + step * (n - 1));
    if (survival < 1e-12) break;
  }
  return Math.round(mean);
};
const displayGroupName = (group) => {
  const name = String(group?.name || '').trim();
  return name && name !== String(group?.groupId || '') ? name : `群 ${group?.groupId || ''}`;
};
const num = (value) => Number(value || 0).toLocaleString('en-US');

export function RandomImagesPage({ db, refreshState, saveSettings }) {
  const current = db.settings.randomImage || {};
  const standard = current.standard || current.natural || { base: 0.005, step: 0.0005 };
  const low = current.low || current.light || { base: 0.001, step: 0.0002 };
  const enabled = current.enabled !== false;
  const standardBase = Number(standard.base ?? 0.005);
  const lowBase = Number(low.base ?? 0.001);
  const standardStep = Number(standard.step ?? 0.0005);
  const lowStep = Number(low.step ?? 0.0002);
  const [pending, setPending] = useState('');
  const [groupQuery, setGroupQuery] = useState('');
  const [bulkPending, setBulkPending] = useState(false);
  const [operationError, setOperationError] = useState('');
  const stats = usePollingResource(() => api('/api/random-image', { timeoutMs: 15000 }), 15000);
  const snapshot = stats.data || {};
  const statByGroup = new Map((snapshot.groups || []).map((group) => [String(group.groupId), group]));
  const recent = snapshot.recent || [];
  const participating = (db.groups || []).filter((group) => group.randomImageEnabled === true);
  const allGroups = db.groups || [];
  const normalizedQuery = groupQuery.trim().toLowerCase();
  const visibleGroups = normalizedQuery
    ? allGroups.filter((group) => String(group.groupId).includes(normalizedQuery)
      || String(group.name || '').toLowerCase().includes(normalizedQuery))
    : allGroups;
  const toggleAll = async (next) => {
    setBulkPending(true);
    try {
      for (const group of visibleGroups) {
        if ((group.randomImageEnabled === true) === next) continue;
        await api('/api/groups', { method: 'POST', body: { groupId: group.groupId, randomImageEnabled: next } });
      }
      await refreshState();
    } finally {
      setBulkPending(false);
    }
  };
  // 最近发送要标群名，不是群号：优先用群配置里的名字，取不到再退回服务端返回的名字。
  const groupNames = Object.fromEntries((db.groups || []).map((group) => [String(group.groupId), String(group.name || '').trim()]));
  const groupNameOf = (item) => {
    const byConfig = groupNames[String(item?.groupId)] || '';
    if (byConfig && byConfig !== String(item?.groupId)) return byConfig;
    const fromServer = String(item?.groupName || '').trim();
    return fromServer || '未知群聊';
  };
  const legacyRuntime = (db.groups || []).some((group) => !Object.prototype.hasOwnProperty.call(group, 'randomImageEnabled'));

  const writeSettings = async (patch) => {
    setPending('module');
    setOperationError('');
    try {
      await saveSettings({
        randomImage: {
          enabled: patch.enabled ?? enabled,
          standard: { base: patch.standardBase ?? standardBase, step: standardStep },
          low: { base: patch.lowBase ?? lowBase, step: lowStep },
          recentWindow: Number(current.recentWindow ?? 8),
          recentDecay: Number(current.recentDecay ?? 0.35),
        },
      });
    } catch (error) {
      setOperationError(error?.message || String(error));
    } finally {
      setPending('');
    }
  };

  const saveGroup = async (group, patch) => {
    const groupId = String(group.groupId);
    setPending(groupId);
    setOperationError('');
    try {
      const response = await api('/api/groups', {
        method: 'POST',
        timeoutMs: 15000,
        body: {
          groupId,
          name: group.name || groupId,
          enabled: Boolean(group.enabled),
          mode: group.mode || 'mention',
          maxPerHour: Number(group.maxPerHour || 20),
          cooldownSec: Number(group.cooldownSec || 30),
          randomImageEnabled: patch.randomImageEnabled ?? group.randomImageEnabled === true,
          randomImageRate: patch.randomImageRate ?? (group.randomImageRate === 'low' ? 'low' : 'standard'),
        },
      });
      const savedGroup = response?.db?.groups?.find((item) => String(item.groupId) === groupId);
      if (!savedGroup || !Object.prototype.hasOwnProperty.call(savedGroup, 'randomImageEnabled')) {
        throw new Error('WuxinBot 服务仍在运行旧版本，请先重启 WuxinBot 后再修改随机发图。');
      }
      await refreshState();
    } catch (error) {
      setOperationError(error?.message || String(error));
    } finally {
      setPending('');
    }
  };

  return <>
    <div className="page-head">
      <div><h1>随机发图</h1><p>独立的随机表情包模块，和聊天回复互不影响。</p></div>
      <div style={{ display: 'flex', gap: 8 }}>
        <RefreshButton onClick={() => Promise.all([refreshState(), stats.refresh()])} />
      </div>
    </div>

    {operationError && <div className="note" style={{ color: 'var(--red)', marginBottom: 12 }}>{operationError}</div>}
    {legacyRuntime && <div className="note" style={{ color: 'var(--amber)', marginBottom: 12 }}>当前 WuxinBot 还没有加载独立随机发图模块。请手动重启 WuxinBot 服务，不要重启全部组件。</div>}

    <div className="grid grid-4" style={{ marginBottom: 16 }}>
      <div className="card stat"><div className="stat-label">图池</div><div className="stat-value">{num(snapshot.pool?.count)}</div><div className="stat-note">张图片 · 自动扫描</div></div>
      <div className="card stat"><div className="stat-label">掷骰</div><div className="stat-value">{num(snapshot.totals?.rolls)}</div><div className="stat-note">每有一条消息掷一次</div></div>
      <div className="card stat"><div className="stat-label">命中</div><div className="stat-value">{num(snapshot.totals?.hits)}</div><div className="stat-note">累计发出图片</div></div>
      <div className="card stat"><div className="stat-label">参与群</div><div className="stat-value">{participating.length}</div><div className="stat-note">{enabled ? '模块已开启' : '模块已关闭'}</div></div>
    </div>

    <div className="grid grid-main" style={{ alignItems: 'start' }}>
      <div className="card">
        <div className="card-head"><span className="card-title">最近发送</span><span className="muted" style={{ fontSize: 12 }}>最多 20 张 · 按发送时间倒序</span></div>
        {recent.length ? <div className="grid-tiles">
          {recent.slice(0, 20).map((item) => <figure key={item.groupId + item.at + item.file} className="tile" style={{ margin: 0, overflow: 'hidden', position: 'relative' }}>
            <img
              src={apiUrl('/api/random-image/file?name=' + encodeURIComponent(item.file))}
              alt={item.file}
              loading="lazy"
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
            <figcaption
              title={groupNameOf(item)}
              style={{
                position: 'absolute', left: 0, right: 0, bottom: 0, padding: '16px 8px 6px',
                color: '#fff', fontSize: 11, fontWeight: 600, letterSpacing: '.01em',
                background: 'linear-gradient(transparent, rgba(0, 0, 0, .78))',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}
            >{groupNameOf(item)}</figcaption>
          </figure>)}
        </div> : <div className="note">{stats.loading ? '正在读取…' : '还没有发过图。'}</div>}
      </div>

      <div className="stack">
        <div className="card">
          <div className="card-head"><span className="card-title">发送设置</span><span className={'chip' + (enabled ? ' chip--mint' : '')}>{enabled ? '已开启' : '已关闭'}</span></div>
          <div className="row">
            <div className="row-main"><div className="row-title">总开关</div><div className="row-sub">关闭后所有群都停止随机发图</div></div>
            <button type="button" className={'switch' + (enabled ? ' is-on' : '')} aria-label="随机发图总开关" disabled={pending === 'module'} onClick={() => writeSettings({ enabled: !enabled })} />
          </div>
          <div className="kv"><span>低频基准</span><b>{(lowBase * 100).toFixed(3)}% · 约 {expectedInterval(lowBase, lowStep)} 条出一张</b></div>
          <div className="kv"><span>标准基准</span><b>{(standardBase * 100).toFixed(3)}% · 约 {expectedInterval(standardBase, standardStep)} 条出一张</b></div>
          <div className="field" style={{ marginTop: 12 }}>
            <label>低频基础概率（%）</label>
            <input type="number" min="0" max="100" step="0.01" value={Number((lowBase * 100).toFixed(3))} onChange={(event) => writeSettings({ lowBase: Number(event.target.value) / 100 })} />
          </div>
          <div className="field">
            <label>标准基础概率（%）</label>
            <input type="number" min="0" max="100" step="0.01" value={Number((standardBase * 100).toFixed(3))} onChange={(event) => writeSettings({ standardBase: Number(event.target.value) / 100 })} />
          </div>
          <div className="note">群里每有一条消息就掷一次骰子，命中后只发送图片，不附带文字。</div>
        </div>

      </div>
    </div>

    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head">
        <span className="card-title">参与群</span>
        <span className="muted" style={{ fontSize: 12 }}>
          共 {allGroups.length} 群 · 已启用 {participating.length} 群 · 不影响文字回复模式
        </span>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <input
          className="input"
          style={{ flex: '1 1 220px', minWidth: 0 }}
          placeholder="按群名或群号筛选"
          value={groupQuery}
          onChange={(event) => setGroupQuery(event.target.value)}
        />
        <button type="button" className="btn btn-sm" disabled={bulkPending || !enabled || !visibleGroups.length} onClick={() => toggleAll(true)}>全部启用</button>
        <button type="button" className="btn btn-sm btn-ghost" disabled={bulkPending || !enabled || !visibleGroups.length} onClick={() => toggleAll(false)}>全部关闭</button>
      </div>
      <div className="rows" style={{ maxHeight: 420, overflowY: 'auto' }}>
        {visibleGroups.map((group) => {
          const groupId = String(group.groupId);
          const stat = statByGroup.get(groupId);
          const groupEnabled = group.randomImageEnabled === true;
          const rate = group.randomImageRate === 'low' ? 'low' : 'standard';
          return <div className="row" key={groupId}>
            <div className="row-main" style={{ minWidth: 0 }}>
              <div className="row-title" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={displayGroupName(group)}>{displayGroupName(group)}</div>
              <div className="row-sub" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {groupId} · 文字模式 {modeLabels[group.mode] || group.mode || '未知'}
                {stat?.participates ? ` · 掷骰 ${num(stat.rolls)} · 命中 ${num(stat.hits)} · 当前 ${(stat.chance * 100).toFixed(2)}%` : ''}
              </div>
            </div>
            <div className="seg" style={{ marginRight: 8, flex: '0 0 auto' }}>
              <button type="button" className={rate === 'low' ? 'is-active' : ''} disabled={pending === groupId} onClick={() => saveGroup(group, { randomImageRate: 'low' })}>低频</button>
              <button type="button" className={rate === 'standard' ? 'is-active' : ''} disabled={pending === groupId} onClick={() => saveGroup(group, { randomImageRate: 'standard' })}>标准</button>
            </div>
            <button type="button" className={'switch' + (groupEnabled ? ' is-on' : '')} aria-label={displayGroupName(group) + ' 参与随机发图'} disabled={pending === groupId || !enabled} onClick={() => saveGroup(group, { randomImageEnabled: !groupEnabled })} />
          </div>;
        })}
        {!allGroups.length && <div className="note">还没有配置群，先去「群聊」添加一个。</div>}
        {allGroups.length > 0 && !visibleGroups.length && <div className="note">没有匹配「{groupQuery}」的群。</div>}
      </div>
    </div>
  </>;
}
