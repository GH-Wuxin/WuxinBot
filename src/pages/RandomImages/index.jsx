import React, { useState } from 'react';
import { Image as ImageIcon, RefreshCw } from 'lucide-react';
import { usePollingResource } from '../../app/polling.js';
import { api, apiUrl } from '../../lib/api.js';
import { Button, Card, EmptyState, ErrorState, NumberInput, SectionHeader, SegmentedControl, SettingGroup, SettingRow, Switch } from '../../components/ui/index.jsx';
import { formatNumber } from '../Dashboard/usageView.js';

const modeLabels = { silent: '静默', mention: '@ 回复', light: '轻度参与', natural: '自然群友', osu: '仅 osu! 指令' };
const rateOptions = [
  { value: 'low', label: '低频' },
  { value: 'standard', label: '标准' },
];

function expectedInterval(base, step) {
  let survival = 1;
  let mean = 0;
  for (let n = 1; n <= 20000; n += 1) {
    mean += survival;
    survival *= 1 - Math.min(1, base + step * (n - 1));
    if (survival < 1e-12) break;
  }
  return Math.round(mean);
}

function shortLocalTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function shortPoolName(file) {
  const text = String(file || '');
  const base = text.endsWith('.png') ? text.slice(0, -4) : text;
  return base.startsWith('pippi-') ? base.slice(6) : base;
}

function displayGroupName(group) {
  const name = String(group?.name || '').trim();
  return name && name !== String(group?.groupId || '') ? name : `群 ${group?.groupId || ''}`;
}

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
  const [operationError, setOperationError] = useState('');
  const stats = usePollingResource(() => api('/api/random-image', { timeoutMs: 15000 }), 15000);
  const snapshot = stats.data || {};
  const statByGroup = new Map((snapshot.groups || []).map((group) => [String(group.groupId), group]));
  const recent = snapshot.recent || [];
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

  return <div className="random-image-page">
    <SectionHeader eyebrow="运行与群聊" title="随机发图" description="偶尔向已启用的群单独发送一张表情包，与文字回复模式、模型和群聊门控相互独立。" actions={<Button icon={RefreshCw} onClick={() => { refreshState(); stats.refresh(); }}>刷新</Button>} />
    {operationError && <ErrorState title="保存失败" message={operationError} />}
    {legacyRuntime && <ErrorState title="服务需要重启" message="当前 WuxinBot 还没有加载独立随机发图模块。请手动重启 WuxinBot 服务，不要重启全部组件。" />}
    <div className="random-image-page__top-grid">
      <Card>
        <SettingGroup title="模块设置" description="群里每有一条消息就掷一次骰子，命中后只发送图片，不附带文字。">
          <SettingRow title="启用模块" description="关闭后所有群都停止随机发图。" control={<Switch checked={enabled} disabled={pending === 'module'} onChange={(event) => writeSettings({ enabled: event.target.checked })} />} />
          <SettingRow title="低频" description={`基础概率；约 ${expectedInterval(lowBase, lowStep)} 条发言出一张。`} control={<NumberInput value={Number((lowBase * 100).toFixed(3))} min={0} max={100} step={0.01} suffix="%" onChange={(value) => writeSettings({ lowBase: value / 100 })} />} />
          <SettingRow title="标准" description={`基础概率；约 ${expectedInterval(standardBase, standardStep)} 条发言出一张。`} control={<NumberInput value={Number((standardBase * 100).toFixed(3))} min={0} max={100} step={0.01} suffix="%" onChange={(value) => writeSettings({ standardBase: value / 100 })} />} />
        </SettingGroup>
      </Card>
      <Card>
        <SectionHeader title="图池状态" />
        <div className="random-image-page__pool-summary">
          <div><strong>{formatNumber(snapshot.pool?.count || 0)}</strong><span>张图片</span></div>
          <div><strong>{formatNumber(snapshot.totals?.rolls || 0)}</strong><span>次掷骰</span></div>
          <div><strong>{formatNumber(snapshot.totals?.hits || 0)}</strong><span>次命中</span></div>
        </div>
        <p className="osu-muted">图池目录会自动扫描。加入或移除图片后，最多约 30 秒内生效。</p>
      </Card>
    </div>

    <Card>
      <SettingGroup title="参与群" description="每个群单独控制是否发图和发图频率；这里的设置不会改变该群的文字回复模式。">
        <div className="random-image-page__groups">
          {(db.groups || []).map((group) => {
            const groupId = String(group.groupId);
            const stat = statByGroup.get(groupId);
            const groupEnabled = group.randomImageEnabled === true;
            const rate = group.randomImageRate === 'low' ? 'low' : 'standard';
            return <div className={'random-image-page__group' + (groupEnabled ? '' : ' is-disabled')} key={groupId}>
              <div className="random-image-page__group-head">
                <div><strong>{displayGroupName(group)}</strong><small>{groupId} · 文字模式：{modeLabels[group.mode] || group.mode || '未知'}</small></div>
                <Switch checked={groupEnabled} disabled={pending === groupId || !enabled} onChange={(event) => saveGroup(group, { randomImageEnabled: event.target.checked })} label="参与随机发图" description={groupEnabled ? '已开启' : '已关闭'} />
              </div>
              <div className="random-image-page__group-controls">
                <span>发图频率</span>
                <SegmentedControl value={rate} onChange={(value) => saveGroup(group, { randomImageRate: value })} label={`${displayGroupName(group)}发图频率`} options={rateOptions} />
              </div>
              <div className="random-image-page__group-stats">
                {stat?.participates ? <><span>掷骰 {formatNumber(stat.rolls)}</span><span>命中 {formatNumber(stat.hits)}</span><span className="osu-text-mint">当前 {(stat.chance * 100).toFixed(2)}%</span><span>{stat.lastFile || '还没发过'}</span></> : <span className="osu-muted">{enabled && groupEnabled ? '等待第一条消息' : '模块或本群未开启'}</span>}
              </div>
            </div>;
          })}
          {!(db.groups || []).length && <EmptyState title="还没有配置群" description="先在“群聊”页添加一个群，再回来开启随机发图。" />}
        </div>
      </SettingGroup>
    </Card>

    <Card>
      <SettingGroup title="最近发送" description="各群流水合并，最新的在前；只保留每群最近 20 条。">
        {recent.length ? <div className="osu-random-image__recent">
          {recent.map((item) => <figure key={item.groupId + item.at + item.file}>
            <img src={apiUrl('/api/random-image/file?name=' + encodeURIComponent(item.file))} alt={item.file} loading="lazy" />
            <figcaption>{shortPoolName(item.file)}<small>{item.groupName || item.groupId} · {shortLocalTime(item.at)}</small></figcaption>
          </figure>)}
        </div> : <p className="osu-muted">{stats.loading ? '正在读取…' : '还没有发过图'}</p>}
      </SettingGroup>
    </Card>
  </div>;
}
